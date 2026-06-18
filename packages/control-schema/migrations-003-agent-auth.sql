-- Migration 003 — Agent Auth (AAP) identity + one-key-per-agent enforcement.
-- Apply AFTER schema.sql and migrations-002. Idempotent.
-- Run: psql $DATABASE_URL -f migrations-003-agent-auth.sql
--
-- Adopts Better Auth's Agent Auth Protocol *identity model* (mode, on-behalf-of,
-- capability) for tracing, and turns "one key = one agent = one live instance"
-- into a DB-enforced invariant — because Claude Desktop/Code give the server no
-- per-agent or per-conversation id over the wire (shared product client_id; no
-- echoed MCP-Session-Id). The credential is therefore the unit of agent identity.

-- ── 1. One API key ↔ one agent (provisioning invariant) ────────────────────────
-- A given Better Auth apikey may back at most one waddling.agent. Stops a key from
-- being reused to mint a second agent (which would alias two agents into one trace).
CREATE UNIQUE INDEX IF NOT EXISTS agent_api_key_unique
  ON waddling.agent (api_key_id)
  WHERE api_key_id IS NOT NULL;

-- ── 2. Agent identity: AAP mode ────────────────────────────────────────────────
-- 'autonomous' = agent holds its own API key (the one-key-per-agent path; the
-- strong cardinality signal). 'delegated' = acts on behalf of a human resolved via
-- the OAuth/AAP flow (phase 2). Existing agents hold keys → autonomous.
ALTER TABLE waddling.agent
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'autonomous'
    CHECK (mode IN ('delegated','autonomous'));

-- ── 3. One live session per agent (runtime invariant — the teeth) ──────────────
-- `origin` distinguishes a real agent connection (the API key in use) from a
-- dashboard "run-as-agent" inspection. Only origin='agent' sessions are capped at
-- one-active-per-agent, so admin run-as inspection is never blocked.
ALTER TABLE waddling.agent_session
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'agent'
    CHECK (origin IN ('agent','run-as'));

-- Add 'superseded' to the status domain (a live session displaced by a newer
-- connect from the same key). Drop+recreate the auto-named CHECK.
ALTER TABLE waddling.agent_session
  DROP CONSTRAINT IF EXISTS agent_session_status_check;
ALTER TABLE waddling.agent_session
  ADD CONSTRAINT agent_session_status_check
  CHECK (status IN ('active','expired','revoked','killed','superseded'));

-- Reap genuinely-expired rows still marked 'active' so the unique index below can
-- be built cleanly (and so connect's supersede logic only sees live sessions).
UPDATE waddling.agent_session
   SET status = 'expired', ended_at = COALESCE(ended_at, now())
 WHERE status = 'active' AND expires_at < now();

-- DB backstop for single-active-session, scoped to (agent, endpoint): an agent may
-- hold one live session PER endpoint, so a legitimately multi-homed agent (the
-- per-(endpoint,agent) ACL model) can fan out, while same-endpoint key-sharing is
-- still caught. App logic supersedes the prior session on connect; this index
-- guarantees correctness under concurrent connects (loser → 409 agent_session_in_use).
CREATE UNIQUE INDEX IF NOT EXISTS agent_session_one_active_per_agent
  ON waddling.agent_session (agent_id, endpoint_id)
  WHERE status = 'active' AND origin = 'agent';

-- ── 4. Trace enrichment: AAP identity on audit + usage events ──────────────────
-- Nullable/additive. No FK to Better Auth tables (cross-schema rule, §2). These let
-- a trace answer who delegated, in what mode, invoking which capability — separate
-- from the ACL/grant layer (capability != birdshot table/col/row grant).
ALTER TABLE waddling.audit_event
  ADD COLUMN IF NOT EXISTS agent_mode   TEXT,  -- 'delegated' | 'autonomous'
  ADD COLUMN IF NOT EXISTS on_behalf_of TEXT,  -- delegating auth.user.id (key owner, or run-as user)
  ADD COLUMN IF NOT EXISTS capability   TEXT;  -- coarse AAP capability invoked (e.g. 'waddling_connect')

ALTER TABLE waddling.usage_event
  ADD COLUMN IF NOT EXISTS agent_mode   TEXT,
  ADD COLUMN IF NOT EXISTS capability   TEXT;
