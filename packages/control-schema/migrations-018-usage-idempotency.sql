-- Migration 018 — make billable usage_event ingest idempotent.
-- Apply AFTER 015. Idempotent + re-run-safe.
--
-- WHY: usage_event is the metering trail behind real prepaid billing (ANO-67). The
-- query/etl paths record one row per executed statement from a best-effort waitUntil;
-- a worker retry or webhook-style redelivery could insert the same logical event twice
-- (= over-count). The control plane now mints one stable `queryId` per /query and /etl
-- call and threads it here as `idempotency_key`, so a replay is a no-op (UNIQUE), and
-- the same id keys the per-query floor debit (lib/credits.debitQueryFloor →
-- ref_id query_floor:<queryId>) — giving a 1:1 usage_event ↔ ledger-debit linkage.
--
-- The key is NULLABLE: legacy rows (and the un-debited quackboard path, which passes a
-- stable key too but is not billed) carry one; rows predating this migration stay NULL.
-- A PARTIAL unique index enforces uniqueness only over non-null keys, so the backfilled
-- NULLs never collide.

ALTER TABLE waddling.usage_event
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS usage_event_idem_uq
  ON waddling.usage_event (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
