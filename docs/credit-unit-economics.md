# Credit unit economics (ANO-57)

The calibration of record for Waddling's prepaid-credit billing: how COGS is modelled,
the retail rate, the tier allotments, and the reset/top-up semantics. Source of truth for
the constants in `apps/control-api/src/lib/credits.ts` and `src/lib/plans.ts`.

## Model in one line

Prepaid credits (µUSD), drawn down by **usage** (per-second of active session time).
A **tier** is a monthly subscription whose price equals the credit balance it **resets to**
each cycle. Ad-hoc **top-ups** add persistent credit on top. At zero balance, serving stops.

## COGS basis (~$0.10 / active session-hour)

The dominant cost is **container memory × wall-clock**, not query count. Per active session
the data plane runs a gateway (`standard-2`, 6 GiB) paired 1:1 with a workspace
(`standard-1`, 4 GiB) — 10 GiB memory + 20 GB disk provisioned.

| Component | Rate (Cloudflare) | Per session-hour |
|-----------|-------------------|------------------|
| Memory (provisioned, wall-clock) | $0.0000025 / GiB-s | 10 GiB → $0.090 |
| Disk (provisioned) | $0.00000007 / GB-s | 20 GB → $0.005 |
| CPU (active-usage only) | $0.00002 / vCPU-s | ~$0.006 @ ~20% util |
| **Total** | | **≈ $0.10 / session-hour**, memory-dominated |

A warm query is nearly free; **holding the container alive is the cost**, so the material
debit is session duration. Notes: **R2 egress ≈ $0** (R2 has no egress fee; real R2 COGS is
Class A/B ops + storage, and BYO-storage lakes put scan egress on the customer's S3).
Hyperdrive adds no line item; control-plane Postgres + the per-org QuackboardDO are fixed
costs amortized across orgs, not per-session debit drivers.

## Retail rate (5× margin → $0.50 / session-hour)

We bill at **COGS × `RETAIL_MARGIN` (5)** → **$0.50 / active session-hour** (~80% gross
margin). The per-query floor scales the same: $0.0002 COGS → **$0.001** retail. Billing is
continuous by elapsed session ms (finer than the per-second the model promises); only the
rate is the dial. Constants live in `credits.ts` (`SESSION_COGS_USD_PER_HOUR`,
`RETAIL_MARGIN`, `SESSION_USD_PER_HOUR`, `QUERY_FLOOR_USD`).

Sell-price sanity check (market comps, not our cost): byte-scan engines price R2 SQL
$2.50/TB, Athena $5/TB, BigQuery $6.25/TB scanned. Used only to bound a *future* per-byte
sell price; GA bills session-duration + query-floor, not bytes.

## Tiers (price = monthly credit allotment)

| Tier | $/mo | Monthly credit | Session-hrs @ $0.50/hr | Entitlements |
|------|------|----------------|------------------------|--------------|
| Free | $0 | $5 | 10 | 1 endpoint, 2 agents, 7d retention |
| Pro | $49 | $49 | 98 | 5 endpoints, 25 agents, dynamicAcl, adminMcp, 90d |
| Enterprise | $199 | $199 | 398 | ∞ endpoints/agents, dynamicAcl, adminMcp, 365d |

`monthlyCreditUsd` lives on each plan in `plans.ts`. The matching Stripe recurring prices
(and the one-time top-up prices) are created idempotently by
`scripts/stripe-setup-products.mjs` (lookup_keys `pro_monthly`, `enterprise_monthly`,
`credit_10/25/100`) and wired via `STRIPE_PRICE_*` env.

## Reset & top-up semantics (two buckets)

The cached balance splits into two buckets (`credit_balance.tier_balance_micro` +
`topup_balance_micro`; `balance_micro` stays the total — migration 017):

- **Tier bucket** — SET to the plan's `monthlyCreditUsd` each billing period
  (`resetTierCredits*`). **Unused tier credit expires** on reset.
- **Top-up bucket** — credit-pack / manual grants ($10 minimum). **Persists** across resets.
- **Debits spend tier-first, then top-up** — use-it-or-lose-it credit goes before paid.

The reset resolves the **live** plan (`getActivePlanName`, lapsed ⇒ free), is **idempotent
per period** (`tier_reset:<org>:<YYYY-MM>`), runs on the cron, and **seeds new orgs** from
the org-create hook (so a fresh free org gets $5 once, not a starter grant + a reset).

## Out of scope / follow-ups

- `credit-pricing.ts` per-`usage_event`-kind rate table is **ANO-68**, not this.
- Per-byte-scanned metering (DuckDB profiling) deferred post-GA.
- **Mid-cycle upgrades apply at the next reset** (the period key is taken for the current
  month). Immediate proration on a subscription event is a follow-up.
