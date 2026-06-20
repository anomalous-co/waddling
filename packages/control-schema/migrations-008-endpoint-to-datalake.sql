-- Migration 008 — rename the "endpoint" concept to "datalake". Apply AFTER 007.
-- Idempotent + re-run-safe (guarded so the whole migrate chain can run repeatedly).
--
-- WHY: an "endpoint" row fused two unrelated concepts — a DATALAKE (the durable data
-- source: catalog, storage, path, region, encryption, secrets) and a GATEWAY (ephemeral
-- compute that fronts it). The gateway is now a dynamically-scaled, scale-to-zero POOL of
-- replica containers (see apps/dataplane GatewayPoolDO), addressed by the datalake id —
-- there is no durable gateway row. So we keep ONE durable table, the datalake, and DROP
-- the dead gateway-compute columns (gateway_host, quack_port). server_token stays (it is
-- the datalake's birdshot authz secret, used to boot every replica).
--
-- VALUE-PRESERVING: only names change. Ids are untouched — the data-plane DO key, the
-- minted JWT `aud`, and every FK ride on the id VALUE, so renaming columns/tables does
-- not disturb the live gateway routing or birdshot validation.

DO $$
BEGIN
  -- ── Table: waddling.endpoint → waddling.datalake ──
  IF to_regclass('waddling.endpoint') IS NOT NULL AND to_regclass('waddling.datalake') IS NULL THEN
    ALTER TABLE waddling.endpoint RENAME TO datalake;
  END IF;

  -- ── Secrets: waddling.endpoint_secret → waddling.datalake_secret (+ FK column) ──
  IF to_regclass('waddling.endpoint_secret') IS NOT NULL AND to_regclass('waddling.datalake_secret') IS NULL THEN
    ALTER TABLE waddling.endpoint_secret RENAME TO datalake_secret;
  END IF;
  IF to_regclass('waddling.datalake_secret') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='waddling' AND table_name='datalake_secret' AND column_name='endpoint_id') THEN
    ALTER TABLE waddling.datalake_secret RENAME COLUMN endpoint_id TO datalake_id;
  END IF;

  -- ── FK columns endpoint_id → datalake_id (the referenced table rename auto-follows) ──
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='acl_rule' AND column_name='endpoint_id') THEN
    ALTER TABLE waddling.acl_rule RENAME COLUMN endpoint_id TO datalake_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='agent_session' AND column_name='endpoint_id') THEN
    ALTER TABLE waddling.agent_session RENAME COLUMN endpoint_id TO datalake_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='usage_event' AND column_name='endpoint_id') THEN
    ALTER TABLE waddling.usage_event RENAME COLUMN endpoint_id TO datalake_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='audit_event' AND column_name='endpoint_id') THEN
    ALTER TABLE waddling.audit_event RENAME COLUMN endpoint_id TO datalake_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='waddling' AND table_name='workspace' AND column_name='endpoint_id') THEN
    ALTER TABLE waddling.workspace RENAME COLUMN endpoint_id TO datalake_id;
  END IF;

  -- ── Drop the dead gateway-compute columns (now dynamic + ephemeral in the pool) ──
  IF to_regclass('waddling.datalake') IS NOT NULL THEN
    ALTER TABLE waddling.datalake DROP COLUMN IF EXISTS gateway_host;
    ALTER TABLE waddling.datalake DROP COLUMN IF EXISTS quack_port;
  END IF;
END $$;

-- Rename the ACL lookup index to match (idempotent).
ALTER INDEX IF EXISTS waddling.acl_rule_endpoint_agent_idx RENAME TO acl_rule_datalake_agent_idx;
