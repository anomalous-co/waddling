-- Migration 009 — managed catalog moves to Neon. Apply AFTER 008. Idempotent + re-run-safe.
--
-- The per-org managed Postgres catalog is now a Neon project (one project per org). The
-- org_catalog row stores the Neon project id instead of a PlanetScale database name, so
-- rename the column. Value-preserving where a row exists; the application re-provisions on
-- demand if the stored handle no longer resolves.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='org_catalog' AND column_name='ps_database')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='org_catalog' AND column_name='neon_project_id') THEN
    ALTER TABLE waddling.org_catalog RENAME COLUMN ps_database TO neon_project_id;
  END IF;
END $$;
