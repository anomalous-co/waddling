# pglite-sandbox Repository Reference

## Workspace Layout

Monorepo (pnpm v10.24.0) organized by role:

```
apps/web              → Next.js 16.2.9, React 19.2.4, TailwindCSS 4
packages/db           → DuckDB + Quack stack (PGlite, DuckDB node-api, birdshot control plane)
birdshot/             → DuckDB C++ extension (ACL, auth, audit)
docs/internal/        → Protocol/security specs
```

### Key Dependencies
- `@electric-sql/pglite` 0.5.2 — in-memory SQL engine (3 isolated stores: db, privateDb, authDb)
- `@electric-sql/pglite-socket` 0.2.2 — Postgres wire protocol (exposes PGlite over TCP)
- `@duckdb/node-api` 1.5.3-r.3 — DuckDB Node.js bindings
- `better-auth` 1.6.18 — OAuth/JWT control plane (RS256 keys, user/account/session/jwks schema)
- `next`, `react`, `tailwindcss` (frontend analytics UI)

**Environment Variables** (per-instance A/B):
- `INSTANCE={A,B}` — instance label
- `QUACK_PORT`, `QUACK_TOKEN` — this instance's Quack server
- `PEER_QUACK_PORT`, `PEER_QUACK_TOKEN` — peer's Quack endpoint
- `PG_PORT`, `AUTH_PG_PORT` — wire ports (PGlite/auth)
- `DATA_DIR`, `BIRDSHOT_EXTENSION_PATH` — filesystem paths

---

## Quack Protocol (Federation Backbone)

**HTTP-based remote catalog federation.** DuckDB instances peer each other's data via HTTP without copying.

### Server Side (packages/db/src/stack.ts)

```typescript
// 1. Initialize DuckDB instance in-memory
const duck = await DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' })

// 2. Install/load quack extension (DuckDB v1.5.3+)
await duck.run('INSTALL quack; LOAD quack')

// 3. Attach local PGlite read-only (authoritative data store)
await duck.run(`ATTACH 'host=127.0.0.1 port=${PG_PORT} ...' AS local_db (TYPE postgres, READ_ONLY)`)

// 4. Surface tables as views
await duck.run('CREATE OR REPLACE VIEW todos AS SELECT * FROM local_db.public.todos')

// 5. Start Quack endpoint (HTTP server on a background thread)
await duck.run(`CALL quack_serve('quack:localhost:${QUACK_PORT}', token := '${QUACK_TOKEN}')`)
```

**quack_serve(uri, token?, allow_other_hostname?)** → starts HTTP listener; default port 9494.

### Client Side (Peer Attachment)

```typescript
// Lazy ATTACH peer's quack endpoint
await duck.run(`
  ATTACH 'quack:localhost:${PEER_QUACK_PORT}'
  AS peer_db (TOKEN '${PEER_QUACK_TOKEN}', DISABLE_SSL true)
`)
// Now query federated tables: SELECT * FROM peer_db.main.todos
```

**quack_query(uri, sql, token?, disable_ssl?)** — stateless one-off query (no attachment).

### URI Format
- `quack:localhost` (default port 9494)
- `quack:host:port`
- Protocol: application/duckdb serialization (lossless complex types)
- Single round-trip per query; results stream in chunks via FETCH

---

## Quack Auth/Authz Hooks

Quack invokes two functions per-request:

| Hook | Arity | When | Contract |
|------|-------|------|----------|
| `quack_authentication_function` | (VARCHAR sid, VARCHAR client_token, VARCHAR server_token) → BOOLEAN | Connection REQUEST | Returns true → admit; false/error → deny |
| `quack_authorization_function` | (VARCHAR sid, VARCHAR query) → BOOLEAN | Before each PREPARE | Per-table/function-level ACL enforcement |

Both run on **fresh, stateless server-side connections** (no session state; `sid` passed per-call for binding). Default: permissive token check + "true" for authz. Override via `SET GLOBAL quack_authentication_function = '<macro/fn>'`.

---

## Birdshot (DuckDB C++ Extension)

Per-role table ACL, JWT/service-token auth, instant revocation, audit logging. Owns quack's auth/authz hooks when loaded.

### Architecture

**Host pushes, birdshot never reads:**
- Three isolated PGlite stores: `db` (federated), `privateDb` (notebooks), `authDb` (auth only)
- `authDb` **never ATTACH**ed into DuckDB; host reads it, pushes snapshots via `birdshot_*` functions
- In-memory state: session cache, policy snapshot, revocation denylist, audit ring (10k entries)
- Hooks are pure lookups (no nested SQL, no re-entrancy)

### SQL Functions (Control Plane)

**Authentication & Config:**
- `birdshot_authenticate(sid, token, server_token) → BOOL` — Quack auth hook. Service token or JWT → caches `sid → Identity`.
- `birdshot_reset_config()`, `birdshot_commit_config()` — Stage then atomically promote policy snapshot.
- `birdshot_set_auth(issuer, audience, mode: 'dev'|'hs256'|'rs256')`
- `birdshot_set_secret(secret)` — HS256 symmetric key.
- `birdshot_add_jwk(kid, n, e)` — RS256 RSA public key (base64url modulus/exponent).

**Policy & Identity:**
- `birdshot_add_role_grant(role, table_ref, action: 'read'|'write')` — `table_ref` = 'schema.table' or 'schema.*' or '*' (default-deny).
- `birdshot_add_user_role(user_id, role)` — Better Auth user ID → role.
- `birdshot_add_service_token(token, user_id)` — Static federation token → identity (quack peers).

**Authorization & Audit:**
- `birdshot_authorize(sid, query) → BOOL` — Quack authz hook. Table+function+pragma denylist, statement analysis, per-role ACL.
- `birdshot_revoke(kind: 'user'|'jti'|'session', id, reason, expires_us: i64) → VARCHAR` — Instant denylist add.
- `birdshot_unrevoke(kind, id)`
- `birdshot_log_drain(max_rows) → VARCHAR` — TSV audit records; fields base64url-encoded.
- `birdshot_status() → VARCHAR` — Snapshot counts (auth mode, policy size, session count, audit ring depth).

### authDb Schema

```sql
-- Better Auth tables (auto-generated): user, account, session, verification, jwks

-- birdshot.role: Role definitions
CREATE TABLE birdshot.role (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- birdshot.user_role: User → role (M:N)
CREATE TABLE birdshot.user_role (
  user_id    TEXT NOT NULL,
  role_id    TEXT NOT NULL REFERENCES birdshot.role(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- birdshot.role_grant: Role → (table, action) grants (default-deny allow-list)
CREATE TABLE birdshot.role_grant (
  role_id   TEXT NOT NULL,
  table_ref TEXT NOT NULL,  -- 'schema.table', 'schema.*', '*'
  action    TEXT NOT NULL CHECK (action IN ('read','write')),
  PRIMARY KEY (role_id, table_ref, action)
);

-- birdshot.revocation: Durable denylist (survives reload)
CREATE TABLE birdshot.revocation (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user','jti','session')),
  subject_id   TEXT NOT NULL,
  reason       TEXT,
  revoked_by   TEXT,
  revoked_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ,  -- NULL = forever; auto-prune when expired
  PRIMARY KEY (subject_kind, subject_id)
);

-- birdshot.audit: Durable audit sink (optional; host drains in-memory ring here)
CREATE TABLE birdshot.audit (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL,
  event     TEXT NOT NULL,
  sid       TEXT,
  user_id   TEXT,
  decision  TEXT NOT NULL,
  reason    TEXT,
  query     TEXT
);
```

### Host Control Plane (packages/db/src/birdshot.ts)

```typescript
// Bootstrap authDb schema + default roles (peer, member, owner)
await bootstrapAuthSchema(authDb, instanceLabel)

// LOAD the compiled extension (returns false if not built)
const active = await loadBirdshotExtension(duck, config)

// Read authDb, push snapshot into extension
await pushSnapshot(duck, authDb, config)  // calls birdshot_set_auth, birdshot_add_jwk, grant/user/token funcs, commit

// Instant revocation (durable + in-memory)
await revoke(duck, authDb, 'user', userId, 'reason', expiresMs?)

// Drain audit
const records = await drainAudit(duck, authDb, maxRows)
```

### Initialization in Stack

```typescript
// Roles (example from bootstrapAuthSchema):
INSERT INTO birdshot.role VALUES
  ('peer',   'Federation peer',                '...'),
  ('member', 'Authenticated local user',       '...'),
  ('owner',  'Full read/write',               '...')

// Role → Table Grants:
INSERT INTO birdshot.role_grant VALUES
  ('peer',   'main.todos',     'read'),           -- peers read only todos
  ('member', 'main.todos',     'read'),           -- members read todos + PII
  ('member', 'main.contacts',  'read'),
  ('owner',  'main.todos',     'read'),           -- owners full access
  ('owner',  'main.todos',     'write'),
  ('owner',  'main.contacts',  'read'),
  ('owner',  'main.contacts',  'write')

// User → Role:
INSERT INTO birdshot.user_role VALUES
  ('peer', 'peer'),                             -- quack federation token user
  (${localUserId}, 'member')                    -- this instance's local user

// Service tokens:
await duck.run(`SELECT birdshot_add_service_token('${QUACK_TOKEN}', 'peer')`)
```

### Better Auth Integration (apps/web/src/lib/auth.ts)

```typescript
export const auth = betterAuth({
  baseURL: 'http://localhost:3000',  // issuer & default audience
  secret: process.env.BETTER_AUTH_SECRET,
  database: new Pool({ host: '127.0.0.1', port: AUTH_PG_PORT }),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({
      keyPairConfig: { alg: 'RS256', modulusLength: 2048 },  // RS256 for birdshot RS256 mode
      jwt: {
        definePayload: ({ user }) => ({ id: user.id }),  // identity-only; roles fetched live
        expirationTime: '15m'
      }
    })
  ]
})
```

User obtains quack token: `authClient.token()` → calls `/api/auth/token` → returns JWT(id=user.id).

---

## Known Security Gaps (Audit: 2026-06-12)

**Ship-blockers (FIXED in v1):**
- Function allow-list now denies `birdshot_*`, `read_*`, `query/*`, `glob`, `sniff_csv`, `parquet_scan`, `getvariable`
- Table functions deny-by-default (whitelist only `duckdb_*`/`pragma_*` for quack's ATTACH handshake)
- EXPLAIN ANALYZE now descends into child statement

**Still open (documented, lower priority):**
1. **Extension autoload-RCE** — `allow_unsigned_extensions=true` global; autoload fires at BIND (post-authorize). Fix needs per-connection scoping or full authorize ALLOWLIST.
2. **Function guard is denylist** — covers scalars, window funcs, casts; not exhaustive (class-level incomplete).
3. **View/macro confused-deputy** — birdshot parses at PARSE time, can't see through SQL views/macros (tables referenced inside views bypass ACL check).
4. **DEV auth mode default** — fail-open JWT verification; prod deployments must set `BIRDSHOT_AUTH_MODE=rs256`.
5. **Metadata introspection leaks** — `duckdb_columns()`/`duckdb_tables()`/`pragma_table_info()` expose catalog structure of ungranted tables (not data, but violates isolation goal).
6. **Session DoS fixed**: FIFO eviction now (was clear-all); still grows unbounded (birdshot can't observe disconnects, 50k cap).
7. **aud substring match** — JWT audience claim checked as substring, not exact match.
8. **RefMatch bidirectional suffix** — qualified names matched by suffix both ways (e.g., 'public.x' matches 'x' and vice versa).

See `/docs/internal/duckdb/birdshot/design.md` and memory file `birdshot-audit.md` for full details.

---

## Data Model

### Instance A/B Setup (Seeded in stack.ts)

| Table | Visibility | Via Birdshot | Notes |
|-------|------------|--------------|-------|
| `todos` | Federated, quack-attached | Role-gated (peers: RO) | Shared/collaboration data |
| `contacts`, `addresses`, `memories` | In catalog (views), never granted to peers | Member/owner only | PII; peers reference but denied |
| Notebooks, saved_views | `privateDb` — never ATTACH'd | N/A | Local UI state, physically isolated |
| Birdshot role/grant/revocation/audit | `authDb` — never ATTACH'd | N/A | Auth policy, never visible to peers |

### Query Flows

**Local (Instance A) user:**
1. Sign in via Better Auth (email/OAuth) → JWT minted (`id=user.id`)
2. Call `/api/query` with JWT → stack validates, executes on local DuckDB, returns result
3. Revoke: `revoke(duck, authDb, 'user', userId)` → in-memory denylist + durable row

**Peer (Instance B) federation:**
1. Instance A ATTACH's B's quack: `ATTACH 'quack:localhost:9495' AS peer_db (TOKEN '...')`
2. Peer query: `SELECT * FROM peer_db.main.todos`
3. Quack forwards to B; B's `birdshot_authenticate(sid, token, server_token)` checks federation token → `sid → {user: 'peer', roles: ['peer']}`
4. `birdshot_authorize(sid, 'SELECT * FROM main.todos')` → parses, finds table_ref='main.todos', checks grants (peer role has 'read') → allow
5. `SELECT * FROM main.contacts` same query → table_ref='main.contacts', peer role has NO grant → deny ("Authorization failed")

---

## Deployment & Build

**Dev (local 2-instance):**
```bash
pnpm dev:a     # port 3000, quack 9494
pnpm dev:b     # port 3001, quack 9495
```

**Birdshot Extension Build:**
```bash
cd birdshot
./setup-build.sh  # compiles DuckDB + extension (slow, first time)
make test         # 36 assertions
export BIRDSHOT_EXTENSION_PATH="$(pwd)/build/release/extension/birdshot/birdshot.duckdb_extension"
pnpm dev:a        # wired into env
```

**Fallback (no extension):**
If birdshot unloadable, legacy `peer_read_only` macro denies mutating statements (INSERT/UPDATE/DELETE/CREATE/DDL) to preserve federation sanity.

---

## API Routes (apps/web/src/app/api)

- `/auth/*` — Better Auth routes (sign-in, token, JWKS)
- `/query` — Execute SQL on local DuckDB, enforce roles via birdshot
- `/audit` — Drain birdshot audit ring
- `/revoke` — Instant revocation (durable + in-memory)

All authenticated via JWT (birdshot_authenticate hook for quack; `authClient.token()` for REST).

---

## Debugging

**Birdshot status:** `SELECT birdshot_status()`  
**Audit ring:** `SELECT birdshot_log_drain(1000)` (TSV, base64url-encoded reason/query)  
**Session count:** included in status  
**Revocation check:** revoke user → next query on that user's sid → "Authorization failed"  
**Federation health:** `SELECT * FROM peer_db.main.todos` → confirms peer ATTACH, quack proto, birdshot authz
