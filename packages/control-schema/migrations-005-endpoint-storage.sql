-- Migration 005 — endpoint storage credentials (bring-your-own S3) + secret store.
-- Apply AFTER migrations-004. Idempotent. Run via seed.ts or:
--   psql $DATABASE_URL -f migrations-005-endpoint-storage.sql
--
-- DuckLake attaches an endpoint as two stores, each with its own DuckDB secret:
-- a `postgres` catalog secret and an `s3`/`r2`/`gcs` storage secret bundled by a
-- `ducklake` secret (DATA_PATH + METADATA_PARAMETERS). waddling provisions the
-- catalog (managed); the customer brings their own object-store bucket + creds.
-- Credentials (the SECRET access key, session token, BYO catalog DSN) are
-- envelope-encrypted (AES-256-GCM) in waddling.endpoint_secret — never plaintext.
-- The non-secret storage descriptor (endpoint host, region, url style, ssl) lives
-- on the endpoint row so the gateway can reconstruct config.s3 without decrypting.
-- Additive: the legacy plaintext catalog_dsn/server_token columns are left as-is
-- (new endpoints stop writing secrets to catalog_dsn — see api/cp/endpoints).

-- Guarded so the chain stays re-run-safe after migration 008 renames endpoint→datalake:
-- post-rename `endpoint` is gone (these columns/secret live on datalake/datalake_secret),
-- so this becomes a no-op. Pre-008 (legacy DB) it runs exactly as before.
DO $$
BEGIN
  IF to_regclass('waddling.endpoint') IS NOT NULL THEN
    ALTER TABLE waddling.endpoint
      ADD COLUMN IF NOT EXISTS storage_provider  TEXT,
      ADD COLUMN IF NOT EXISTS storage_endpoint  TEXT,
      ADD COLUMN IF NOT EXISTS storage_region    TEXT,
      ADD COLUMN IF NOT EXISTS storage_url_style TEXT,
      ADD COLUMN IF NOT EXISTS storage_use_ssl   BOOLEAN,
      ADD COLUMN IF NOT EXISTS catalog_mode      TEXT,
      ADD COLUMN IF NOT EXISTS catalog_file      TEXT;

    -- Envelope-encrypted secret material. One row per (endpoint, kind):
    --   'storage' → { keyId, secret, sessionToken? } ; 'catalog' → { dsn }
    -- iv/auth_tag/ciphertext are the AES-256-GCM parts (see secret-crypto). Renamed to
    -- waddling.datalake_secret by migration 008.
    CREATE TABLE IF NOT EXISTS waddling.endpoint_secret (
      endpoint_id  TEXT NOT NULL REFERENCES waddling.endpoint(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL CHECK (kind IN ('storage','catalog')),
      iv           BYTEA NOT NULL,
      auth_tag     BYTEA NOT NULL,
      ciphertext   BYTEA NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (endpoint_id, kind)
    );
  END IF;
END $$;
