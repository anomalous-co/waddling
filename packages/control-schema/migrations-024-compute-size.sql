-- Migration 024 — per-workspace compute size (the metered-usage dimension).
-- Apply AFTER migrations-023. Idempotent.
--
-- A workspace runs at one of the COMPUTE_SIZES ladder rungs (duckling|mallard|goose|swan —
-- see apps/control-api/src/lib/compute-sizes.ts). The size drives the provisioned Cloud Run
-- cpu/memory AND the per-second session billing rate. Each session records the size it ran at
-- so debitSessionDuration / reconcileDebits can bill at the exact rate. Default 'duckling'
-- (the base unit the included-compute envelope is priced in) — no existing row changes rate.

ALTER TABLE waddling.workspace
  ADD COLUMN IF NOT EXISTS compute_size text NOT NULL DEFAULT 'duckling';

ALTER TABLE waddling.agent_session
  ADD COLUMN IF NOT EXISTS compute_size text NOT NULL DEFAULT 'duckling';
