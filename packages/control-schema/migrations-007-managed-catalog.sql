-- Migration 007 — per-org managed Postgres catalog (PlanetScale). Apply AFTER
-- migrations-006. Idempotent. Run via seed.ts or:
--   psql $DATABASE_URL -f migrations-007-managed-catalog.sql
--
-- Each waddling org gets ONE PlanetScale Postgres database — the DuckLake metadata
-- catalog the gateway ATTACHes via `ducklake:postgres:<dsn>` on :5432 (proven reachable
-- from a GatewayDO container with enableInternet=true). This is a NEW catalog_mode,
-- 'managed-postgres', alongside the existing 'managed-local' (demo file catalog) and
-- 'byo-postgres' (customer-supplied DSN).
--
-- Provisioning is async (PlanetScale create→ready is seconds-to-minutes), modelled as a
-- provisioning→ready state machine on waddling.org_catalog: control-api kicks off the
-- create, then reconciles to 'ready' on poll, minting a branch password and sealing the
-- DSN. The sealed DSN (AES-256-GCM, same envelope as endpoint_secret) is the single
-- secret; the gateway decrypts it server-side at boot. NEVER exposed to the browser.

-- One managed catalog database per org.
CREATE TABLE IF NOT EXISTS waddling.org_catalog (
  org_id        TEXT PRIMARY KEY,                       -- → auth.organization.id
  ps_database   TEXT NOT NULL,                          -- PlanetScale database name (e.g. 'waddling-<orgslug>')
  state         TEXT NOT NULL DEFAULT 'provisioning'    -- provisioning|ready|error
                  CHECK (state IN ('provisioning','ready','error')),
  region        TEXT,                                   -- PlanetScale region slug (nullable = org default)
  -- Sealed Postgres DSN (libpq key=value, sslmode=verify-full) — the connection the
  -- gateway ATTACHes. NULL until the cluster is ready and a password is minted. Same
  -- AES-256-GCM envelope as waddling.endpoint_secret (see secret-crypto).
  dsn_iv         BYTEA,
  dsn_auth_tag   BYTEA,
  dsn_ciphertext BYTEA,
  last_error    TEXT,                                   -- last provisioning error (state='error')
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A managed catalog database holds MANY endpoints' DuckLake catalogs; each endpoint
-- gets its OWN DuckLake metadata schema inside the org's database so they don't stomp
-- each other. NULL for legacy / managed-local / byo-postgres endpoints. catalog_mode
-- gains 'managed-postgres' (the column is free-text, no CHECK to alter).
-- Guarded for re-run safety after 008 renames endpoint→datalake (post-rename the column
-- already lives on datalake → no-op).
DO $$
BEGIN
  IF to_regclass('waddling.endpoint') IS NOT NULL THEN
    ALTER TABLE waddling.endpoint
      ADD COLUMN IF NOT EXISTS catalog_schema TEXT;        -- DuckLake metadata schema within org_catalog.ps_database
  END IF;
END $$;
