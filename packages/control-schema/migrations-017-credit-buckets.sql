-- Migration 017 — split the cached credit balance into two buckets.
-- Apply AFTER 015. Idempotent + re-run-safe.
--
-- WHY: a tier is a monthly prepaid allotment that is RESET to the plan max each cycle
-- (unused tier credit expires), while purchased top-ups (credit packs) must PERSIST
-- across that reset. A single balance can't express "expire this part, keep that part",
-- so the cached balance splits in two:
--   tier_balance_micro   — the monthly allotment; SET to the plan's monthlyCreditUsd
--                          each billing period by lib/credits.resetTierCredits*.
--   topup_balance_micro  — credit-pack / manual top-ups; never touched by a reset.
-- balance_micro stays the cached TOTAL (tier + topup) so every existing reader
-- (hasCredit / getBalanceMicro / billing) is unchanged. Debits spend tier-first.

ALTER TABLE waddling.credit_balance
  ADD COLUMN IF NOT EXISTS tier_balance_micro  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS topup_balance_micro BIGINT NOT NULL DEFAULT 0;

-- Backfill: park any pre-existing balance in the PERSISTENT (topup) bucket so the first
-- monthly reset can't expire credit an org already holds; the reset then adds the tier
-- allotment on top. Runs once — the WHERE guard skips already-split rows on re-run.
UPDATE waddling.credit_balance
   SET topup_balance_micro = balance_micro,
       tier_balance_micro  = 0
 WHERE tier_balance_micro = 0
   AND topup_balance_micro = 0
   AND balance_micro <> 0;
