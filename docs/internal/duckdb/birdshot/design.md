# Birdshot — Data Model & Control-Plane Design

Birdshot is a custom DuckDB (C++) extension implementing Quack's two hooks
(`quack_authentication_function`, `quack_authorization_function`) with real
per-role ACLs, audit logging, and instant revocation. This doc fixes the data
model, the Better Auth control plane, and the host↔extension wire format,
*before* any C++ is written.

See also: `../quack/security.md` (the hook contract) and `packages/db/src/stack.ts`
(the existing PGlite → PG-wire → DuckDB → quack stack birdshot plugs into).

## Core principle: the host pushes, birdshot never reads

Quack callbacks run on a *fresh, stateless server-side connection* and can't
hold session state. So birdshot holds everything in process memory and **never
opens a database connection of its own**. The TypeScript host loader (which
already has the PGlite handle) reads the auth store and pushes a snapshot into
birdshot via a `CALL`. Consequences:

- Tokens / grants / revocations never enter the peer-visible DuckDB catalog.
- Hot-path hooks are pure in-memory lookups — no nested SQL, no re-entrancy.
- birdshot has zero DB coupling; it's a pure verify+enforce+log engine.

## Where the data lives: a third, isolated PGlite store

`stack.ts` already runs two PGlite stores: `db` (authoritative, attached to
DuckDB READ_ONLY, peer-reachable) and `privateDb` (notebooks/views, **never
attached**, physically isolated). Birdshot's auth data is security-sensitive and
must be isolated the same way:

```
db          → attached to DuckDB, peers can read  → todos (shared/federated)
privateDb   → never attached                      → notebooks, saved_views
authDb      → never attached  (NEW)               → Better Auth + birdshot.*
```

`authDb` gets its own PGLiteSocketServer on a new `authPgPort` so Better Auth's
`pg` Pool can reach it. It is **never** `ATTACH`ed into the DuckDB session, so no
quack peer can ever see `user`, `jwks`, or any `birdshot.*` table. The loader
reads it host-side and pushes snapshots to birdshot.

(Alternative considered: a direct in-process PGlite adapter for Better Auth,
avoiding the extra PG-wire port. Reuse of the proven socket-server pattern wins
for v1; revisit if the extra port is a nuisance.)

## Schema

### Owned by Better Auth (generated via `npx auth generate`)

`user`, `account`, `session`, `verification`, and `jwks` (from the jwt plugin).
Birdshot does **not** define these; it only references `user(id)`.

### Owned by birdshot (schema `birdshot` in `authDb`)

```sql
CREATE SCHEMA IF NOT EXISTS birdshot;

-- Role definitions.
CREATE TABLE birdshot.role (
  id          TEXT PRIMARY KEY,          -- slug, e.g. 'analyst'
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User → role (M:N). user_id references Better Auth's user(id).
CREATE TABLE birdshot.user_role (
  user_id    TEXT NOT NULL,
  role_id    TEXT NOT NULL REFERENCES birdshot.role(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- Role → (table, action) grant. Default-deny: only allows are stored.
-- table_ref is a normalized, fully-qualified DuckDB name as the SERVER sees it
-- (e.g. 'local_db.public.todos' or the exposed view 'main.todos'); '*' as the
-- final segment is a schema-level wildcard (e.g. 'local_db.public.*').
-- action is coarse for v1: 'read' (SELECT) | 'write' (INSERT/UPDATE/DELETE/DDL).
CREATE TABLE birdshot.role_grant (
  role_id   TEXT NOT NULL REFERENCES birdshot.role(id) ON DELETE CASCADE,
  table_ref TEXT NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('read','write')),
  PRIMARY KEY (role_id, table_ref, action)
);

-- Durable revocation denylist (the source of truth that survives reload).
-- The instant path is the birdshot_revoke() CALL; this table is reconciled on
-- birdshot_reload(). expires_at NULL = until explicitly lifted; for a jti, set
-- it to the token's exp so the entry self-prunes.
CREATE TABLE birdshot.revocation (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user','jti','session')),
  subject_id   TEXT NOT NULL,
  reason       TEXT,
  revoked_by   TEXT,                     -- admin user id or automation id
  revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  PRIMARY KEY (subject_kind, subject_id)
);
```

Future columns (designed-for, not v1): `role_grant.effect` ('allow'|'deny') for
deny-overrides; finer `action` values ('select'|'insert'|'update'|'delete').

Audit/violation logs do **not** live here — they route through DuckDB's logging
subsystem (a `Birdshot` log type). Host-side tail-and-ingest into a durable
PGlite audit table is a later addition.

## Better Auth config (host, e.g. `apps/web/src/lib/auth.ts`)

```ts
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Pool } from "pg";

export const auth = betterAuth({
  baseURL: process.env.BASE_URL,                 // = JWT issuer & default audience
  database: new Pool({                           // → authDb over its PG-wire port
    host: "127.0.0.1",
    port: Number(process.env.AUTH_PG_PORT ?? 5433),
    database: "postgres",
  }),
  socialProviders: {                             // the OAuth part
    github: { clientId: process.env.GITHUB_ID!, clientSecret: process.env.GITHUB_SECRET! },
    // google, etc.
  },
  plugins: [
    jwt({
      jwt: {
        // Identity-only payload; roles are resolved LIVE by birdshot from the
        // pushed user_role snapshot, so revoking a grant doesn't need re-issue.
        definePayload: ({ user }) => ({ id: user.id }),
        expirationTime: "15m",                   // short TTL: small revocation window
      },
      // NOTE: exact option names to confirm at implementation time —
      //   * signing algorithm set to ES256 (ECDSA P-256), NOT the EdDSA default,
      //     so birdshot can verify with jwt-cpp + OpenSSL (DuckDB already vendors it).
      //   * ensure a `jti` claim is present (needed for per-token revocation).
    }),
  ],
});
```

Client obtains a token with `authClient.token()` → `/api/auth/token`; that JWT
is the value a peer passes as the quack `TOKEN`. JWKS is published at
`/api/auth/jwks` and fetched once by the loader (verification is offline via
`jose` `createLocalJWKSet` semantics — birdshot holds the public keys).

## Host ↔ birdshot wire format

Birdshot exposes these `CALL`s (all args are scalars / JSON strings to stay
simple across the C ABI):

| CALL | When | Effect |
| --- | --- | --- |
| `birdshot_configure(json)` | startup + on any change | Full snapshot replace: JWKS, iss/aud, roles, user_roles, grants, revocations. Idempotent. |
| `birdshot_revoke(kind, id, reason, expires_at)` | automated security response | Instant in-memory denylist add (next query from subject is denied). |
| `birdshot_unrevoke(kind, id)` | lift a revocation | Instant in-memory denylist remove. |
| `birdshot_reload()` | periodic / on-demand | Re-pull from `authDb` and rebuild the snapshot (reconciles the durable `revocation` table). |

`birdshot_configure` snapshot shape:

```json
{
  "issuer":   "http://localhost:3000",
  "audience": "http://localhost:3000",
  "jwks":     { "keys": [ /* public JWK(s) from /api/auth/jwks */ ] },
  "roles": {
    "analyst": [ { "table": "local_db.public.todos", "action": "read"  } ],
    "writer":  [ { "table": "local_db.public.todos", "action": "write" } ]
  },
  "user_roles": {
    "user_abc": ["analyst"],
    "user_xyz": ["analyst", "writer"]
  },
  "revocations": [
    { "kind": "user", "id": "user_bad", "expires_at": null }
  ]
}
```

## Enforcement path (recap)

```
birdshot_authenticate(sid, jwt, _):
    verify sig vs in-mem JWKS; check iss / aud / exp
    → cache sid → { user_id, jti, exp }

birdshot_authorize(sid, query):
    ① sid known and token not expired?          no  → deny  (decision='expired')
    ② user_id or jti in denylist?               yes → deny  (decision='revoked')   ← instant kill
    ③ parse query → (tables, action);
       every table covered by user's grants?    no  → deny  (decision='acl')
    → allow
    (every branch emits a Birdshot log entry)
```

The crux of *correctness* is step ③'s table extraction: parse the server-side
query with DuckDB's parser, normalize each base-table ref to a fully-qualified
name, and match against grants (incl. schema wildcards). This must cover
INSERT/UPDATE/DELETE/DDL, which is why this is C++ (DuckDB parser access) rather
than `json_serialize_sql`, which is SELECT-only.

## Open items to confirm at implementation

1. Better Auth jwt plugin: exact option names for signing alg (ES256) and `jti`.
2. table_ref normalization: what fully-qualified form the authorize `query` arg
   actually contains for federated peer queries (drives the grant key format).
3. C++ JWT verification lib choice (jwt-cpp vs l8w8jwt) and OpenSSL linkage in
   the extension build.

## As-built notes (implementation pass)

What shipped vs. the sketch above, and why:

- **SQL surface is scalar functions, not `CALL` table functions.** Lower
  boilerplate and no TableFunction bind/init; the host calls `SELECT birdshot_*()`.
  Config is pushed via *typed setters* (`birdshot_set_auth`, `birdshot_add_jwk`,
  `birdshot_add_role_grant`, `birdshot_add_user_role`, `birdshot_add_service_token`)
  staged then promoted by `birdshot_commit_config()`, rather than one JSON blob —
  this keeps all JSON handling in TypeScript and removes a C++ JSON dependency.
- **Verification has three modes** (`dev` | `hs256` | `rs256`), selected by
  `birdshot_set_auth`. `dev` decodes JWT claims without checking the signature
  (localhost/sandbox) and is the default so the system is testable end-to-end
  before the RS256 OpenSSL path is compile-validated. `rs256` is the production
  target (Better Auth JWKS). The verify layer is one function, so swapping in
  ES256/EdDSA later is contained.
- **Service tokens added.** The existing federation authenticates peers with a
  static quack token, not a JWT. birdshot now accepts registered service tokens
  (`birdshot_add_service_token`) *before* trying JWT, so the host registers its
  own `quackToken → 'peer'` and federation keeps working. The seeded `peer` role
  has read-only grants on `todos`, reproducing the old `peer_read_only` posture
  as a real ACL.
- **Audit goes to an in-memory ring drained by the host**, not DuckDB's log-type
  subsystem (avoids a version-sensitive internal API on the first pass).
  `birdshot_log_drain` returns base64url-wrapped TSV; the host appends to
  `birdshot.audit` in authDb. Switching to a native `Birdshot` log type remains a
  clean later option.
- **authDb is a third isolated PGlite store** with its own wire port
  (`AUTH_PG_PORT`, default 5433), never ATTACHed to DuckDB. Better Auth's `pg`
  Pool and the host loader reach it; peers cannot.
- **Graceful fallback.** If `BIRDSHOT_EXTENSION_PATH` is unset or the load fails,
  `stack.ts` keeps the legacy `peer_read_only` macro, so the stack runs unchanged
  until the native extension is built.
- **Forbidden vs. ACL'd statements.** `authorize` denies SET/RESET/ATTACH/DETACH/
  INSTALL/LOAD/CALL/COPY/EXPORT/DDL outright (a peer must never change the auth
  hooks or escape the sandbox), ACL-checks SELECT/INSERT/UPDATE/DELETE per-table,
  allows PRAGMA/transaction/zero-table statements (handshake), and fails closed on
  parse/extract errors. The exact handshake statement set is still open item #2.

Files: `birdshot/` (extension), `packages/db/src/birdshot.ts` (host loader),
`packages/db/src/{config,stack,index}.ts` (wiring), `apps/web/src/lib/auth.ts` +
`apps/web/src/app/api/auth/[...all]/route.ts` (Better Auth), and
`apps/web/src/app/api/security/route.ts` (revocation + audit / violation→response
loop).
```
