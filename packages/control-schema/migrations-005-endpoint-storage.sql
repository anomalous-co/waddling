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

ALTER TABLE waddling.endpoint
  ADD COLUMN IF NOT EXISTS storage_provider  TEXT,     -- 'config' (static creds) | 'credential_chain'
  ADD COLUMN IF NOT EXISTS storage_endpoint  TEXT,     -- S3 endpoint host (R2/MinIO); NULL/'' = AWS default
  ADD COLUMN IF NOT EXISTS storage_region    TEXT,     -- 'auto', 'eu-north-1', …
  ADD COLUMN IF NOT EXISTS storage_url_style TEXT,     -- 'vhost' | 'path' (MinIO needs path)
  ADD COLUMN IF NOT EXISTS storage_use_ssl   BOOLEAN,  -- false for MinIO; true for R2/S3
  ADD COLUMN IF NOT EXISTS catalog_mode      TEXT,     -- 'managed-local' | 'byo-postgres' (NULL = legacy)
  ADD COLUMN IF NOT EXISTS catalog_file      TEXT;     -- local DuckLake catalog file (managed-local mode)

-- Envelope-encrypted secret material. One row per (endpoint, kind):
--   'storage' → { keyId, secret, sessionToken? }   (object-store creds)
--   'catalog' → { dsn }                             (BYO postgres catalog DSN)
-- Managed-local catalogs have no 'catalog' row; credential_chain storage has no
-- 'storage' row. iv/auth_tag/ciphertext are the AES-256-GCM parts (see secret-crypto).
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
