-- waddling custom schema DDL (§2b)
-- Apply AFTER Better Auth migrations (which own the 'auth' schema).
-- Run: psql $DATABASE_URL -f schema.sql

CREATE SCHEMA IF NOT EXISTS waddling;

-- ── Datalakes (one per org's DuckLake data source; an org may have several) ──
-- Created here under its legacy name `endpoint`; migration 008 renames it to `datalake`
-- and drops the dead gateway-compute columns (gateway_host, quack_port — the gateway is
-- now a dynamic scale-to-zero pool, see apps/dataplane GatewayPoolDO). Guarded so a re-run
-- AFTER 008 (when `datalake` already exists) does not resurrect a phantom `endpoint`.
DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NULL THEN
    CREATE TABLE IF NOT EXISTS waddling.endpoint (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id          TEXT NOT NULL,                        -- → auth.organization.id
      name            TEXT NOT NULL,                        -- 'prod-lake', 'analytics'
      slug            TEXT NOT NULL,                        -- url-safe; unique per org
      status          TEXT NOT NULL DEFAULT 'provisioning'  -- provisioning|running|stopped|error
                        CHECK (status IN ('provisioning','running','stopped','error')),
      -- DuckLake binding
      catalog_dsn     TEXT NOT NULL,        -- postgres DSN for the DuckLake metadata catalog
      data_path       TEXT NOT NULL,        -- 's3://org-<id>/lake/'  (R2)
      region          TEXT NOT NULL DEFAULT 'auto',
      encrypted       BOOLEAN NOT NULL DEFAULT true,
      -- gateway runtime (dropped by 008 — superseded by the dynamic pool)
      gateway_host    TEXT,
      quack_port      INTEGER,
      server_token    TEXT NOT NULL,        -- birdshot server_token (secret) — boots every replica
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, slug)
    );
  END IF;
END $$;

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
  -- Populated by delegated connect path; NULL for autonomous agents. No FK: cross-schema.
  owner_user_id   TEXT,                                  -- → auth.user.id (nullable)
  UNIQUE (org_id, name)
);

-- ── ACL rules (the dynamic policy; compiled into birdshot + gateway constraints) ──
CREATE TABLE IF NOT EXISTS waddling.acl_rule (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL REFERENCES waddling.endpoint(id) ON DELETE CASCADE,
  -- Subject selector (migration 010 adds subject_kind/user_id; endpoint_id renamed to
  -- datalake_id by migration 008, so the column here uses the legacy name for fresh
  -- schema.sql apply order — migration 008 renames it afterward).
  agent_id        TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE, -- NULL = org/user-wide
  subject_kind    TEXT NOT NULL DEFAULT 'agent'
                    CHECK (subject_kind IN ('agent','user','org')),
  user_id         TEXT,                                  -- → auth.user.id (no FK: cross-schema)
  -- resource selector (catalog.schema.table.column)
  schema_name     TEXT NOT NULL DEFAULT '*',             -- '*', 'sales', ...
  table_name      TEXT NOT NULL DEFAULT '*',             -- '*', 'orders', ...
  columns         TEXT[],                                -- NULL = all columns; else allow-list
  -- verb (legacy; capability supersedes for new rows — kept for backcompat + compiler)
  verb            TEXT NOT NULL CHECK (verb IN ('read','write')),
  -- capability (full taxonomy; defaults 'read' so old rows are unchanged)
  capability      TEXT NOT NULL DEFAULT 'read'
                    CHECK (capability IN (
                      'read','write','create','drop','alter',
                      'read_source','copy_to','copy_from',
                      'attach','detach','install','load','etl'
                    )),
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
-- Guarded: pre-008 the column is endpoint_id (index acl_rule_endpoint_agent_idx); 008
-- renames both. Post-rename this is a no-op (the renamed index already exists).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='acl_rule' AND column_name='endpoint_id') THEN
    CREATE INDEX IF NOT EXISTS acl_rule_endpoint_agent_idx ON waddling.acl_rule (endpoint_id, agent_id);
  END IF;
END $$;

-- Composite lookup index on acl_rule for the derive+compile spine (datalake_id only
-- exists after migration 008; subject_kind/user_id only after migration 010; guard on
-- BOTH so a post-008/pre-010 re-run (reachable on partial failure) skips safely and
-- lets migration 010 add the columns before the index is created.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='acl_rule' AND column_name='datalake_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='waddling' AND table_name='acl_rule' AND column_name='subject_kind') THEN
    CREATE INDEX IF NOT EXISTS acl_rule_datalake_subject_idx
      ON waddling.acl_rule (datalake_id, subject_kind, user_id, agent_id);
  END IF;
END $$;

-- ── Delegation scopes (per-user, per-agent capability subsets; migration 010+) ──
-- Only created when waddling.datalake already exists (post-migration-008). On a
-- fresh install schema.sql runs first (before 008 renames endpoint→datalake), so
-- migration 010 itself creates this table. On a re-run against a post-010 DB this
-- block is a no-op (CREATE TABLE IF NOT EXISTS + FK target exists).
DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS waddling.delegation (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id       TEXT NOT NULL,                        -- → auth.organization.id
      -- Subject (who is permitted to act): at least one of agent_id / client_id NOT NULL.
      user_id      TEXT NOT NULL,                        -- → auth.user.id (no FK: cross-schema)
      agent_id     TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE,
      client_id    TEXT,                                 -- OAuth client_id (Better Auth)
      -- Resource scope (NULL = all / wildcard)
      datalake_id  TEXT REFERENCES waddling.datalake(id) ON DELETE CASCADE,
      schema_name  TEXT NOT NULL DEFAULT '*',
      table_name   TEXT NOT NULL DEFAULT '*',
      columns      TEXT[],                               -- NULL = all columns
      -- Capability (must be a subset of the delegating user's own grants)
      capability   TEXT NOT NULL
        CHECK (capability IN (
          'read','write','create','drop','alter',
          'read_source','copy_to','copy_from',
          'attach','detach','install','load','etl'
        )),
      -- Dynamic constraints
      row_limit    INTEGER,
      window_start TIME,
      window_end   TIME,
      expires_at   TIMESTAMPTZ,
      -- Audit
      created_by   TEXT NOT NULL,                       -- auth.user.id who created scope
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT delegation_subject_not_null
        CHECK (agent_id IS NOT NULL OR client_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS delegation_lookup_idx
      ON waddling.delegation (user_id, datalake_id, agent_id, client_id);
  END IF;
END $$;

-- ── ACL policies (per-subject allowlists for NON-catalog resources; migration 012+) ──
-- read_source/copy URIs, INSTALL/LOAD extension names, ATTACH targets — gated by
-- birdshot_add_{source,dest,ext,attach}_policy, NOT table RefMatch. A policy only
-- WIDENS what an already-CONSTANT literal may match (un-pinnable resource = DENY).
-- Guarded: on a fresh DB schema.sql runs before migration 008 renames endpoint→datalake,
-- so waddling.datalake doesn't exist yet. Migration 012 creates it instead.
DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS waddling.acl_policy (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id       TEXT NOT NULL,
      datalake_id  TEXT REFERENCES waddling.datalake(id) ON DELETE CASCADE,  -- NULL = all
      subject_kind TEXT NOT NULL DEFAULT 'agent'
                     CHECK (subject_kind IN ('agent','user','org')),
      agent_id     TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE,
      user_id      TEXT,                                   -- → auth.user.id (no FK: cross-schema)
      policy_kind  TEXT NOT NULL
                     CHECK (policy_kind IN ('source','dest','extension','attach')),
      capability   TEXT NOT NULL
                     CHECK (capability IN (
                       'read_source','copy_to','copy_from','attach','install','load'
                     )),
      pattern      TEXT NOT NULL,                          -- host/domain or extension name
      expires_at   TIMESTAMPTZ,
      created_by   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT acl_policy_subject_resolvable CHECK (
        (subject_kind = 'agent' AND agent_id IS NOT NULL) OR
        (subject_kind = 'user'  AND user_id  IS NOT NULL) OR
        (subject_kind = 'org')
      )
    );
    CREATE INDEX IF NOT EXISTS acl_policy_lookup_idx
      ON waddling.acl_policy (datalake_id, subject_kind, user_id, agent_id);
  END IF;
END $$;

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
  duration_ms     INTEGER,
  -- Stable per-statement id (migration 018); a replayed ingest is a no-op. NULLABLE:
  -- legacy rows carry none. Partial-unique only over non-null keys.
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS usage_event_org_ts_idx
  ON waddling.usage_event (org_id, ts DESC);
-- Re-run safety: on a DB that predates migration 018 the column may not exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='waddling' AND table_name='usage_event'
                   AND column_name='idempotency_key') THEN
    ALTER TABLE waddling.usage_event ADD COLUMN idempotency_key TEXT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS usage_event_idem_uq
  ON waddling.usage_event (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
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
