/**
 * Prepaid credit ledger — the financial source of truth for metered billing.
 *
 * Monetization is flat tiers + PREPAID credits: serving (a governed query/ETL, a live
 * session) draws down a balance; at zero we stop serving. Unlike waddling.usage_event
 * (a best-effort DISPLAY log drained in waitUntil), the debit path here is DURABLE and
 * IDEMPOTENT — a dropped waitUntil or a retried close must never leave the balance wrong,
 * because a balance that doesn't fall defeats the prepaid cutoff.
 *
 * UNIT: everything is integer µUSD (micro-dollars, 1e-6 USD). Money, not an invented
 * token — Stripe reconciles exactly (cents × 10,000). "Credits" is a display rate only.
 *
 * COST BASIS: the dominant COGS is container memory × wall-clock (~$0.10 / active
 * session-hour), NOT query count; a small per-query floor covers the cheap-but-nonzero
 * request overhead. So the material debit is SESSION DURATION, charged at session close
 * (durable); the per-query floor is a minor best-effort top-up.
 *
 * RETAIL: we bill at COGS × RETAIL_MARGIN (see docs/credit-unit-economics.md). The COGS
 * constant stays documented below so the margin is auditable; the DEBIT path uses the
 * retail-derived constants. Tune the margin / COGS here.
 */
import { query, withTransaction } from './db';
import { isOrgComped } from './comp';
import { getPlan, type PlanName } from './plans';
import { getActivePlanName, hasActivePaidSubscription } from './entitlements';
import { DUCKLING_USD_PER_HOUR, resolveComputeSize } from './compute-sizes';

/** µUSD per US dollar. Stripe cents → µUSD = cents × 10_000. */
export const MICRO_PER_USD = 1_000_000;

// ── Pricing dials (USD) ──────────────────────────────────────────────────────────
/** COGS basis for the base (Duckling) size: ~$0.11 / active session-hour. Cost, not price. */
export const SESSION_COGS_USD_PER_HOUR = 0.11;
/** Retail multiple over COGS — the gross-margin dial. ~5× ⇒ ~80% gross margin. */
export const RETAIL_MARGIN = 5;
/** Base (Duckling) billed rate = $0.55 / active session-hour — the base unit the included
 *  compute envelope is priced in. Larger workspace sizes (Mallard…Swan) bill at their own
 *  COMPUTE_SIZES rate; debitSessionDuration applies the session's recorded size. */
export const SESSION_USD_PER_HOUR = DUCKLING_USD_PER_HOUR;
/** Per-query floor at retail — minor request overhead ($0.0002 COGS × margin = $0.001). */
export const QUERY_FLOOR_USD = 0.0002 * RETAIL_MARGIN;

// ── Derived µUSD constants ───────────────────────────────────────────────────────
// Session duration is billed continuously by elapsed ms — finer than the per-second
// granularity the model promises; only the rate (above) is the retail dial.
export const SESSION_MICRO_PER_MS = (SESSION_USD_PER_HOUR * MICRO_PER_USD) / 3_600_000;
export const QUERY_FLOOR_MICRO = Math.round(QUERY_FLOOR_USD * MICRO_PER_USD);

/**
 * µUSD-per-ms duration rate for a session's compute size. Derived from the size's retail
 * $/hr (COMPUTE_SIZES via resolveComputeSize, which maps unknown/legacy → the Duckling
 * default). This is the single rate function BOTH the debit path and the reconcile pass use,
 * so a session bills — and re-derives — at the exact rate of the size it actually ran at.
 */
export function sessionMicroPerMs(computeSize: string | null | undefined): number {
  return (resolveComputeSize(computeSize).usdPerHour * MICRO_PER_USD) / 3_600_000;
}

export interface PostEntryArgs {
  orgId: string;
  /** Signed µUSD: + credit in (grant/refund), − debit (consumption). */
  amountMicro: number;
  entryType: 'grant' | 'debit' | 'refund' | 'adjustment' | 'expiry';
  reason: string;
  /** Dedupe handle — re-posts with the same (orgId, key) are no-ops. */
  idempotencyKey: string;
  refKind?: 'session' | 'query' | 'stripe_invoice' | 'credit_pack' | 'manual';
  refId?: string;
  createdBy?: string;
  /**
   * Which bucket a CREDIT (positive amount) lands in:
   *   'tier'  — the monthly allotment, RESET to the plan max each cycle (expires).
   *   'topup' — purchased prepaid credit, PERSISTS across resets. (default)
   * Debits (negative amount) ignore this and spend tier-first, then topup, so the
   * use-it-or-lose-it tier credit is consumed before paid credit.
   */
  bucket?: 'tier' | 'topup';
}

export interface PostEntryResult {
  /** Balance (µUSD) after this entry — or the unchanged balance if it was a dup. */
  balanceMicro: number;
  /** False when the (orgId, idempotencyKey) already existed (no-op replay). */
  applied: boolean;
}

/**
 * Append one immutable ledger entry and atomically move the cached balance.
 *
 * Locks the org's credit_balance row FOR UPDATE so concurrent debits for the same org
 * serialize (no lost updates). Idempotent: a duplicate idempotency_key returns the
 * current balance with applied=false and writes nothing. Runs in one transaction.
 */
export async function postEntry(args: PostEntryArgs): Promise<PostEntryResult> {
  return withTransaction(async (q) => {
    // Ensure the balance row exists, then lock it (serializes same-org debits).
    await q(
      `INSERT INTO waddling.credit_balance (org_id, balance_micro)
         VALUES ($1, 0) ON CONFLICT (org_id) DO NOTHING`,
      [args.orgId],
    );
    const bal = await q<{ tier_balance_micro: string; topup_balance_micro: string }>(
      `SELECT tier_balance_micro, topup_balance_micro
         FROM waddling.credit_balance WHERE org_id = $1 FOR UPDATE`,
      [args.orgId],
    );
    const tier = Number(bal.rows[0]?.tier_balance_micro ?? 0);
    const topup = Number(bal.rows[0]?.topup_balance_micro ?? 0);
    const currentTotal = tier + topup;

    // Idempotent insert — a replayed key writes nothing and leaves the balance alone.
    const ins = await q<{ id: string }>(
      `INSERT INTO waddling.credit_ledger
         (org_id, amount_micro, entry_type, reason, ref_kind, ref_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        args.orgId,
        args.amountMicro,
        args.entryType,
        args.reason,
        args.refKind ?? null,
        args.refId ?? null,
        args.idempotencyKey,
        args.createdBy ?? null,
      ],
    );
    if (ins.rows.length === 0) {
      return { balanceMicro: currentTotal, applied: false };
    }

    // Route the movement across buckets. A credit lands in `bucket` (default topup);
    // a debit spends the tier (expiring) bucket first, then topup (paid). topup may go
    // negative on overshoot — the cutoff accepts a one-charge overrun, same as before.
    let newTier = tier;
    let newTopup = topup;
    if (args.amountMicro >= 0) {
      if ((args.bucket ?? 'topup') === 'tier') newTier = tier + args.amountMicro;
      else newTopup = topup + args.amountMicro;
    } else {
      const debit = -args.amountMicro;
      const fromTier = Math.max(0, Math.min(tier, debit));
      newTier = tier - fromTier;
      newTopup = topup - (debit - fromTier);
    }
    const next = newTier + newTopup;
    await q(
      `UPDATE waddling.credit_balance
          SET tier_balance_micro = $2, topup_balance_micro = $3, balance_micro = $4, updated_at = now()
        WHERE org_id = $1`,
      [args.orgId, newTier, newTopup, next],
    );
    await q(`UPDATE waddling.credit_ledger SET balance_after = $2 WHERE id = $1`, [
      ins.rows[0]!.id,
      next,
    ]);
    return { balanceMicro: next, applied: true };
  });
}

/** Grant credits (starter grant, Stripe credit-pack mint, manual top-up). */
export async function grantCredits(
  orgId: string,
  amountMicro: number,
  reason: string,
  idempotencyKey: string,
  opts: { refKind?: PostEntryArgs['refKind']; refId?: string; createdBy?: string } = {},
): Promise<PostEntryResult> {
  return postEntry({
    orgId,
    amountMicro: Math.abs(amountMicro),
    entryType: 'grant',
    reason,
    idempotencyKey,
    bucket: 'topup', // grants here are credit-pack / manual top-ups — the persistent bucket
    ...opts,
  });
}

// ── Monthly tier-credit reset ─────────────────────────────────────────────────────
// Each tier's INCLUDED COMPUTE ENVELOPE (plans.ts includedComputeHours) is granted monthly
// as tier credit, priced at the Duckling base rate: N Duckling-hours × $0.55. Once per
// billing period the org's TIER bucket is SET to that allotment — unused tier credit
// expires; purchased top-ups (the topup bucket) are untouched. Usage draws it down at the
// running workspace's size rate; overage beyond the envelope is metered to Stripe. A
// lapsed/cancelled subscription resolves to 'free', so it resets to the free envelope.

/** The plan's monthly included-compute envelope in µUSD (includedComputeHours × Duckling $/hr). */
export function tierMonthlyMicro(planName: PlanName): number {
  const hours = getPlan(planName).entitlements.includedComputeHours;
  return Math.round(hours * DUCKLING_USD_PER_HOUR * MICRO_PER_USD);
}

/** Current billing period as 'YYYY-MM' (UTC) — the per-period idempotency stamp. */
export function currentBillingPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * SET the org's tier bucket to an absolute target (topup bucket untouched). Posts the
 * signed delta as one ledger entry — a grant when topping up to the allotment, an expiry
 * when clawing back unused tier credit. Idempotent on `idempotencyKey`: the per-period
 * key means a month's reset lands exactly once no matter how often the cron re-runs.
 */
export async function resetTierBucket(
  orgId: string,
  targetMicro: number,
  idempotencyKey: string,
  reason: string,
  createdBy = 'system',
): Promise<PostEntryResult> {
  return withTransaction(async (q) => {
    await q(
      `INSERT INTO waddling.credit_balance (org_id, balance_micro)
         VALUES ($1, 0) ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
    );
    const bal = await q<{ tier_balance_micro: string; topup_balance_micro: string }>(
      `SELECT tier_balance_micro, topup_balance_micro
         FROM waddling.credit_balance WHERE org_id = $1 FOR UPDATE`,
      [orgId],
    );
    const tier = Number(bal.rows[0]?.tier_balance_micro ?? 0);
    const topup = Number(bal.rows[0]?.topup_balance_micro ?? 0);
    const delta = targetMicro - tier;
    const entryType = delta > 0 ? 'grant' : delta < 0 ? 'expiry' : 'adjustment';

    const ins = await q<{ id: string }>(
      `INSERT INTO waddling.credit_ledger
         (org_id, amount_micro, entry_type, reason, ref_kind, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,'manual',$5,$6)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [orgId, delta, entryType, reason, idempotencyKey, createdBy],
    );
    if (ins.rows.length === 0) {
      return { balanceMicro: tier + topup, applied: false };
    }
    const next = targetMicro + topup;
    await q(
      `UPDATE waddling.credit_balance
          SET tier_balance_micro = $2, balance_micro = $3, updated_at = now()
        WHERE org_id = $1`,
      [orgId, targetMicro, next],
    );
    await q(`UPDATE waddling.credit_ledger SET balance_after = $2 WHERE id = $1`, [
      ins.rows[0]!.id,
      next,
    ]);
    return { balanceMicro: next, applied: true };
  });
}

/**
 * Reset one org's tier credit to its CURRENT plan's monthly allotment for `period`.
 * Resolves the live subscription (lapsed ⇒ free), so a downgraded org resets down. Also
 * the new-org seed: called from the org-create hook with the current period, so a fresh
 * free org gets its $5 immediately and the month's cron tick is then a no-op.
 */
export async function resetTierCreditsForOrg(
  orgId: string,
  period: string,
  createdBy = 'system',
): Promise<PostEntryResult> {
  const plan = await getActivePlanName(orgId);
  return resetTierBucket(
    orgId,
    tierMonthlyMicro(plan),
    `tier_reset:${orgId}:${period}`,
    'tier_reset',
    createdBy,
  );
}

/**
 * Cron driver: reset every org that hasn't been reset for `period` yet. The LEFT JOIN
 * filters to orgs missing this period's `tier_reset:<org>:<period>` ledger row, so after
 * the month's first sweep this is near-zero work. Returns the count reset this tick.
 */
export async function resetAllTierCredits(period: string): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT o.id FROM "organization" o
       LEFT JOIN waddling.credit_ledger l
         ON l.org_id = o.id
        AND l.idempotency_key = 'tier_reset:' || o.id || ':' || $1
      WHERE l.id IS NULL
      LIMIT 1000`,
    [period],
  );
  let reset = 0;
  for (const o of due.rows) {
    try {
      const res = await resetTierCreditsForOrg(o.id, period);
      if (res.applied) reset++;
    } catch (e) {
      console.log(
        `[credits] tier reset failed for ${o.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return reset;
}

/**
 * Pre-flight gate: does the org have credit left to serve?
 *
 * FAIL-OPEN when no balance row exists — an org that predates the ledger (or whose
 * starter grant hasn't landed) is never locked out; the gate only bites once a row
 * exists and has gone ≤ 0. New orgs get a starter grant on creation; existing orgs are
 * backfilled by a one-off script. (Fail-closed would risk a global outage on deploy
 * before backfill.) Cheap unlocked read — safe on the hot path.
 *
 * Also fails open on a QUERY error — most importantly a missing credit_balance relation
 * if this code ships before migration 014 applies. Without this catch the bare SELECT
 * would reject → handle() 500 → EVERY connect/query/etl fails. Same defensive stance as
 * entitlements.getActivePlanName (`.catch(() => null)` for the pre-migration subscription
 * table). Errors are logged, not silent, so a real DB problem is still observable.
 */
export async function hasCredit(orgId: string): Promise<boolean> {
  try {
    const r = await query<{ balance_micro: string }>(
      `SELECT balance_micro FROM waddling.credit_balance WHERE org_id = $1`,
      [orgId],
    );
    if (r.rows.length === 0) return true; // no row → fail-open (see doc above)
    if (Number(r.rows[0]!.balance_micro) > 0) return true;
    // Balance exhausted. Complimentary orgs (company domains) are never cut off.
    if (await isOrgComped(orgId)) return true;
    // Paid orgs (a real Stripe subscription) keep serving — overage is METERED to Stripe, not
    // paused. Only card-less trial/free orgs pause here. Checked only on exhaustion so the hot
    // path stays a single cheap read.
    return await hasActivePaidSubscription(orgId);
  } catch (e) {
    console.log(`[credits] hasCredit fail-open (DB error): ${e instanceof Error ? e.message : String(e)}`);
    return true; // never break the data path on a credits read
  }
}

/** Current balance in µUSD (0 if no row or on error — display only). */
export async function getBalanceMicro(orgId: string): Promise<number> {
  try {
    const r = await query<{ balance_micro: string }>(
      `SELECT balance_micro FROM waddling.credit_balance WHERE org_id = $1`,
      [orgId],
    );
    return Number(r.rows[0]?.balance_micro ?? 0);
  } catch (e) {
    console.log(`[credits] getBalanceMicro error: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * Debit one CLOSED session's wall-clock duration — the financially material charge —
 * and mark it billed. Idempotent on `session:<id>` (the real double-charge guard) and
 * additionally guarded by `billed_at`. Billable window is capped at expires_at so an
 * idle-but-open session the sweeper closes well past its TTL can't be overcharged.
 * A zero-duration session still gets `billed_at` set so the sweeper stops rescanning it.
 */
/** Callback to forward a session's compute OVERAGE (µUSD beyond the org's available balance)
 *  to Stripe. Injected so credits.ts stays Stripe-agnostic (wired in the cron handler). */
export type OverageReporter = (orgId: string, overageMicro: number, identifier: string) => Promise<void>;

export async function debitSessionDuration(
  sessionId: string,
  onOverage?: OverageReporter,
): Promise<void> {
  const row = await query<{
    org_id: string;
    started_at: string;
    ended_at: string | null;
    expires_at: string;
    billed_at: string | null;
    compute_size: string | null;
  }>(
    `SELECT org_id, started_at, ended_at, expires_at, billed_at, compute_size
       FROM waddling.agent_session WHERE id = $1`,
    [sessionId],
  );
  const s = row.rows[0];
  if (!s || !s.ended_at || s.billed_at) return; // only an unbilled, CLOSED session

  const startMs = Date.parse(s.started_at);
  const endMs = Math.min(Date.parse(s.ended_at), Date.parse(s.expires_at));
  const durationMs = Math.max(0, endMs - startMs);
  // Bill at the rate of the SIZE this session actually ran at (not the flat base rate).
  const micro = Math.round(durationMs * sessionMicroPerMs(s.compute_size));

  if (micro > 0) {
    // Overage = the part of this debit not covered by the balance BEFORE it (i.e. usage past
    // the included envelope). Read before posting so the meter gets exactly the excess.
    const beforeMicro = onOverage ? await getBalanceMicro(s.org_id) : 0;
    await postEntry({
      orgId: s.org_id,
      amountMicro: -micro,
      entryType: 'debit',
      reason: 'session_duration',
      idempotencyKey: `session:${sessionId}`,
      refKind: 'session',
      refId: sessionId,
    });
    if (onOverage) {
      const overageMicro = Math.max(0, micro - Math.max(0, beforeMicro));
      if (overageMicro > 0) await onOverage(s.org_id, overageMicro, `session:${sessionId}`);
    }
  }
  // Mark billed regardless (incl. zero-duration) so the sweeper won't rescan it.
  await query(`UPDATE waddling.agent_session SET billed_at = now() WHERE id = $1`, [sessionId]);
}

/**
 * Debit the per-query floor. Minor + best-effort (the locked cutoff already accepts a
 * one-query overshoot). Unique key per call — this is a top-up, not a dedupe target.
 */
export async function debitQueryFloor(
  orgId: string,
  sessionId: string,
  uniqueKey: string,
): Promise<void> {
  if (QUERY_FLOOR_MICRO <= 0) return;
  await postEntry({
    orgId,
    amountMicro: -QUERY_FLOOR_MICRO,
    entryType: 'debit',
    reason: 'query_floor',
    idempotencyKey: `query:${sessionId}:${uniqueKey}`,
    refKind: 'query',
    refId: sessionId,
  });
}

/**
 * The SINGLE duration-debit driver, run by the scheduled (cron) handler. Two passes:
 *
 *   1. Close abandoned sessions: any still 'active' past its TTL (the agent connected,
 *      maybe ran nothing, and never reconnected) → set expired + ended_at. Without this
 *      they'd accrue the dominant cost forever and never debit.
 *   2. Debit every CLOSED-but-unbilled session — uniformly covering all close paths
 *      (kill / supersede / expire-on-connect / the abandoned rows from pass 1). Because
 *      debiting is decoupled from the close paths, those paths stay latency-free and the
 *      charge always lands here within one cron interval. Bounded to a batch per tick.
 *
 * Returns the number of sessions debited this tick.
 */
export async function sweepExpiredSessions(onOverage?: OverageReporter): Promise<number> {
  // Pass 1 — close abandoned (expired-but-active) sessions.
  await query(
    `UPDATE waddling.agent_session
        SET status = 'expired', ended_at = now()
      WHERE status = 'active' AND expires_at < now()`,
  );

  // Pass 2 — debit any closed session not yet billed (batched).
  const unbilled = await query<{ id: string }>(
    `SELECT id FROM waddling.agent_session
      WHERE ended_at IS NOT NULL AND billed_at IS NULL
      ORDER BY ended_at
      LIMIT 500`,
  );
  let debited = 0;
  for (const r of unbilled.rows) {
    try {
      await debitSessionDuration(r.id, onOverage);
      debited++;
    } catch (e) {
      console.log(`[credits] sweep debit failed for ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return debited;
}

/** One row of metering drift — a billed session whose ledger debit doesn't match the
 *  duration we'd re-derive from the source `agent_session` row. */
export interface DebitDrift {
  sessionId: string;
  orgId: string;
  /** What the session-duration debit SHOULD be (µUSD, positive). */
  expectedMicro: number;
  /** What the ledger actually holds for `session:<id>` (µUSD, signed; null = no row). */
  ledgerMicro: number | null;
  kind: 'missing_debit' | 'amount_mismatch' | 'unexpected_debit';
}

export interface ReconcileResult {
  checked: number;
  drift: DebitDrift[];
}

/**
 * Reconciliation pass for metering integrity (ANO-67). Re-derives each billed
 * session's expected duration charge straight from the source `agent_session` row —
 * using the SAME formula as debitSessionDuration — and asserts a 1:1 match against the
 * `credit_ledger` debit keyed `session:<id>`. It only FLAGS drift (logs + returns a
 * report); it never writes a correcting entry, because an auto-correct is itself a new
 * double-charge vector — a human reviews drift and decides.
 *
 * Bounded to the most-recently-billed `limit` sessions per tick (a drift alarm, not a
 * full-history audit). Cheap, read-only; safe to run every cron tick.
 *
 * Caveat — rate history: expectation is re-derived at the session's recorded compute-size
 * rate (COMPUTE_SIZES[size].usdPerHour) as it stands TODAY. A session billed before a rate
 * change to that size (e.g. a retail-margin edit) will surface as `amount_mismatch` even
 * though its debit was correct at the time. So a non-empty drift report right after a rate
 * change is expected, not necessarily a bug; a clean "zero drift" is only meaningful for
 * sessions billed at today's rate for their size.
 */
export async function reconcileDebits(limit = 1000): Promise<ReconcileResult> {
  const rows = await query<{
    session_id: string;
    org_id: string;
    started_at: string;
    ended_at: string;
    expires_at: string;
    compute_size: string | null;
    ledger_micro: string | null;
  }>(
    `SELECT s.id AS session_id, s.org_id, s.started_at, s.ended_at, s.expires_at, s.compute_size,
            l.amount_micro AS ledger_micro
       FROM waddling.agent_session s
       LEFT JOIN waddling.credit_ledger l
         ON l.org_id = s.org_id AND l.idempotency_key = 'session:' || s.id
      WHERE s.billed_at IS NOT NULL AND s.ended_at IS NOT NULL
      ORDER BY s.billed_at DESC
      LIMIT $1`,
    [limit],
  );

  const drift: DebitDrift[] = [];
  for (const r of rows.rows) {
    // Identical derivation to debitSessionDuration so the expectation is byte-exact.
    const startMs = Date.parse(r.started_at);
    const endMs = Math.min(Date.parse(r.ended_at), Date.parse(r.expires_at));
    const durationMs = Math.max(0, endMs - startMs);
    // Re-derive at the SESSION'S recorded size rate — same function debitSessionDuration uses.
    const expectedMicro = Math.round(durationMs * sessionMicroPerMs(r.compute_size));
    const ledgerMicro = r.ledger_micro == null ? null : Number(r.ledger_micro);

    let kind: DebitDrift['kind'] | null = null;
    if (expectedMicro > 0 && ledgerMicro === null) {
      kind = 'missing_debit'; // a charge we owe but never posted (lost revenue)
    } else if (expectedMicro > 0 && ledgerMicro !== -expectedMicro) {
      kind = 'amount_mismatch'; // posted, but not the amount we'd re-derive
    } else if (expectedMicro === 0 && ledgerMicro !== null) {
      kind = 'unexpected_debit'; // zero-duration session that somehow got charged
    }
    if (kind) {
      drift.push({ sessionId: r.session_id, orgId: r.org_id, expectedMicro, ledgerMicro, kind });
    }
  }

  if (drift.length > 0) {
    console.log(
      `[credits] reconcile: ${drift.length}/${rows.rows.length} billed sessions DRIFTED — ` +
        drift
          .slice(0, 20)
          .map((d) => `${d.sessionId}(${d.kind} exp=${d.expectedMicro} got=${d.ledgerMicro})`)
          .join(', '),
    );
  } else {
    console.log(`[credits] reconcile: ${rows.rows.length} billed sessions OK (no drift).`);
  }
  return { checked: rows.rows.length, drift };
}
