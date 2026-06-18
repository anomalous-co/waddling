-- waddling custom schema DDL (§2b)
-- Apply AFTER Better Auth migrations (which own the 'auth' schema).
-- Run: psql $DATABASE_URL -f schema.sql

CREATE SCHEMA IF NOT EXISTS waddling;

-- ── Lakehouse endpoints (one per org's DuckLake; an org may have several) ──
CREATE TABLE IF NOT EXISTS waddling.endpoint (
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
CREATE TABLE IF NOT EXISTS waddling.agent (
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
CREATE TABLE IF NOT EXISTS waddling.acl_rule (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL REFERENCES waddling.endpoint(id) ON DELETE CASCADE,
  agent_id        TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE, -- NULL = org-wide
  -- resource selector (catalog.schema.table.column)
  schema_name     TEXT NOT NULL DEFAULT '*',             -- '*', 'sales', ...
  table_name      TEXT NOT NULL DEFAULT '*',             -- '*', 'orders', ...
  columns         TEXT[],                                -- NULL = all columns; else allow-list
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
-- Note: spec called for WHERE expires_at IS NULL OR expires_at > now() but now() is STABLE
-- not IMMUTABLE so Postgres rejects it in index predicates. Using plain index instead;
-- application-level filtering handles active-rule queries.
CREATE INDEX IF NOT EXISTS acl_rule_endpoint_agent_idx
  ON waddling.acl_rule (endpoint_id, agent_id);

-- ── Agent sessions (live ATTACH sessions; NOT Better Auth session) ──
CREATE TABLE IF NOT EXISTS waddling.agent_session (
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
CREATE INDEX IF NOT EXISTS agent_session_org_status_idx
  ON waddling.agent_session (org_id, status);

-- ── Audit (durable; mirrors birdshot's drained ring + control-plane events) ──
CREATE TABLE IF NOT EXISTS waddling.audit_event (
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
CREATE INDEX IF NOT EXISTS audit_event_org_ts_idx
  ON waddling.audit_event (org_id, ts DESC);

-- ── Usage (metering for billing + dashboard) ──
CREATE TABLE IF NOT EXISTS waddling.usage_event (
  id              BIGSERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id        TEXT,
  endpoint_id     TEXT,
  kind            TEXT NOT NULL,        -- 'query'|'rows_scanned'|'bytes_scanned'|'session'
  quantity        BIGINT NOT NULL DEFAULT 1,
  duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS usage_event_org_ts_idx
  ON waddling.usage_event (org_id, ts DESC);
-- Rollups for billing read this; W1 computes monthly aggregates from it.

-- ── Notebooks (saved SQL workbooks for the dashboard's Notebooks view) ──
-- Org-scoped (shared across the org's members). `cells` is a JSON array of
-- { id, sql, title? }; the runner executes each cell as a chosen agent through
-- that agent's ACL (the gateway query proxy), so a notebook shows exactly what
-- a given agent is allowed to read/write.
CREATE TABLE IF NOT EXISTS waddling.notebook (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  cells           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      TEXT,                 -- user id that created it
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notebook_org_idx
  ON waddling.notebook (org_id, updated_at DESC);

-- ── Saved views (queries pinned from a notebook cell) ──────────────────────
-- Org-scoped named queries surfaced on the dashboard's Views page. Like
-- notebooks, a view holds only SQL — it is executed AS a chosen agent through
-- that agent's ACL (the gateway query proxy), so a view shows exactly what a
-- given agent is allowed to read.
CREATE TABLE IF NOT EXISTS waddling.saved_view (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  sql             TEXT NOT NULL,
  created_by      TEXT,                 -- user id that created it
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_view_org_idx
  ON waddling.saved_view (org_id, updated_at DESC);
