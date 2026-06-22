-- Onboarding progress + the auto-provisioned demo resources, one row per org.
--
-- Control-plane MANAGEMENT metadata for the self-serve "aha" flow (not agent data): it
-- makes the guided wizard idempotent (the row is the provision guard) and resumable
-- (seeded_at / completed_at drive the wizard's state). demo_lake_id / demo_agent_id are
-- plain text (no FK — same no-FK convention as org_id elsewhere); a deleted lake/agent
-- just makes provision re-create on the next visit.
CREATE TABLE IF NOT EXISTS waddling.org_onboarding (
  org_id        text PRIMARY KEY,
  demo_lake_id  text,
  demo_agent_id text,
  -- demo sample data successfully loaded into the lake (the seed CTAS landed).
  seeded_at     timestamptz,
  -- user finished or dismissed the guided tour.
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
