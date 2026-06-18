-- Migration 006 — per-agent durable encrypted DuckDB workspaces.
-- Apply AFTER migrations-005. Idempotent. Run via seed.ts / migrate.ts or:
--   psql $DATABASE_URL -f migrations-006-workspaces.sql
--
-- A WORKSPACE is a first-class object (its own id) in a many-to-many relationship
-- with agents: an agent may belong to many workspaces; a workspace holds many
-- agents. Each (workspace, agent) pair owns ONE durable, natively-encrypted DuckDB
-- file at s3://<bucket>/workspace/<workspaceId>/db/<agentId>.duckdb — the agent's
-- private scratch that persists across reconnects. Lake reads from that workspace
-- still tunnel through the gateway → birdshot_authorize (the one invariant); the
-- workspace just adds private, persistent, agent-owned state.
--
-- The per-pair 32-byte workspace encryption key is control-plane-managed and stored
-- ENVELOPE-ENCRYPTED (AES-256-GCM via lib/secret-crypto.ts — same model as
-- waddling.endpoint_secret); it is vended to the session actor at session start and
-- NEVER returned to the agent.

CREATE TABLE IF NOT EXISTS waddling.workspace (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id      TEXT NOT NULL,                                  -- → auth.organization.id
  name        TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES waddling.endpoint(id) ON DELETE CASCADE, -- lake this workspace's agents attach
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- m2m workspace↔agent + the per-pair durable-DB metadata. The workspace key is
-- envelope-encrypted in (key_iv, key_auth_tag, key_ciphertext) — AES-256-GCM parts,
-- BYTEA, exactly like waddling.endpoint_secret. NULL key parts ⇒ not yet generated
-- (created lazily on first session via lib/workspace-keys.ts).
CREATE TABLE IF NOT EXISTS waddling.workspace_agent (
  workspace_id        TEXT NOT NULL REFERENCES waddling.workspace(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL REFERENCES waddling.agent(id) ON DELETE CASCADE,
  key_iv              BYTEA,
  key_auth_tag        BYTEA,
  key_ciphertext      BYTEA,
  db_uri              TEXT,                 -- s3://<bucket>/workspace/<workspaceId>/db/<agentId>.duckdb
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checkpoint_at  TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS workspace_org_idx ON waddling.workspace (org_id);
CREATE INDEX IF NOT EXISTS workspace_agent_agent_idx ON waddling.workspace_agent (agent_id);
