-- Migration 011 — add the datalake `kind` discriminator. Apply AFTER 010.
-- Idempotent + re-run-safe (guarded so the whole migrate chain can run repeatedly).
--
-- WHY: a datalake is now one of two kinds. 'lake' (the default, existing behavior) is a
-- governed DuckLake — the gateway boots birdshot and ATTACHes the org's DuckLake catalog +
-- object store. 'quackboard' is a per-org governed DuckDB with NO DuckLake mounted: the
-- gateway still boots birdshot and enforces ACLs, but the served database IS the durable
-- store (shared agent-coordination tables — observations/agent_memory/notifications/…),
-- persisted as a single .duckdb file to R2. The only boot difference is skipping the
-- ducklake ATTACH; everything else (server_token, JWT triangle, birdshot) is shared.
--
-- VALUE-PRESERVING: adds one column with a safe default ('lake'); every existing datalake
-- keeps its current behavior with no backfill.
DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'waddling' AND table_name = 'datalake' AND column_name = 'kind'
     ) THEN
    ALTER TABLE waddling.datalake
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'lake' CHECK (kind IN ('lake', 'quackboard'));
  END IF;
END $$;
