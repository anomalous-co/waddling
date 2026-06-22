-- Migration 014 — cached lake catalog per datalake (waddling.datalake_catalog).
-- Apply AFTER 008 (endpoint→datalake rename) and 013. Idempotent + re-run-safe.
--
-- WHY: the ACL authoring UI needs the REAL schemas/tables/columns of a datalake to
-- offer a validated picker (instead of error-prone free-text that produced grants
-- like `main.*` matching nothing). Only the data-plane gateway can introspect the
-- live lake (duckdb_columns()/duckdb_tables() over the ATTACHed DuckLake); the
-- control-api Worker has no lake egress. So control-api caches the gateway's
-- catalog snapshot here and serves it instantly for authoring.
--
--   snapshot      JSONB  — { schemas: [{ name, tables: [{ name,
--                          columns: [{ name, type, nullable }] }] }] }.
--                          NAMES + TYPES ONLY — never row data. This is a bounded
--                          management-metadata exception to the "control plane
--                          stores no agent data" rule: it is structural metadata
--                          required to MANAGE access, not lake contents.
--   content_hash  TEXT   — hash of the snapshot; lets the refresh path skip a write
--                          when the catalog is unchanged.
--   fetched_at    TIMESTAMPTZ — when the snapshot was last pulled from the gateway.
--
-- Freshness is event-driven: control-api re-fetches + upserts after every governed
-- catalog-mutating statement (CTAS/ETL/CREATE/DROP/ALTER) while the gateway is warm,
-- and on endpoint configure/warm. Boot-on-demand populates it the first time the
-- picker opens on a cold datalake.

DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NOT NULL
     AND to_regclass('waddling.datalake_catalog') IS NULL THEN
    CREATE TABLE waddling.datalake_catalog (
      datalake_id   TEXT PRIMARY KEY REFERENCES waddling.datalake(id) ON DELETE CASCADE,
      snapshot      JSONB       NOT NULL,
      content_hash  TEXT        NOT NULL,
      fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  END IF;
END $$;
