/**
 * Plan entitlement gating (ported from apps/waddling/src/lib/entitlements.ts).
 *
 * `subscription` is owned by @better-auth/stripe; bound to an organization via
 * `referenceId = org_id`. We read it directly (lib/db pool) rather than through
 * the plugin API so server routes stay synchronous-ish and don't need a session.
 *
 * Free tier ⇒ no row (or a free-named row). Pro/Enterprise ⇒ active subscription.
 *
 * `requirePlan` throws `UpgradeRequiredError`; cp routes map it to
 * `402 {error:'upgrade_required'}` (via cp-shared's handle()).
 *
 * Ported as-is: this module reads no env — it queries the DB through `queryOne`
 * and ranks against the env-free PLAN_ORDER. cp-shared.ts imports the canonical
 * `UpgradeRequiredError` from here (its inline env-free copy was removed).
 */
import { queryOne } from './db';
import { getPlan, PLAN_ORDER, type PlanName } from './plans';
import type { Plan } from './types';

export class UpgradeRequiredError extends Error {
  readonly required: PlanName;
  readonly current: PlanName;
  constructor(required: PlanName, current: PlanName) {
    super(`This action requires the '${required}' plan (current: '${current}').`);
    this.name = 'UpgradeRequiredError';
    this.required = required;
    this.current = current;
  }
}

interface SubscriptionRow {
  plan: string | null;
  status: string | null;
}

/**
 * Resolve the org's active plan name. Defaults to 'free' when there's no active
 * paid subscription. A subscription is "active" if its status is active/trialing.
 */
export async function getActivePlanName(orgId: string): Promise<PlanName> {
  const row = await queryOne<SubscriptionRow>(
    `SELECT plan, status
       FROM "subscription"
      WHERE "referenceId" = $1
        AND status IN ('active','trialing')
      ORDER BY "periodEnd" DESC NULLS LAST
      LIMIT 1`,
    [orgId],
  ).catch(() => null); // subscription table may not exist before BA migration

  const name = (row?.plan ?? '').toLowerCase();
  if ((PLAN_ORDER as readonly string[]).includes(name) && name !== 'free') {
    return name as PlanName; // active/trialing paid subscription
  }

  // No active paid subscription — check the local 7-day no-card trial, which grants Pro
  // (org.trialEndsAt, set at org creation). Expired/absent ⇒ the free floor.
  const trial = await queryOne<{ trialEndsAt: string | null }>(
    `SELECT "trialEndsAt" FROM "organization" WHERE id = $1`,
    [orgId],
  ).catch(() => null);
  if (trial?.trialEndsAt && Date.parse(trial.trialEndsAt) > Date.now()) {
    return 'pro';
  }
  return 'free';
}

export async function getActivePlan(orgId: string): Promise<Plan> {
  return getPlan(await getActivePlanName(orgId));
}

/**
 * True if the org has an active PAID Stripe subscription (a real sub with a Stripe id, not a
 * local no-card trial). Paid orgs meter compute overage instead of pausing at envelope-zero;
 * trial/free orgs (no Stripe sub) pause. See credits.hasCredit + lib/metering.
 */
export async function hasActivePaidSubscription(orgId: string): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM "subscription"
      WHERE "referenceId" = $1 AND status IN ('active','trialing') AND "stripeSubscriptionId" IS NOT NULL
      LIMIT 1`,
    [orgId],
  ).catch(() => null);
  return !!row;
}

function rank(name: PlanName): number {
  return PLAN_ORDER.indexOf(name);
}

/** True if the org's plan is at least `min`. */
export async function hasPlanAtLeast(
  orgId: string,
  min: PlanName,
): Promise<boolean> {
  const current = await getActivePlanName(orgId);
  return rank(current) >= rank(min);
}

/**
 * Gate an action behind a minimum plan. Throws `UpgradeRequiredError` (→ 402)
 * when the org's plan is below `min`.
 */
export async function requirePlan(orgId: string, min: PlanName): Promise<void> {
  const current = await getActivePlanName(orgId);
  if (rank(current) < rank(min)) {
    throw new UpgradeRequiredError(min, current);
  }
}

/** Read a single entitlement value for the org's current plan. */
export async function getEntitlements(
  orgId: string,
): Promise<Plan['entitlements']> {
  return (await getActivePlan(orgId)).entitlements;
}

/** The boolean (feature-flag) entitlement keys — the ones `requireEntitlement` gates on. */
type BooleanEntitlement = {
  [K in keyof Plan['entitlements']]: Plan['entitlements'][K] extends boolean ? K : never;
}[keyof Plan['entitlements']];

/**
 * Gate an action behind a boolean feature entitlement (e.g. `dynamicAcl`, `adminMcp`) rather
 * than a raw plan rank. Prefer this over `requirePlan` for feature gates: it tracks the plan
 * CATALOG (plans.ts), so re-tiering a feature — say, making per-agent ACLs a `starter` perk —
 * needs no route edits. Throws `UpgradeRequiredError` (→ 402) naming the cheapest plan that
 * grants the entitlement.
 */
export async function requireEntitlement(
  orgId: string,
  key: BooleanEntitlement,
): Promise<void> {
  const current = await getActivePlanName(orgId);
  if (getPlan(current).entitlements[key]) return;
  const min = (PLAN_ORDER.find((n) => getPlan(n).entitlements[key]) ?? 'scale') as PlanName;
  throw new UpgradeRequiredError(min, current);
}
