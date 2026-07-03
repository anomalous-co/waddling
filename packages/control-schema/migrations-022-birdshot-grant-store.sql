-- migrations-022-birdshot-grant-store.sql
--
-- birdshot literal GRANT/DENY-SQL store (spec §12/§13). Replaces the compiled
-- BirdshotSnapshot: the control plane writes literal GRANT/DENY/REVOKE/UNDENY SQL rows
-- here (datalake-scoped), and each per-datalake gateway ATTACHes this control DB read-only
-- as the protected `__birdshot` catalog and lazy-pulls ONLY its datalake's rows via
-- birdshot_set_grant_scope('<datalakeId>'). The `stmt` text is the single source of truth
-- AND what the UI renders verbatim ("this key's grants").
--
-- Tables live in the `public` schema so birdshot's default store_schema_="public" resolves
-- `__birdshot.public.__birdshot_grants` without extra config. Idempotent.

CREATE TABLE IF NOT EXISTS public.__birdshot_grants (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  datalake     text        NOT NULL,                    -- datalake_id scope (tenant isolation)
  grantee_kind text        NOT NULL CHECK (grantee_kind IN ('subject','role','public')),
  grantee      text        NOT NULL DEFAULT '',         -- '' for PUBLIC (never NULL — §12a)
  stmt         text        NOT NULL,                    -- literal GRANT/DENY/REVOKE/UNDENY SQL
  version      bigint      NOT NULL,                    -- monotonic per datalake (pull ORDER BY)
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The gateway's hydration pull is WHERE datalake=? AND grantee_kind=? AND grantee=? ORDER BY version.
CREATE INDEX IF NOT EXISTS birdshot_grants_pull_idx
  ON public.__birdshot_grants (datalake, grantee_kind, grantee, version);

CREATE TABLE IF NOT EXISTS public.__birdshot_meta (
  datalake text   PRIMARY KEY,          -- one epoch row per datalake
  epoch    bigint NOT NULL DEFAULT 0    -- bumped in the same txn as every grant mutation (§12d/§12f)
);
