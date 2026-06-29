-- Migration 019 — managed catalog moves to GCP Cloud SQL. Apply AFTER 018. Idempotent + re-run-safe.
--
-- The per-org managed Postgres catalog is now a database inside the single shared GCP Cloud SQL
-- instance (one database per org), not a Neon project. The org_catalog row stores the per-org
-- database name, so rename the handle column (neon_project_id → database_name) and make it
-- nullable: an 'error'-state row may exist with no database yet. Value-preserving where a row
-- exists; the application re-provisions on demand.

DO $$
BEGIN
  -- Rename to the provider-agnostic database_name. Handle both the original column
  -- (neon_project_id) and the interim name (gcp_database) so re-runs converge.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='org_catalog' AND column_name='database_name') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='waddling' AND table_name='org_catalog' AND column_name='neon_project_id') THEN
      ALTER TABLE waddling.org_catalog RENAME COLUMN neon_project_id TO database_name;
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='waddling' AND table_name='org_catalog' AND column_name='gcp_database') THEN
      ALTER TABLE waddling.org_catalog RENAME COLUMN gcp_database TO database_name;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='org_catalog' AND column_name='database_name'
               AND is_nullable='NO') THEN
    ALTER TABLE waddling.org_catalog ALTER COLUMN database_name DROP NOT NULL;
  END IF;
END $$;
