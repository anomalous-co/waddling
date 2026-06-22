-- Migration 015 — prepaid credit ledger + cached balance.
-- Apply AFTER 014. Idempotent + re-run-safe.
--
-- WHY: monetization is flat tiers + PREPAID metered credits. Serving (a governed
-- query/ETL, a live session) draws down a credit balance; at zero we stop serving
-- (no postpaid dunning). This is the financial source of truth, so unlike
-- waddling.usage_event (a best-effort DISPLAY log) these rows are durable and exact.
--
-- UNIT OF ACCOUNT: amounts are integer **µUSD** (micro-dollars, 1e-6 USD) in BIGINT.
-- Money, not an invented "credit token" — so Stripe reconciles exactly (cents ×
-- 10,000 = µUSD). The customer-facing "credits" noun is a fixed display rate applied
-- in lib/credits.ts, never stored here. A signed `amount_micro`: positive = grant /
-- refund (credit in), negative = debit (consumption).
--
-- TWO TABLES:
--   credit_ledger  — append-only, immutable transaction log. Every mint and every
--                    debit is one row. UNIQUE(org_id, idempotency_key) makes every
--                    post idempotent: a retried Stripe webhook, a kill-then-expire
--                    double-close, or a sweeper re-run can never double-charge.
--   credit_balance — denormalized cached balance per org, the row the per-query/connect
--                    pre-flight reads (cheap) and that postEntry() locks FOR UPDATE to
--                    serialize concurrent debits. Always == SUM(ledger.amount_micro);
--                    the ledger is the source of truth, this is the fast path.

CREATE TABLE IF NOT EXISTS waddling.credit_ledger (
  id               BIGSERIAL PRIMARY KEY,
  org_id           TEXT NOT NULL,                 -- → auth.organization.id (no FK: cross-schema)
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Signed money movement in µUSD. + = credit in (grant/refund/adjustment up),
  -- − = debit (session_duration / query_floor / adjustment down).
  amount_micro     BIGINT NOT NULL,
  entry_type       TEXT NOT NULL
                     CHECK (entry_type IN ('grant','debit','refund','adjustment','expiry')),
  -- Human/agent-readable cause: 'starter_grant','credit_pack','session_duration',
  -- 'query_floor','stripe_refund','manual_adjustment', …
  reason           TEXT NOT NULL,
  -- What this entry references, for reconciliation back to its origin.
  ref_kind         TEXT,                          -- 'session'|'query'|'stripe_invoice'|'credit_pack'|'manual'
  ref_id           TEXT,
  -- Dedupe handle. Every post supplies one; ON CONFLICT (org_id, idempotency_key)
  -- DO NOTHING makes re-posts no-ops. e.g. 'session:<id>', 'stripe:<event_id>'.
  idempotency_key  TEXT NOT NULL,
  -- Running balance AFTER this entry was applied (µUSD). Set inside the same locked
  -- txn that updates credit_balance, so the ledger alone is a full audit trail.
  balance_after    BIGINT,
  created_by       TEXT,                          -- user/agent/system id that caused it
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS credit_ledger_org_ts_idx
  ON waddling.credit_ledger (org_id, ts DESC);

CREATE TABLE IF NOT EXISTS waddling.credit_balance (
  org_id        TEXT PRIMARY KEY,                 -- → auth.organization.id
  balance_micro BIGINT NOT NULL DEFAULT 0,        -- cached SUM(ledger.amount_micro), µUSD
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Duration-billing marker on agent_session. The session's wall-clock cost is the
-- dominant COGS and is debited by the scheduled sweeper (lib/credits.sweepExpiredSessions),
-- NOT inline at each close path — so the sweeper is the SINGLE debit driver and covers
-- kill / supersede / expire-on-connect / abandoned uniformly. `billed_at` marks a closed
-- session as already debited so the sweeper doesn't rescan it (postEntry's idempotency on
-- 'session:<id>' is the real double-charge guard; this is the cheap scan filter).
DO $$
BEGIN
  IF to_regclass('waddling.agent_session') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'waddling' AND table_name = 'agent_session' AND column_name = 'billed_at'
     ) THEN
    ALTER TABLE waddling.agent_session ADD COLUMN billed_at TIMESTAMPTZ;
  END IF;
END $$;
-- Partial index: the sweeper's "closed but unbilled" scan target.
CREATE INDEX IF NOT EXISTS agent_session_unbilled_idx
  ON waddling.agent_session (ended_at)
  WHERE billed_at IS NULL AND ended_at IS NOT NULL;
