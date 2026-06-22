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
 * COST BASIS (the locked decision): the dominant COGS is container memory × wall-clock
 * (~$0.10 / active session-hour), NOT query count; a small per-query floor covers the
 * cheap-but-nonzero request overhead. So the material debit is SESSION DURATION, charged
 * at session close (durable); the per-query floor is a minor best-effort top-up.
 *
 * These rates are the PRICING DIALS. They are currently set to the locked COGS basis
 * (i.e. billing ≈ at cost) pending a retail multiplier from the pricing team — tune here.
 */
import { query, withTransaction } from './db';
import { isOrgComped } from './comp';

/** µUSD per US dollar. Stripe cents → µUSD = cents × 10_000. */
export const MICRO_PER_USD = 1_000_000;

// ── Pricing dials (USD) ──────────────────────────────────────────────────────────
/** Session wall-clock rate. Locked COGS basis: ~$0.10 / active session-hour. */
export const SESSION_USD_PER_HOUR = 0.10;
/** Per-query floor — minor request overhead. Placeholder pending retail pricing. */
export const QUERY_FLOOR_USD = 0.0002;
/** Free-tier starter credit seeded on org creation. Also the M5 "free ceiling" knob. */
export const STARTER_GRANT_USD = 5.0;

// ── Derived µUSD constants ───────────────────────────────────────────────────────
export const SESSION_MICRO_PER_MS = (SESSION_USD_PER_HOUR * MICRO_PER_USD) / 3_600_000;
export const QUERY_FLOOR_MICRO = Math.round(QUERY_FLOOR_USD * MICRO_PER_USD);
export const STARTER_GRANT_MICRO = Math.round(STARTER_GRANT_USD * MICRO_PER_USD);

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
    const bal = await q<{ balance_micro: string }>(
      `SELECT balance_micro FROM waddling.credit_balance WHERE org_id = $1 FOR UPDATE`,
      [args.orgId],
    );
    const current = Number(bal.rows[0]?.balance_micro ?? 0);

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
      return { balanceMicro: current, applied: false };
    }

    const next = current + args.amountMicro;
    await q(
      `UPDATE waddling.credit_balance SET balance_micro = $2, updated_at = now()
        WHERE org_id = $1`,
      [args.orgId, next],
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
    ...opts,
  });
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
    // Balance exhausted — complimentary orgs (company domains) are never cut off.
    // Checked only here (not on every call) so the hot path stays a single cheap read.
    return await isOrgComped(orgId);
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
export async function debitSessionDuration(sessionId: string): Promise<void> {
  const row = await query<{
    org_id: string;
    started_at: string;
    ended_at: string | null;
    expires_at: string;
    billed_at: string | null;
  }>(
    `SELECT org_id, started_at, ended_at, expires_at, billed_at
       FROM waddling.agent_session WHERE id = $1`,
    [sessionId],
  );
  const s = row.rows[0];
  if (!s || !s.ended_at || s.billed_at) return; // only an unbilled, CLOSED session

  const startMs = Date.parse(s.started_at);
  const endMs = Math.min(Date.parse(s.ended_at), Date.parse(s.expires_at));
  const durationMs = Math.max(0, endMs - startMs);
  const micro = Math.round(durationMs * SESSION_MICRO_PER_MS);

  if (micro > 0) {
    await postEntry({
      orgId: s.org_id,
      amountMicro: -micro,
      entryType: 'debit',
      reason: 'session_duration',
      idempotencyKey: `session:${sessionId}`,
      refKind: 'session',
      refId: sessionId,
    });
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
export async function sweepExpiredSessions(): Promise<number> {
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
      await debitSessionDuration(r.id);
      debited++;
    } catch (e) {
      console.log(`[credits] sweep debit failed for ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return debited;
}
