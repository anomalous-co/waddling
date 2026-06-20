-- Migration 010 — user-grant subjects, full capability taxonomy, and per-(user,agent)
-- delegation scopes. Apply AFTER migrations-009. Idempotent + re-run-safe.
-- Run: psql $DATABASE_URL -f migrations-010-user-grants-delegation.sql
--
-- Phase 1 of the birdshot full-scope ACL plan. No birdshot C++ change; control-plane
-- only. Adds:
--   A. Three new columns on waddling.acl_rule (subject_kind, user_id, capability) with
--      a one-time backfill of existing rows, plus a composite lookup index.
--   B. waddling.delegation — per-(user, agent|client_id) scoped delegation table.
--   C. waddling.agent.owner_user_id — optional consenter/owner for delegated agents.
--
-- INVARIANT: subject_kind defaults 'agent', capability defaults 'read' → existing
-- direct agent grants and the demo/Pro autonomous flows are completely unchanged.
-- The capability CHECK carries the FULL future taxonomy now so Phase 2/3 need no
-- additional migration for those columns.

-- ── A. Generalise waddling.acl_rule ──────────────────────────────────────────────
-- Gate the ADD COLUMNs + backfill inside a single DO block so re-running the
-- migration after Phase-1 app code has written subject_kind='user' or
-- capability='create' rows does NOT clobber them. The check on subject_kind's
-- absence is the sentinel: all three columns are added together in the first run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'waddling'
      AND table_name   = 'acl_rule'
      AND column_name  = 'subject_kind'
  ) THEN
    ALTER TABLE waddling.acl_rule
      ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (subject_kind IN ('agent','user','org'));

    ALTER TABLE waddling.acl_rule
      ADD COLUMN user_id TEXT;  -- → auth.user.id (no FK: cross-schema rule)

    ALTER TABLE waddling.acl_rule
      ADD COLUMN capability TEXT NOT NULL DEFAULT 'read'
        CHECK (capability IN (
          'read','write','create','drop','alter',
          'read_source','copy_to','copy_from',
          'attach','detach','install','load','etl'
        ));

    -- Backfill: set subject_kind from the existing agent_id shape.
    -- Rows with agent_id IS NULL were org-wide rules; rows with an agent_id are
    -- agent-specific. capability mirrors the existing verb column exactly.
    UPDATE waddling.acl_rule
       SET subject_kind = CASE WHEN agent_id IS NULL THEN 'org' ELSE 'agent' END,
           capability   = verb;
  END IF;
END $$;

-- Composite lookup index for the derive + compile spine. Covers:
--   • grantsForAgent(datalakeId, agentId)     → (datalake_id, 'agent', NULL, agentId)
--   • user grants lookup                       → (datalake_id, 'user',  userId, NULL)
--   • org-wide rules                           → (datalake_id, 'org',   NULL,  NULL)
CREATE INDEX IF NOT EXISTS acl_rule_datalake_subject_idx
  ON waddling.acl_rule (datalake_id, subject_kind, user_id, agent_id);

-- ── B. waddling.delegation ────────────────────────────────────────────────────────
-- Per-(user, agent|client_id) delegation scope. A delegation row says:
--   "user USER_ID permits agent AGENT_ID (or OAuth client CLIENT_ID) to act on
--    their behalf with at most CAPABILITY on DATALAKE_ID (NULL = all), restricted
--    to SCHEMA_NAME.TABLE_NAME[COLUMNS], row_limit rows, within [window_start,
--    window_end], until EXPIRES_AT."
-- Derived effective grants (owner's grants ∩ delegation scope) are computed at
-- connect/recompile and NEVER persisted. Revoking a user grant immediately shrinks
-- every agent that user owns/consents.
CREATE TABLE IF NOT EXISTS waddling.delegation (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id       TEXT NOT NULL,                          -- → auth.organization.id

  -- Subject (who is permitted to act): at least one of agent_id / client_id is NOT NULL.
  user_id      TEXT NOT NULL,                          -- → auth.user.id (no FK: cross-schema)
  agent_id     TEXT REFERENCES waddling.agent(id) ON DELETE CASCADE,
  client_id    TEXT,                                   -- OAuth client_id (Better Auth)

  -- Resource scope (NULL = all / wildcard)
  datalake_id  TEXT REFERENCES waddling.datalake(id) ON DELETE CASCADE, -- NULL = all datalakes
  schema_name  TEXT NOT NULL DEFAULT '*',
  table_name   TEXT NOT NULL DEFAULT '*',
  columns      TEXT[],                                 -- NULL = all columns

  -- Capability (must be a subset of the delegating user's own grants)
  capability   TEXT NOT NULL
    CHECK (capability IN (
      'read','write','create','drop','alter',
      'read_source','copy_to','copy_from',
      'attach','detach','install','load','etl'
    )),

  -- Dynamic constraints (each independently tightens the ceiling)
  row_limit    INTEGER,                                -- NULL = no additional row cap
  window_start TIME,                                   -- UTC time-of-day window open
  window_end   TIME,                                   -- UTC time-of-day window close
  expires_at   TIMESTAMPTZ,                            -- NULL = no expiry on this scope

  -- Audit
  created_by   TEXT NOT NULL,                         -- auth.user.id who created scope
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Either an agent_id or a client_id (or both) must be present.
  CONSTRAINT delegation_subject_not_null
    CHECK (agent_id IS NOT NULL OR client_id IS NOT NULL)
);

-- Lookup index for the derive + compile spine: find all scopes for a user+datalake
-- pair, and for a specific agent or OAuth client.
CREATE INDEX IF NOT EXISTS delegation_lookup_idx
  ON waddling.delegation (user_id, datalake_id, agent_id, client_id);

-- ── C. waddling.agent.owner_user_id ──────────────────────────────────────────────
-- Optional field: the human user who is the consenter/owner of a delegated agent.
-- Populated by the delegated connect path; NULL for autonomous agents. No FK:
-- cross-schema rule (§2 of schema conventions).
ALTER TABLE waddling.agent
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
