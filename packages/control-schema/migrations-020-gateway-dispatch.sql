-- Migration 020 — durable control→gateway dispatch outbox.
-- Apply AFTER 019. Idempotent + re-run-safe.
--
-- WHY: ACL/policy edits and agent revokes pushed the gateway INLINE on the request,
-- best-effort with an empty catch and NO retry (lib/gateway-push.ts). Two costs:
--   1. Durability — a dropped /gw/snapshot or /gw/revoke silently left the gateway's
--      cached policy stale until a coincidental later connect/recompile re-pushed it.
--   2. Latency — every edit blocked on compileEndpointPolicy + a 45s-timeout push that
--      re-armed each warm replica, so editing access/url rules felt slow.
--
-- This table is the outbox that fixes both. Edits ENQUEUE here (fast, in the same
-- statement path as the rule mutation) and return; delivery happens off the request
-- path via an immediate waitUntil attempt + the control-api */5 cron drain (retry +
-- reconcile backstop). The drain RECOMPILES from current acl_rule/acl_policy state —
-- the snapshot is never stored here, so a burst of edits coalesces into ONE recompile
-- + push at drain (the real write-amplification win), and stale/out-of-order delivery
-- is impossible.
--
-- Two shapes share the table:
--   kind='snapshot' — COALESCING. At most one row per datalake (partial unique index);
--                     re-enqueue flips it back to 'pending' and bumps target_version.
--                     payload is NULL — the drain recompiles the full endpoint policy.
--   kind='revoke'   — DISCRETE + idempotent. One row per (datalake, subject); payload
--                     carries {kind,id,reason,expiresUs}. Deleted on delivery.
--
-- No hard FK to waddling.datalake: keep the migration re-run-safe and let the drain
-- skip rows whose datalake has since vanished (it resolves the endpoint per row).

DO $$
BEGIN
  IF to_regclass('waddling.datalake') IS NULL THEN
    RETURN; -- waddling schema not provisioned yet; nothing to attach the outbox to.
  END IF;

  CREATE TABLE IF NOT EXISTS waddling.gateway_dispatch (
    id              BIGSERIAL PRIMARY KEY,
    datalake_id     TEXT        NOT NULL,
    kind            TEXT        NOT NULL CHECK (kind IN ('snapshot', 'revoke')),
    -- snapshot: NULL (coalesce by datalake). revoke: the subject id (jti/user/session)
    -- so repeat revokes of the same subject dedupe to one pending row.
    dedup_key       TEXT,
    -- revoke: {kind,id,reason,expiresUs}. snapshot: NULL (recompiled at drain).
    payload         JSONB,
    -- snapshot: the policy_version we want the gateway to reach (advisory/telemetry).
    target_version  TEXT,
    status          TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts        INTEGER     NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
END $$;

-- Coalescing: at most ONE snapshot row per datalake (upserted on every enqueue).
CREATE UNIQUE INDEX IF NOT EXISTS gateway_dispatch_snapshot_uq
  ON waddling.gateway_dispatch (datalake_id)
  WHERE kind = 'snapshot';

-- Dedupe pending revokes per subject; delivered revokes are deleted, so the index
-- only ever guards live work.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_dispatch_revoke_pending_uq
  ON waddling.gateway_dispatch (datalake_id, dedup_key)
  WHERE kind = 'revoke' AND status = 'pending';

-- Drain scan: due, not-yet-delivered work, oldest first.
CREATE INDEX IF NOT EXISTS gateway_dispatch_due_idx
  ON waddling.gateway_dispatch (next_attempt_at)
  WHERE status = 'pending';
