# waddling — System Architecture (Single Source of Truth)

> **Product:** Dynamic ACLs for AI agents accessing analytics databases over MCP. Orgs connect their lakehouses (DuckLake on R2/S3) to **waddling-managed DuckDB gateway endpoints**. Agents steer their *own* DuckDB instances to `ATTACH` to those endpoints over the **quack** wire protocol; **birdshot** (a DuckDB C++ extension) enforces per-agent ACLs at the gateway. waddling is the control plane: provisioning, dynamic per-agent ACLs, auditing, monitoring, billing.
>
> **This document is authoritative.** Implementation agents read ONLY this file plus the five context files in `waddling-context/` (`ducklake.md`, `extension-distribution.md`, `fumadocs.md`, `better-auth.md`, `repo.md`). Do not re-fetch docs. Every name, port, version, and price below is a decision, not a suggestion.

**Pinned versions** (match existing workspace; see `repo.md`):
- Node `>=20` · pnpm `10.24.0` · Next.js `16.2.9` · React `19.2.4` · TailwindCSS `4`
- `better-auth` `1.6.18` · `@better-auth/stripe` (beta) · `@better-auth/api-key` · `pg` `8.21.0` · `stripe` `17`
- `@duckdb/node-api` `1.5.3-r.3` · DuckDB engine `v1.5.3` (extension repo path `v1.5.3`)
- `@modelcontextprotocol/sdk` `1.x` · `fumadocs-mdx` / `fumadocs-core` / `fumadocs-ui` (latest) · `zod` `3`
- Postgres `16` · MinIO (R2 stand-in) latest · Docker Compose v2

**Workspace placement:** new Next.js app at `apps/waddling`; new packages under `packages/*`. The existing `apps/web` and `packages/db` are **untouched** — they remain the birdshot/quack reference demo. waddling reuses the *concepts* and the *compiled birdshot extension binary*, not those source files.

---

## 1. System Overview

waddling has three planes:

- **Control plane** — Next.js app (`apps/waddling`): Better Auth (orgs, API keys, admin), Stripe billing, Postgres for all metadata + the DuckLake catalog, dashboard UI, docs/blog, and the REST API that both MCP servers call. Owns the **policy compiler** that turns dynamic ACL rules into birdshot grants + scoped credentials.
- **Data plane** — per-org **DuckDB gateway** processes (`packages/gateway`) running `quack_serve` with the **birdshot** extension loaded. Each gateway ATTACHes the org's DuckLake (Postgres catalog + R2 data) and surfaces governed tables. Agents ATTACH the gateway's `quack:` endpoint.
- **Agent plane** — the customer's own DuckDB instance, driven by an LLM agent through the **External MCP server**. The agent never gets raw lake credentials; it gets a short-lived **session JWT** + an `ATTACH 'quack:...'` instruction.

```
                              ┌────────────────────────────────────────────────────────────────┐
                              │                     CONTROL PLANE  (apps/waddling)               │
                              │                                                                  │
  ┌───────────────┐  HTTPS    │  ┌────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
  │ Org Admin     │──────────▶│  │ Next.js UI │   │ Better Auth  │   │  Control-plane REST    │  │
  │ (browser)     │  dashboard│  │ dashboard  │──▶│ orgs/apikey/ │◀──│  /api/cp/*  (W1 owns)  │  │
  └───────────────┘           │  │  (W2)      │   │ admin/stripe │   │  endpoints/acl/audit/  │  │
                              │  └────────────┘   │   (W1)       │   │  usage/sessions        │  │
                              │                   └──────┬───────┘   └───────────┬────────────┘  │
                              │                          │                       │               │
                              │                   ┌──────▼───────────────────────▼────────────┐  │
                              │                   │  Postgres 16  (control plane + DuckLake    │  │
                              │                   │  catalog)  — schema §2                     │  │
                              │                   └──────┬───────────────────────┬────────────┘  │
                              └──────────────────────────┼───────────────────────┼───────────────┘
                                   ▲                      │ policy compiler       │ catalog
                                   │ HTTP (Bearer         │ pushes birdshot_*     │ (DuckLake
                                   │  API key / session)  │ snapshot              │  metadata)
            ┌──────────────────────┴────┐                 ▼                       │
            │  EXTERNAL MCP server       │        ┌────────────────────────────┐  │
            │  packages/mcp-external (W3)│───────▶│   DuckDB GATEWAY (per org) │  │
   ┌────────┴──────────┐  data-plane     │  REST  │   packages/gateway (W3)    │  │
   │  LLM AGENT         │  tools          │  /api/ │   quack_serve + birdshot   │  │
   │  + own DuckDB ─────┼──ATTACH quack:──┼──cp/*  │   LOADed                   │  │
   └───────────────────┘  (session JWT)   │        │   ATTACH ducklake:postgres │──┘
                                          │        │     DATA_PATH s3://R2/...  │
            ┌──────────────────────┐      │        └─────────────┬──────────────┘
            │  ADMIN AGENT          │      │                      │ reads/writes Parquet
            │  (admin's own agent) ─┼──────┘                      ▼
            └───────┬──────────────┘            ┌────────────────────────────────┐
                    │ INTERNAL MCP server        │  Cloudflare R2  (object store) │
                    │ packages/mcp-internal (W4) │  - lake data (DuckLake Parquet)│
                    │ manage/monitor agents      │  - waddling ext repo (one-line │
                    └────────────────────────────┘    INSTALL birdshot FROM ...)  │
                                                  └────────────────────────────────┘
```

**Data flow (governed query, happy path):**
1. Agent calls External MCP `waddling.connect` with `Authorization: Bearer sk_agent_…` (org API key).
2. MCP server → control-plane REST `POST /api/cp/sessions` → Better Auth verifies the key, resolves `{org, agent}`, the **policy compiler** evaluates active `acl_rule` rows, ensures the org's gateway is running, pushes a fresh birdshot snapshot for this agent's principal, mints a **session JWT** (RS256, short `exp`), and returns `{ attach_sql, session_jwt, endpoint, ttl, allowed }`.
3. MCP returns quack connection SQL to the agent: `CREATE SECRET (TYPE quack, TOKEN '<session_jwt>', SCOPE 'quack:host:port'); ATTACH 'quack:host:port' AS lake (disable_ssl true);`
4. Agent runs `waddling.query` → MCP forwards SQL to the gateway over quack (one round-trip). Gateway's `birdshot_authenticate(sid, jwt, server_token)` binds the principal; `birdshot_authorize(sid, sql)` table-gates it; **the MCP gateway layer has already constrained column/row/time before the SQL leaves the agent plane** (see §3).
5. Gateway streams results; MCP server records a `usage_event` + `audit_event` via REST, returns rows to the agent.
6. Admin watches it all live through the Internal MCP server / dashboard; can `revoke` an agent instantly (`birdshot_revoke` → in-memory denylist, next query denied).

---

## 2. Postgres Schema — Control Plane

**One Postgres 16 instance, two logical concerns, three schemas:**
- `auth` schema — **Better Auth owns these tables** (auto-generated by `getMigrations`). We never hand-write them.
- `waddling` schema — **our custom control-plane tables** (this section).
- `ducklake_catalog` schema (or a separate database `ducklake`) — **DuckLake owns these** (auto-created by `ATTACH 'ducklake:postgres:…'`). We never hand-write them.

### 2a. Provided by Better Auth (do NOT create by hand)
| Table | Plugin | Gives us |
|-------|--------|----------|
| `user` | core | platform users (humans) |
| `session` | core | **browser** sessions (NOT agent sessions — see naming note) |
| `account`, `verification` | core | credentials, email verify |
| `jwks` | `jwt` | RS256 keypair; published at `/api/auth/jwks` for gateway JWT verification |
| `organization`, `member`, `invitation` | `organization` | tenants + human membership/roles (`owner`/`admin`/`member`) |
| `apikey` | `@better-auth/api-key` | org-bound agent API keys (`sk_agent_…`), rate limits, metadata |
| `subscription`, `stripeCustomer` | `@better-auth/stripe` | plan + Stripe customer/subscription id, bound to `organization` (`referenceId`) |

> **Naming collision resolved (per advisor):** Better Auth's `session` = human browser sessions. Our agent/query session table is named **`agent_session`** — never `session`. Likewise our agents are **`agent`** (machine principals), distinct from Better Auth `user` (humans).

### 2b. Custom `waddling` schema (W0 owns the DDL file)

```sql
CREATE SCHEMA IF NOT EXISTS waddling;

-- ── Lakehouse endpoints (one per org's DuckLake; an org may have several) ──
CREATE TABLE waddling.endpoint (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,                       -- → auth.organization.id
  name            TEXT NOT NULL,                        -- 'prod-lake', 'analytics'
  slug            TEXT NOT NULL,                        -- url-safe; unique per org
  status          TEXT NOT NULL DEFAULT 'provisioning'  -- provisioning|running|stopped|error
                    CHECK (status IN ('provisioning','running','stopped','error')),
  -- DuckLake binding
  catalog_dsn     TEXT NOT NULL,        -- postgres DSN for the DuckLake metadata catalog
  data_path       TEXT NOT NULL,        -- 's3://org-<id>/lake/'  (R2)
  region          TEXT NOT NULL DEFAULT 'auto',
  encrypted       BOOLEAN NOT NULL DEFAULT true,
  -- gateway runtime
  gateway_host    TEXT,                 -- 'gw-<slug>.getwaddling.com'
  quack_port      INTEGER,              -- assigned from 9500-9999 pool
  server_token    TEXT NOT NULL,        -- birdshot server_token for this gateway (secret)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

-- ── Agents: machine principals that hold API keys & receive ACL grants ──
CREATE TABLE waddling.agent (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,                         -- 'llm-analyst', 'nightly-etl'
  description     TEXT,
  api_key_id      TEXT,                                  -- → auth.apikey.id (1:1 primary key)
  default_role    TEXT NOT NULL DEFAULT 'reader',        -- birdshot role name
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','revoked')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  UNIQUE (org_id, name)
);

-- ── ACL rules (the dynamic policy; compiled into birdshot + gateway constraints) ──
CREATE TABLE waddling.acl_rule (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL REFERENCES waddling.endpoint(id) ON DELETE CASCADE,
  agent_id        TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE, -- NULL = org-wide
  -- resource selector (catalog.schema.table.column)
  schema_name     TEXT NOT NULL DEFAULT '*',             -- '*', 'sales', ...
  table_name      TEXT NOT NULL DEFAULT '*',             -- '*', 'orders', ...
  columns         TEXT[] ,                                -- NULL = all columns; else allow-list
  -- verb
  verb            TEXT NOT NULL CHECK (verb IN ('read','write')),
  effect          TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  -- dynamic dimensions (enforced at the layer noted in §3)
  row_limit       INTEGER,                                -- gateway caps result rows (NULL=∞)
  ttl_seconds     INTEGER,                                -- rule auto-expires; → birdshot expires_at
  window_start    TIME,                                   -- time-of-day window (UTC) open
  window_end      TIME,                                   -- time-of-day window (UTC) close
  not_before      TIMESTAMPTZ,                            -- absolute activation
  expires_at      TIMESTAMPTZ,                            -- absolute expiry (also from ttl_seconds)
  priority        INTEGER NOT NULL DEFAULT 100,           -- deny>allow on tie; lower = stronger
  created_by      TEXT NOT NULL,                          -- auth.user.id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON waddling.acl_rule (endpoint_id, agent_id) WHERE expires_at IS NULL OR expires_at > now();

-- ── Agent sessions (live ATTACH sessions; NOT Better Auth session) ──
CREATE TABLE waddling.agent_session (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  agent_id        TEXT NOT NULL REFERENCES waddling.agent(id) ON DELETE CASCADE,
  endpoint_id     TEXT NOT NULL REFERENCES waddling.endpoint(id) ON DELETE CASCADE,
  sid             TEXT NOT NULL,                          -- birdshot session id (quack sid)
  jwt_jti         TEXT NOT NULL,                          -- session JWT id (revocation handle)
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','revoked','killed')),
  granted_roles   TEXT[] NOT NULL,
  ip              INET,
  user_agent      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,                   -- = JWT exp
  ended_at        TIMESTAMPTZ
);
CREATE INDEX ON waddling.agent_session (org_id, status);

-- ── Audit (durable; mirrors birdshot's drained ring + control-plane events) ──
CREATE TABLE waddling.audit_event (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL,        -- 'gateway'|'control-plane'|'mcp-external'|'mcp-internal'
  event           TEXT NOT NULL,        -- 'auth'|'authorize'|'query'|'grant'|'revoke'|'kill'|'attach'
  agent_id        TEXT,
  session_id      TEXT,                 -- → agent_session.id
  endpoint_id     TEXT,
  decision        TEXT,                 -- 'allow'|'deny'|NULL
  reason          TEXT,
  query           TEXT,                 -- redacted/truncated SQL
  actor           TEXT                  -- who triggered admin events (user/agent id)
);
CREATE INDEX ON waddling.audit_event (org_id, ts DESC);

-- ── Usage (metering for billing + dashboard) ──
CREATE TABLE waddling.usage_event (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id        TEXT,
  endpoint_id     TEXT,
  kind            TEXT NOT NULL,        -- 'query'|'rows_scanned'|'bytes_scanned'|'session'
  quantity        BIGINT NOT NULL DEFAULT 1,
  duration_ms     INTEGER
);
CREATE INDEX ON waddling.usage_event (org_id, ts DESC);
-- Rollups for billing read this; W1 computes monthly aggregates from it.
```

**FK note:** Cross-schema FKs to Better Auth tables (`org_id → auth.organization.id`, `api_key_id → auth.apikey.id`) are **declared as plain `TEXT` columns, not enforced FKs**, because Better Auth runs its own migrations and we must not couple our DDL to its table creation order. Referential integrity is enforced in application code (W1 lib).

---

## 3. ACL Model — Principals, Resources, Verbs, Dynamic Rules, and Compile-Down

This is the heart of the product. **Critical design decision (per security audit in `repo.md` + memory `birdshot-audit.md`): birdshot enforces only table-level read/write + instant revocation. It does NOT do columns, row limits, or time windows, and view-based column ACL is BYPASSABLE (view/macro confused-deputy + metadata-introspection leaks).** Therefore waddling uses **layered enforcement**: each dynamic dimension is enforced at the layer that can actually defend it.

### 3a. Principals
- **Agent** (`waddling.agent`) — the unit of policy. Identified to the gateway by the **session JWT** (`id` claim = `agent:<agent_id>`), mapped to one or more **birdshot roles** via `birdshot_add_user_role`.
- **birdshot role** — a named bundle of `(table_ref, action)` grants. waddling compiles each agent's effective table-level policy into a **synthetic per-agent role** named `agent_<agent_id>` so revocation and grants are isolated. (Static fallback roles `reader`/`writer` exist for the audit-only free tier.)

### 3b. Resources (hierarchy)
`catalog → schema → table → column`. ACL rules select a resource by `schema_name` + `table_name` (`*` wildcards) and optionally `columns[]`. The catalog is implied by the endpoint (one DuckLake per endpoint).

### 3c. Verbs
`read` (SELECT), `write` (INSERT/UPDATE/DELETE/ALTER/CREATE). Mapped 1:1 to birdshot actions `'read'`/`'write'`. Each `acl_rule` has an `effect` (`allow`/`deny`); deny wins on tie (lower `priority` stronger).

### 3d. Dynamic dimensions → enforcement layer (the load-bearing table)

| Dimension | Where enforced | Mechanism |
|-----------|----------------|-----------|
| **table read/write** | **birdshot** (gateway, in-process) | compiler emits `birdshot_add_role_grant('agent_<id>', 'schema.table', 'read'/'write')`; default-deny |
| **instant revoke** | **birdshot** | `birdshot_revoke('user', 'agent:<id>', reason, expires_us)` → in-memory denylist, next query denied |
| **TTL (rule expiry)** | **birdshot + control plane** | `ttl_seconds`/`expires_at` → birdshot `revocation.expires_at`; compiler re-pushes snapshot on expiry sweep |
| **session lifetime** | **session JWT `exp`** | short-lived RS256 token (default **15m**, max **1h**); gateway re-verifies via JWKS each connection |
| **column projection** | **MCP gateway layer** (`packages/gateway` query proxy) — **NOT views** | proxy parses the agent's SELECT, rejects/strips columns not in `columns[]`; if `SELECT *`, rewrites to the allow-listed projection before forwarding to DuckDB |
| **row limit** | **MCP gateway layer** | proxy injects/clamps `LIMIT` ≤ `row_limit` and enforces a hard fetch cap on the result stream |
| **time-of-day window** | **control plane (session mint) + gateway** | session is only minted when `now()` ∈ `[window_start, window_end]` and ∈ `[not_before, expires_at]`; gateway rejects expired-window sessions on next query |

> **Why not DuckDB views for columns/rows?** The birdshot audit (gaps #3 view/macro confused-deputy, #5 metadata-introspection leaks) proves view-based ACL is bypassable — an agent can reference the base table inside its own view/macro or introspect `duckdb_columns()`. The **gateway query proxy constructs the constrained query itself** (parse → validate → rewrite → forward), which is the only defensible path. birdshot remains the table-level backstop: even if the proxy is bypassed, an ungranted table is still denied.

### 3e. The Policy Compiler (control-plane, W1 owns `lib/policy-compiler.ts`)

Input: all active `acl_rule` rows for `(endpoint, agent)` where `not_before ≤ now() < expires_at` and (if windowed) `now()` in window.
Output, applied to the org's gateway in one atomic snapshot:

```
birdshot_reset_config()
birdshot_set_auth(issuer='https://app.getwaddling.com', audience='gw:<endpoint_id>', mode='rs256')
birdshot_add_jwk(kid, n, e)                              -- from /api/auth/jwks
-- for each agent with active rules:
birdshot_add_user_role('agent:<agent_id>', 'agent_<agent_id>')
-- for each allow rule (deny rules omit the grant => default-deny handles it):
birdshot_add_role_grant('agent_<agent_id>', '<schema>.<table>', '<read|write>')
birdshot_commit_config()
```

Column/row/window constraints are **not** sent to birdshot — they are loaded into the **gateway proxy's in-memory constraint table** keyed by `(agent_id, schema, table)` via the gateway's own control channel (`POST /gw/constraints`, internal). Revocation: `birdshot_revoke('user','agent:<id>',…)` is called directly on `revoke`, independent of the compiler.

**Token model summary:** org API key (`sk_agent_…`, long-lived, Better Auth) → exchanged at `connect` for a **session JWT** (RS256, `id=agent:<id>`, `aud=gw:<endpoint>`, 15m) → presented to gateway as the quack `TOKEN`. birdshot verifies the JWT signature (JWKS) + checks denylist; never sees the raw API key.

---

## 4. MCP Tool Surfaces

Both servers are standalone Node packages using `@modelcontextprotocol/sdk`, shipped over **stdio** (npx) and **streamable HTTP**. They are thin clients of the control-plane REST API; they hold no DB credentials. Auth: `WADDLING_API_KEY` env (external) / admin session (internal).

### 4a. External MCP (`packages/mcp-external`) — data plane, for the org's analytics agents

| Tool | Params | Description |
|------|--------|-------------|
| `waddling_list_endpoints` | `{}` | List analytics endpoints this API key can access: `[{id,name,slug,status,schemas}]`. First call an agent makes. |
| `waddling_describe` | `{ endpoint_id, schema?, table? }` | Catalog discovery **scoped to what this agent may see** (gateway filters to granted tables/columns — no leak of ungranted schema). Returns tables, columns, types, row estimates. |
| `waddling_connect` | `{ endpoint_id }` | Open a session. Returns `{ session_id, attach_sql, session_jwt, endpoint, ttl_seconds, granted: {tables, verbs, row_limit?} }`. `attach_sql` is literal SQL to run in your DuckDB: `CREATE SECRET` + `ATTACH`. Query via `lake.query('FROM lake.sales.orders …')` because the catalog alias shadows the server's default catalog. |
| `waddling_query` | `{ session_id, sql }` | Run a governed read/write through the gateway. Returns `{ columns, rows, row_count, truncated, snapshot_version }`. Denials return a structured `{ error: 'authorization_denied', table, reason }` so the agent can self-correct. |
| `waddling_explain` | `{ session_id, sql }` | Dry-run: returns the access decision + would-be row estimate **without executing or auditing as a query** — lets agents check permission before acting. |
| `waddling_time_travel` | `{ session_id, table, at_version? , at_timestamp? }` | DuckLake snapshot read (`AT (VERSION=>…)` / `AT (TIMESTAMP=>…)`). |
| `waddling_whoami` | `{ session_id? }` | Returns the agent's identity, org, active grants, remaining TTL, and rate-limit headroom. Great DevEx: agents orient themselves. |
| `waddling_install_extension` | `{}` | Returns the one-liner: `INSTALL birdshot FROM 'https://ext.getwaddling.com'; LOAD birdshot;` plus the agent's platform-matched note. (For agents that run a *local* governed DuckDB.) |

**DevEx principles:** every error is structured + actionable; `connect` returns ready-to-paste SQL; `whoami`/`explain` let agents reason about permissions without trial-and-error denials; tool names are verb-first and namespaced.

### 4b. Internal MCP (`packages/mcp-internal`) — admin plane, for admins' own ops agents

| Tool | Params | Description |
|------|--------|-------------|
| `waddling_admin_list_agents` | `{ org_id?, status? }` | All agents + last-seen, default role, key status. |
| `waddling_admin_list_sessions` | `{ org_id?, agent_id?, status? }` | Live + recent sessions: `sid`, endpoint, grants, started/expires. |
| `waddling_admin_grant` | `{ endpoint_id, agent_id, schema, table, columns?, verb, row_limit?, ttl_seconds?, window?, effect? }` | Create an `acl_rule`; triggers policy recompile + snapshot push. Returns the new rule + compiled birdshot grants. |
| `waddling_admin_revoke_rule` | `{ rule_id }` | Delete a rule; recompile. |
| `waddling_admin_revoke_agent` | `{ agent_id, reason, expires_seconds? }` | **Instant** kill — `birdshot_revoke` across all the agent's live sessions; next query denied. |
| `waddling_admin_kill_session` | `{ session_id, reason }` | Revoke one session's JWT (`jti` denylist) + mark `killed`. |
| `waddling_admin_audit` | `{ org_id?, agent_id?, since?, decision?, limit? }` | Query `audit_event` (drained from birdshot + control plane). |
| `waddling_admin_usage` | `{ org_id?, agent_id?, period? }` | Usage rollups: queries, rows/bytes scanned, active sessions, $ estimate vs plan. |
| `waddling_admin_endpoint_status` | `{ endpoint_id? }` | Gateway health: `birdshot_status()` (auth mode, policy size, session count, audit depth) + DuckLake snapshot lag. |
| `waddling_admin_provision_endpoint` | `{ org_id, name, data_path?, region? }` | Spin up a new endpoint (enterprise). Returns provisioning status. |

---

## 5. Next.js App (`apps/waddling`) — Page Map + API Routes

App Router with **route groups** so W2 (dashboard) and W5 (docs/blog + marketing) own **disjoint segments** and never touch each other's files. W0 owns the root `layout.tsx`, `globals.css`, `next.config.mjs`, `source.config.ts` (Fumadocs + dashboard both need these — pre-created once).

```
apps/waddling/
├── source.config.ts                      (W0 — fumadocs collections: docs + blog)
├── next.config.mjs                       (W0 — withMDX wrapper)
├── content/                              (W5)
│   ├── docs/**.mdx        — quickstart, enterprise-setup, mcp-tools, acl-model, security
│   └── blog/**.mdx        — launch announcement post
└── src/
    ├── app/
    │   ├── layout.tsx                     (W0 — RootProvider + globals)
    │   ├── globals.css                    (W0 — tailwind + fumadocs preset imports)
    │   ├── (no middleware.ts — see auth-guard note below)
    │   ├── (marketing)/                   (W5)
    │   │   ├── page.tsx                    — landing / hero / value prop
    │   │   ├── pricing/page.tsx            — plans (reads PLANS from W1 contract)
    │   │   └── enterprise/page.tsx         — enterprise contact
    │   ├── docs/                           (W5)
    │   │   ├── layout.tsx · [[...slug]]/page.tsx
    │   ├── blog/                           (W5)
    │   │   └── [[...slug]]/page.tsx · page.tsx (index)
    │   ├── (dashboard)/dashboard/          (W2 — all dashboard pages)
    │   │   ├── layout.tsx                  — auth-guarded shell, org switcher
    │   │   ├── page.tsx                    — overview (usage sparklines, live sessions)
    │   │   ├── endpoints/(page|[id])       — list / detail (status, ATTACH string, schemas)
    │   │   ├── agents/(page|[id])          — list / detail (keys, default role, sessions)
    │   │   ├── acl/page.tsx                — rule builder (table → recompile)
    │   │   ├── audit/page.tsx              — audit_event explorer (filter/stream)
    │   │   ├── usage/page.tsx              — metering charts vs plan
    │   │   ├── billing/page.tsx            — Stripe portal, plan, invoices
    │   │   └── settings/page.tsx           — org, members (invite), api keys
    │   └── api/
    │       ├── auth/[...all]/route.ts       (W1 — toNextJsHandler(auth))
    │       ├── search/route.ts              (W5 — fumadocs createFromSource)
    │       └── cp/                          (W1 OWNS ALL control-plane REST — single owner)
    │           ├── sessions/route.ts        — POST connect/mint, DELETE kill
    │           ├── endpoints/route.ts · [id]/route.ts
    │           ├── agents/route.ts · [id]/route.ts
    │           ├── acl/route.ts · [id]/route.ts   — CRUD + triggers compiler
    │           ├── audit/route.ts
    │           ├── usage/route.ts
    │           └── billing/route.ts         — checkout, portal, webhook proxied to better-auth/stripe
    ├── lib/                                 (W1 owns auth.ts, db.ts, policy-compiler.ts; W0 owns source.ts, types)
    └── components/                          (W2 owns dashboard/*; W5 owns mdx.ts + marketing/*)
```

> **Collision resolution:** the four shared root files (`layout.tsx`, `globals.css`, `next.config.mjs`, `source.config.ts`) are **W0-owned**, created complete in scaffold so W2 and W5 only add files under disjoint route-group folders. **All `/api/cp/*` handlers are W1-owned** — MCP servers (W3/W4) and the dashboard (W2) consume them as HTTP clients, never create overlapping route files. `lib/auth.ts` + `lib/db.ts` are W1-owned; everyone else imports the typed contracts W0 declares.
>
> **No `middleware.ts` (collision avoided):** `src/middleware.ts` would intercept marketing/docs routes (W5) as well as dashboard routes (W2) — a shared-root file two streams would fight over. We use **NONE**. Auth-guarding is done entirely in `src/app/(dashboard)/dashboard/layout.tsx` (a server component, W2-owned) that calls `auth.api.getSession()` and redirects unauthenticated users. Marketing/docs/blog stay public. No workstream creates `middleware.ts`.

---

## 6. Stripe Plans (via `@better-auth/stripe`)

Subscriptions bound to `organization` (`referenceId = org_id`). Three plans, defined once in `lib/plans.ts` (W1):

| Plan | Price | `priceId` (placeholder env) | Entitlements |
|------|-------|------------------------------|--------------|
| **Free** | **$0** | `""` | 1 endpoint · **audit & monitor only** (read-only dashboard, audit log, usage) · 2 agents · static `reader`/`writer` roles only · community support |
| **Pro** | **$99 / seat / month** (`STRIPE_PRICE_PRO`) | `price_pro` | up to 5 endpoints · **full dynamic ACL** (column/row/window rules, instant revoke) · 25 agents · Internal MCP admin server · 90-day audit retention · email support |
| **Enterprise** | **custom** (`STRIPE_PRICE_ENTERPRISE`, contact sales) | `price_enterprise` | unlimited + **dedicated endpoints** (isolated gateways, encrypted lakes) · SSO/SAML · unlimited agents · 1-year audit · SLA · dedicated R2 buckets · priority |

Entitlement gating in `lib/entitlements.ts` (W1): `requirePlan(orgId, 'pro')` guards ACL-rule creation; free tier's ACL API returns `402 upgrade_required`. Stripe webhook → `/api/auth/stripe/webhook` (handled by the plugin) updates `subscription`; `getActivePlan(orgId)` reads it. Self-serve checkout + customer portal links from `dashboard/billing`.

---

## 7. Extension / MCP Distribution

### 7a. birdshot extension repo on R2 (one-command INSTALL — DevEx above everything)
R2 bucket `waddling-ext` fronted by CDN at **`https://ext.getwaddling.com`**, laid out per DuckDB's custom-repo spec (`extension-distribution.md`):

```
ext.getwaddling.com/                       (R2 bucket: waddling-ext, public read via CDN)
└── v1.5.3/                             (DuckDB engine version — matches @duckdb/node-api 1.5.3)
    ├── linux_amd64/birdshot.duckdb_extension.gz
    ├── linux_arm64/birdshot.duckdb_extension.gz
    ├── osx_arm64/birdshot.duckdb_extension.gz
    ├── osx_amd64/birdshot.duckdb_extension.gz
    └── windows_amd64/birdshot.duckdb_extension.gz
```

**User one-liner** (agents that run a local governed DuckDB):
```sql
SET allow_unsigned_extensions = true;          -- birdshot is custom/unsigned
INSTALL birdshot FROM 'https://ext.getwaddling.com';
LOAD birdshot;
```
Gzip preferred; `httpfs` auto-loads for HTTPS. CI (W6 builds the upload script; binaries come from existing `birdshot/` build) uploads `birdshot/build/release/extension/birdshot/birdshot.duckdb_extension` → gzip → R2 path above. **Most users never INSTALL birdshot** — it runs server-side on the waddling gateway; they only ATTACH. The extension repo exists for the self-hosted/edge case and for trust ("you can run the same enforcement locally").

### 7b. MCP install story (npx / uvx)
Both MCP servers are published npm packages with `bin` entries.

```jsonc
// Claude Desktop / any MCP host  — External (data plane)
{ "mcpServers": { "waddling": {
  "command": "npx", "args": ["-y", "@waddling/mcp@latest"],
  "env": { "WADDLING_API_KEY": "sk_agent_…", "WADDLING_URL": "https://app.getwaddling.com" } } } }

// Internal (admin) server
{ "mcpServers": { "waddling-admin": {
  "command": "npx", "args": ["-y", "@waddling/mcp-admin@latest"],
  "env": { "WADDLING_ADMIN_TOKEN": "…", "WADDLING_URL": "https://app.getwaddling.com" } } } }
```
Python agents: `uvx waddling-mcp` (a thin uv-published shim is a stretch goal; npx is the canonical path). One-liner add: `claude mcp add waddling -- npx -y @waddling/mcp@latest`.

---

## 8. Docker Demo (`docker-compose.yml` at repo `scripts/waddling-demo/`, W6 owns)

Self-contained, one command: `docker compose -f scripts/waddling-demo/docker-compose.yml up`.

| Service | Image / build | Port | Role |
|---------|---------------|------|------|
| `postgres` | `postgres:16` | **5470** | control plane (`waddling`+Better Auth schemas) **and** DuckLake catalog (`ducklake` db) |
| `minio` | `minio/minio` | **9000** (API) / **9001** (console) | R2 stand-in; bucket `waddling-lake` seeded |
| `gateway` | build `packages/gateway` | quack **9500**, ctrl **9510** | DuckDB + `quack_serve` + birdshot LOADed; ATTACHes `ducklake:postgres://…` DATA_PATH `s3://waddling-lake/` |
| `app` | build `apps/waddling` | **3100** | Next.js control plane + dashboard + docs |
| `mcp-external` | build `packages/mcp-external` | **8810** (HTTP) | external MCP for the demo agent |
| `demo-agent` | build `scripts/waddling-demo/agent` | — | scripted agent: connect → query → hit a denial → admin grants → retry succeeds |

**Seed script** (`scripts/waddling-demo/seed.ts`, W6): creates MinIO bucket; boots Postgres schemas + runs Better Auth migrations; seeds one org (`acme`), one admin user, one endpoint (`acme/prod-lake`), two agents (`analyst`, `etl-bot`) with API keys; loads a DuckLake `sales` schema with `orders`, `customers` (PII `customers.ssn` column), `events` tables (~50k rows of synthetic Parquet on MinIO); installs ACL rules: `analyst` → read `sales.orders` (deny `customers.ssn` column), `etl-bot` → write `sales.events`.

**Walkthrough narrative** (`scripts/waddling-demo/DEMO.md`, W6):
1. `up` → all green; open dashboard `:3100`, sign in as admin, see `acme` org, 2 agents, 1 running endpoint.
2. Demo agent (External MCP) calls `waddling_connect` → gets `attach_sql` → `waddling_query "SELECT * FROM sales.orders LIMIT 5"` → rows.
3. Agent tries `SELECT ssn FROM sales.customers` → **structured denial** (column not in allow-list + table not granted). Audit log lights up live in dashboard.
4. Admin's agent (Internal MCP) `waddling_admin_grant analyst read sales.customers columns=[id,name]` → compiler recompiles, pushes birdshot snapshot.
5. Agent retries (still no `ssn`) → succeeds for allowed columns; `ssn` still stripped by gateway proxy.
6. Admin `waddling_admin_revoke_agent etl-bot` → next `etl-bot` write **instantly denied** (birdshot denylist). Usage page shows query counts; billing shows plan.

---

## 9. Work Breakdown — 7 Workstreams, Strictly Disjoint File Ownership

**Ordering:** W0 first (creates every shared file so no later agent edits a shared file). Then W1–W6 run in parallel; each owns disjoint paths and consumes only contracts W0 declared. **No two workstreams write the same file.**

### W0 — Scaffold & Shared Contracts (runs first, alone)
**Owns:**
- `apps/waddling/package.json`, `tsconfig.json`, `next.config.mjs`, `source.config.ts`, `postcss/tailwind` config
- `apps/waddling/src/app/layout.tsx`, `src/app/globals.css` (tailwind + fumadocs preset imports)
- `apps/waddling/src/lib/source.ts` (fumadocs loader), `src/lib/env.ts`
- `packages/control-schema/` — `schema.sql` (§2 DDL), `migrate.ts`, **`src/types.ts` (all shared TS contracts, see below)**, `package.json` (name `@waddling/control-schema`, exports `.` → types barrel and `./schema.sql`)
- `apps/waddling/src/lib/types.ts` — **thin re-export only**: `export * from '@waddling/control-schema'` (so app code can use `@/lib/types`, packages use the real package name)
- `packages/mcp-external/package.json`, `packages/mcp-internal/package.json`, `packages/gateway/package.json` (empty stubs + tsconfig only — bodies owned by W3/W4)
- root `pnpm-workspace.yaml` already globs `apps/*`+`packages/*` (no edit needed); root `package.json` scripts: add `dev:waddling`, `db:waddling`
- `scripts/waddling-demo/docker-compose.yml` — **the COMPLETE file** (all services, ports, build contexts, volumes, commands per §8). Compose does not validate referenced Dockerfile paths at author time, so W0 writes it whole even though W6 creates the Dockerfiles later. W6 never edits this file.

**Contracts W0 declares in `packages/control-schema/src/types.ts`.** Import paths: app code → `@/lib/types` (re-export); workspace packages (W3/W4 gateway/MCP) → **`@waddling/control-schema`** (the real package — `@/*` aliases do NOT resolve across packages):
```ts
export interface SessionGrant { tables: {schema:string;table:string;verbs:('read'|'write')[];columns?:string[];rowLimit?:number}[] }
export interface ConnectResult { sessionId:string; attachSql:string; sessionJwt:string; endpoint:{host:string;port:number}; ttlSeconds:number; granted:SessionGrant }
export interface AclRuleInput { endpointId:string; agentId?:string; schema:string; table:string; columns?:string[]; verb:'read'|'write'; effect?:'allow'|'deny'; rowLimit?:number; ttlSeconds?:number; window?:{start:string;end:string}; notBefore?:string; expiresAt?:string }
export interface AuditQuery { orgId?:string; agentId?:string; since?:string; decision?:'allow'|'deny'; limit?:number }
export interface Plan { name:'free'|'pro'|'enterprise'; priceId:string; entitlements:{endpoints:number;agents:number;dynamicAcl:boolean;adminMcp:boolean;auditRetentionDays:number} }
export interface BirdshotSnapshot { roleGrants:{role:string;tableRef:string;action:'read'|'write'}[]; userRoles:{userId:string;role:string}[] }
```
**Acceptance:** `pnpm install` clean; `pnpm --filter @waddling/app build` compiles an empty-but-valid app; `psql -f packages/control-schema/schema.sql` runs; all stub packages typecheck.

### W1 — Auth + Billing + Control-plane REST + Policy Compiler
**Owns:** `apps/waddling/src/lib/auth.ts`, `lib/db.ts`, `lib/plans.ts`, `lib/entitlements.ts`, `lib/policy-compiler.ts`, `lib/gateway-client.ts`; **all** of `src/app/api/auth/**` and `src/app/api/cp/**`.
**Consumes:** `@/lib/types` (W0), `@waddling/control-schema` migrate (W0), birdshot SQL fns (gateway, W3) via `lib/gateway-client.ts`.
**Acceptance:** sign-up/sign-in works; org + API key creation; `POST /api/cp/sessions` mints a session JWT and returns a valid `ConnectResult`; `POST /api/cp/acl` writes a rule and the compiler emits the correct `birdshot_*` calls (unit-tested against a mock gateway); Stripe checkout → `subscription` row; `requirePlan` gates ACL on free tier (`402`).

### W2 — Dashboard UI
**Owns:** `apps/waddling/src/app/(dashboard)/**`, `src/components/dashboard/**`.
**Consumes:** `/api/cp/*` (W1) as HTTP client; Better Auth client (`authClient` from W1's `lib/auth.ts` exports `authClient`); `@/lib/types`.
**Acceptance:** auth-guarded shell; every §5 dashboard page renders live data from `/api/cp/*`; ACL rule-builder posts `AclRuleInput`; audit/usage charts; billing links to Stripe portal. Touches **no** file outside its two dirs.

### W3 — External MCP server + Gateway runtime
**Owns:** `packages/mcp-external/src/**`, `packages/gateway/src/**`.
**Consumes:** `/api/cp/*` (W1) over HTTP; shared contracts from **`@waddling/control-schema`** (W0 — not `@/lib/types`, which is app-only); the compiled birdshot binary from `birdshot/build/...` (existing). Gateway = DuckDB (`@duckdb/node-api`) + `quack_serve` + birdshot LOAD + DuckLake ATTACH + the **column/row/window query proxy** (§3d).
**Acceptance:** `npx @waddling/mcp` exposes all §4a tools; gateway ATTACHes a DuckLake on MinIO, enforces birdshot table grants + proxy column-stripping/row-limit; denials are structured; `waddling_connect`→`waddling_query` round-trips against the demo lake.

### W4 — Internal MCP server
**Owns:** `packages/mcp-internal/src/**`.
**Consumes:** `/api/cp/*` admin endpoints (W1); shared contracts from **`@waddling/control-schema`** (W0).
**Acceptance:** `npx @waddling/mcp-admin` exposes all §4b tools; `waddling_admin_grant` recompiles policy; `waddling_admin_revoke_agent` instantly denies; `waddling_admin_audit`/`usage`/`endpoint_status` return live data.

### W5 — Docs + Blog + Marketing
**Owns:** `apps/waddling/content/docs/**`, `content/blog/**`, `src/app/(marketing)/**`, `src/app/docs/**`, `src/app/blog/**`, `src/app/api/search/route.ts`, `src/components/mdx.ts`, `src/components/marketing/**`.
**Consumes:** `lib/source.ts` (W0); `PLANS` from `lib/plans.ts` (W1) for the pricing page.
**Acceptance:** Fumadocs docs render (quickstart, enterprise-setup, mcp-tools, acl-model, security); blog launch post renders; marketing landing + pricing (reads real plans) + enterprise pages; search route works. Touches no dashboard/api-cp files.

### W6 — Docker Demo
**Owns:** `scripts/waddling-demo/**` **except `docker-compose.yml`** (W0 wrote that complete; W6 never touches it). W6 owns `scripts/waddling-demo/seed.ts`, `agent/**`, `DEMO.md`, `mc-setup.sh`, and **all** `Dockerfile.*` (app, gateway, mcp-external, demo-agent) — the gateway Dockerfile lives here, not in W3's source dir.
**Consumes:** built images of W1/W3/W4 packages; schema from W0.
**Acceptance:** `docker compose up` → all services healthy; seed creates org/agents/endpoint/ACL + Parquet on MinIO; scripted `demo-agent` runs the §8 narrative end-to-end (connect → query → denial → admin grant → retry → revoke) with visible audit entries.

**Disjointness guarantee:** W0 owns every file two+ streams would share (root layout/globals/config, the `@waddling/control-schema` types barrel + schema, `src/lib/types.ts` re-export, MCP/gateway package manifests, the **complete** docker-compose.yml; no `middleware.ts` exists). After W0, the path sets of W1–W6 are pairwise disjoint: W1 = `lib/{auth,db,plans,entitlements,policy-compiler,gateway-client}` + `api/{auth,cp}`; W2 = `(dashboard)` + `components/dashboard`; W3 = `packages/{mcp-external,gateway}/src`; W4 = `packages/mcp-internal/src`; W5 = `content` + `(marketing)`/`docs`/`blog` routes + `api/search` + `components/{mdx,marketing}`; W6 = `scripts/waddling-demo/{seed.ts,agent,DEMO.md,mc-setup.sh,Dockerfile.*}`. No overlaps — every shared file resolves to exactly one W0 owner.

---

## 10. Lakekeeper — Per-Endpoint Scheduled Maintenance

Every waddling endpoint runs automated lakehouse maintenance. This keeps Parquet file counts low, scan performance high, and storage costs in check without any operator intervention.

### 10a. Maintenance pipeline

Each maintenance run executes these steps in order against the endpoint's live DuckLake:

1. **Flush inlined data** — `CALL ducklake_flush_inlined_data('lake')` — promotes small-insert catalog rows to Parquet files on R2.
2. **Compact small files** — `CALL ducklake_merge_adjacent_files('lake')` — merges adjacent small files into fewer larger ones. Non-destructive; snapshots remain valid.
3. **Expire snapshots** — `CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL '<retention>')` — marks old snapshots eligible for deletion per plan entitlement (free: 7 days / pro: 90 days / enterprise: 1 year, tunable).
4. **Delete orphaned files** — `CALL ducklake_delete_orphaned_files('lake', cleanup_all => true)` — removes R2 objects no longer referenced by any live snapshot. R2 zero-egress makes the read scan to identify orphans free.
5. **Catalog vacuum / ANALYZE** — refreshes DuckLake Postgres catalog statistics so the DuckDB query planner has fresh estimates.
6. **Health metrics** — file count, average file size, snapshot count, oldest retained snapshot — written to the `endpoint` row's status blob and surfaced in the dashboard **Endpoints → Health** panel and via `waddling_admin_endpoint_status`.

### 10b. Scheduling

```
Cloudflare Cron Trigger (nightly 02:00 UTC per endpoint)
  → Cloudflare Queue  (back-pressure; maintenance work never blocks query traffic)
    → gateway control channel  (POST /gw/maintain)
      → DuckDB maintenance SQL sequence (§10a)
```

Default schedule: `0 2 * * *` UTC. Enterprise customers can override the cron expression per endpoint.

### 10c. Retention by plan

| Plan | Snapshot retention | Notes |
|------|--------------------|-------|
| **Free** | 7 days | Shared maintenance windows |
| **Pro** | 90 days | Isolated runs; full run logs |
| **Enterprise** | 1 year (default) | Configurable via `waddling_admin_maintain_endpoint`; minimum 7 days; can disable auto-maintenance |

### 10d. Future tool — `waddling_admin_maintain_endpoint` (W9, spec only)

An admin MCP tool that lets enterprise customers trigger on-demand maintenance, override retention and file-size thresholds, or run a `dry_run` that returns what would be compacted/deleted without side effects. Parameters: `retention_days`, `min_file_size_bytes`, `max_file_size_bytes`, `schedule_cron`, `dry_run`. This tool is a W9 deliverable and is not yet implemented.

---

## 11. Serverless MCP on Cloudflare Workers

### 11a. Remote MCP surface

waddling operates a **remote MCP endpoint** at `mcp.getwaddling.com`. Remote agents (browser-based, server-to-server, CI pipelines) connect via **streamable HTTP** without installing any local binary:

```json
{
  "mcpServers": {
    "waddling-remote": {
      "url": "https://mcp.getwaddling.com/sse",
      "headers": { "Authorization": "Bearer sk_agent_…" }
    }
  }
}
```

### 11b. Implementation architecture

| Layer | Technology | Role |
|-------|-----------|------|
| **MCP Worker** | Cloudflare Workers + Durable Objects | `McpAgent` from Agents SDK (streamable HTTP); sessions as DOs; stateless request fan-out |
| **Auth** | `workers-oauth-provider` + Better Auth as upstream IdP | OAuth consent = signup; supersedes device-code for remote context |
| **Control plane access** | Hyperdrive | Worker → Postgres control plane over a persistent connection pool |
| **Data path** | Direct: agent DuckDB → gateway | Workers **never proxy result sets** — only control-plane calls traverse the Worker |
| **Audit / usage ingestion** | Cloudflare Queues | Worker enqueues `usage_event` + `audit_event` records; consumer writes to Postgres |

**Key constraint:** The Worker handles MCP protocol framing, OAuth token exchange, and control-plane API calls (session mint, ACL queries). It never sits in the data path — result sets flow directly from the agent's DuckDB to the gateway over quack. This keeps Workers well within CPU and memory limits.

### 11c. Shared tool definitions — `@waddling/mcp-tools` (W10, spec only)

The stdio MCP server (`packages/mcp-external`) and the Worker MCP server define identical tool schemas and handlers. A future `@waddling/mcp-tools` package will extract the shared tool registry so both builds import from one place, eliminating drift. Until W10 ships, both builds maintain their own copies aligned to this spec.

### 11d. Gateway stays on Cloudflare Containers

The DuckDB gateway (`packages/gateway`) continues to run on **Cloudflare Containers** (native DuckDB + birdshot; scale-to-zero; cold-start on first ATTACH). The Worker never replaces the gateway — it only routes MCP protocol framing and control-plane calls.

---

## 12. Funnel & Analytics

### 12a. Acquisition tiers

waddling has three zero-friction acquisition entry points, each targeting a different persona:

| Tier | Surface | Target user |
|------|---------|-------------|
| **Marketplace plugin** | `/plugin install waddling@waddling-plugins` — one command in any Claude Code session | Developers already using Claude Code |
| **`.mcpb` Desktop Extension** | One-click install in Claude Desktop | Non-developer Claude Desktop users |
| **Remote connector** | `mcp.getwaddling.com` — no install, just a URL + Bearer token | Server-side agents, CI, browser-based LLM environments |

### 12b. Device-code onboarding flow

The device-code flow bridges CLI (where there is no browser) to the waddling account system:

```
Agent calls waddling_signup_start
          │
          ▼
Control plane: create device record
  device_id = random UUID → ~/.waddling/device.json
  code      = DUCK-XXXX (short, human-readable)
  expires   = 10 minutes
          │
          ▼ (server returns code + URL)
Agent displays to user:
  "Visit https://app.getwaddling.com/link/DUCK-XXXX"
          │
          ▼ (user visits URL in browser)
Browser: claim the device link
  → POST /api/cp/device/claim  (authenticated web session)
  → device record marked 'claimed', linked to user + org
  → PostHog: alias(device:<id> → userId), identify(userId, {email})
  → PostHog event: device_link_claimed  (groups: {organization: orgId})
          │
          ▼ (agent polls every 5 s)
Agent calls waddling_signup_poll
  → status = 'claimed'
  → control plane mints agent API key for this device session
  → key returned ONCE over the poll response
  → PostHog event: signup_completed
          │
          ▼
Agent stores key → keychain / CLAUDE_PLUGIN_DATA/state/
PostHog event: mcp_onboarding_started → mcp_connect → first_query ($set_once)
```

**Pre-auth distinct_id:** `device:<uuid>` — generated locally, never tied to any personal data until the user completes browser signup. If the user abandons before claiming, the device record and its distinct_id are never linked to a real person.

**Web signup with device parameter:** If a user arrives at `app.getwaddling.com` directly (not via a device code) and a `device` query parameter is present from a prior MCP session, the server performs the alias and identify calls at account-creation time, retroactively linking the device's anonymous funnel events to the new account.

### 12c. PostHog event taxonomy (canonical)

These are the exact event names used in both client-side (`posthog-js`) and server-side (`posthog-node`) capture. Do not rename or add synonyms.

| Event | Where fired | Key properties |
|-------|-------------|----------------|
| `plugin_installed` | Claude Code plugin hook (post-install) | `plugin_version` |
| `mcp_onboarding_started` | MCP server startup (first run) | `transport` (`stdio`\|`http`) |
| `device_link_created` | Control plane: `POST /api/cp/device` | `expires_in_seconds` |
| `device_link_claimed` | Control plane: `POST /api/cp/device/claim` | (after alias + identify) |
| `signup_completed` | Control plane: device poll delivers key | `signup_method` (`device_code`\|`web`) |
| `org_created` | Control plane: org provisioning | (groups: `{organization: orgId}`) |
| `endpoint_created` | Control plane: `POST /api/cp/endpoints` | `region`, `encrypted` |
| `agent_created` | Control plane: `POST /api/cp/agents` | `default_role` |
| `mcp_connect` | MCP server: `waddling_connect` success | `endpoint_id`, `ttl_seconds` |
| `first_query` | MCP server: first `waddling_query` per person | ($set_once on person) |
| `query_executed` | MCP server: `waddling_query` | `decision` (`allow`\|`deny`), `duration_ms` |
| `denial_hit` | MCP server: `waddling_query` → `authorization_denied` | `reason` (`column`\|`table`\|`revoked`\|`expired`) |
| `upgrade_viewed` | Dashboard: billing page / upgrade prompt | `from_plan` |
| `checkout_started` | Dashboard: Stripe checkout redirect | `to_plan` |
| `checkout_completed` | Stripe webhook → control plane | `plan`, `mrr_cents` |
| `agent_revoked` | MCP/dashboard: `waddling_admin_revoke_agent` | `reason` |

### 12d. Identity model

```
Before auth:  distinct_id = 'device:<uuid>'  (localStorage + ~/.waddling/device.json)
At claim:     posthog.alias('device:<uuid>', userId)
              posthog.identify(userId, { $set: { email: userEmail, plan: 'free' } })
Per org event: groups: { organization: orgId }
```

Server-side alias and identify calls use `posthog-node` singleton; client-side use `posthog-js` via `PostHogProvider`. Both read `WADDLING_TELEMETRY` before any capture.

### 12e. Privacy commitments

- **Never captured:** SQL text, API keys, session JWTs, row data, email addresses in event properties, file paths, IP addresses.
- **Email** lives on the PostHog person profile (`identify` call) — not in event properties.
- **Opt-out:** set `WADDLING_TELEMETRY=0` in any CLI or MCP server environment. This prevents PostHog client initialization entirely — no events are batched or sent.
- **Client-side opt-out:** `posthog.optOut()` in the browser (persisted to localStorage). Available in account settings.
- No SQL text is captured anywhere in the pipeline. Query analytics use only `decision`, `duration_ms`, and `reason` — never the query string itself.
