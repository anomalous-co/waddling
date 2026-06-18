-- migrations-002-device-link.sql (FUNNEL / Stream B)
--
-- Agent-driven device-code onboarding. A headless agent (External MCP in
-- ONBOARDING mode) creates a device_link, shows the human a short code + URL;
-- the human signs in to the dashboard and claims it, which provisions an agent
-- + API key and writes the plaintext key into api_key_once. The agent polls by
-- poll_token; the key is delivered EXACTLY ONCE then NULLed.
--
-- Idempotent (IF NOT EXISTS) to match schema.sql conventions. Apply AFTER
-- schema.sql:  psql "$DATABASE_URL" -f migrations-002-device-link.sql

CREATE SCHEMA IF NOT EXISTS waddling;

CREATE TABLE IF NOT EXISTS waddling.device_link (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- 8-char human-friendly claim code (no ambiguous chars; e.g. 'K7P2-9QXM').
  code            TEXT NOT NULL,
  -- caller-supplied device identity (persisted ~/.waddling/device.json).
  device_id       TEXT NOT NULL,
  -- opaque bearer the polling agent presents to /poll (never shown to humans).
  poll_token      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','expired')),
  -- populated at claim time:
  claimed_by_user TEXT,                 -- → auth.user.id
  org_id          TEXT,                 -- → auth.organization.id
  agent_id        TEXT,                 -- → waddling.agent.id
  -- plaintext API key, delivered ONCE on the first post-claim poll then NULLed.
  -- (Encryption-at-rest is out of scope; the one-shot null-after-read limits the
  --  exposure window. Rows expire in 15m regardless.)
  api_key_once    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes')
);

-- Poll lookups hit poll_token; claim lookups hit code among non-expired rows.
CREATE UNIQUE INDEX IF NOT EXISTS device_link_poll_token_idx
  ON waddling.device_link (poll_token);
CREATE INDEX IF NOT EXISTS device_link_code_idx
  ON waddling.device_link (code);
CREATE INDEX IF NOT EXISTS device_link_expiry_idx
  ON waddling.device_link (expires_at);
