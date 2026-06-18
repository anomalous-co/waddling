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

  const name = (row?.plan ?? 'free').toLowerCase();
  return (PLAN_ORDER as readonly string[]).includes(name)
    ? (name as PlanName)
    : 'free';
}

export async function getActivePlan(orgId: string): Promise<Plan> {
  return getPlan(await getActivePlanName(orgId));
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
