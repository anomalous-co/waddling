-- Migration 004 — delegated session origin (Agent Auth, OAuth/MCP path).
-- Apply AFTER migrations-003. Idempotent. Run via seed.ts or:
--   psql $DATABASE_URL -f migrations-004-delegated-origin.sql
--
-- A delegated agent (a human-consented OAuth/MCP connection from Claude) has NO API
-- key and Claude exposes no per-conversation id, so "one live session per agent" is
-- meaningless for it — two concurrent Claude chats from the same human resolve to the
-- same delegated agent. They must NOT fight over the one-active index. Giving delegated
-- sessions their own origin keeps them exempt (the index covers only origin='agent'),
-- exactly like dashboard run-as inspection.
ALTER TABLE waddling.agent_session
  DROP CONSTRAINT IF EXISTS agent_session_origin_check;
ALTER TABLE waddling.agent_session
  ADD CONSTRAINT agent_session_origin_check
  CHECK (origin IN ('agent','run-as','delegated'));
