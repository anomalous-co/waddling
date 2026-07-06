/**
 * Plan catalog + entitlements (control-plane render-side mirror).
 *
 * `PLANS` feeds:
 *  - auth.ts        → @better-auth/stripe `subscription.plans` (via `stripePlans()`)
 *  - entitlements.ts → requirePlan / getActivePlan / entitlement gates
 *
 * Model: flat base fee (`baseMonthlyUsd`, the Stripe subscription price) + included
 * envelope (storage GB + compute Duckling-hours) + metered overage. priceId comes from
 * env (lazy) so import never throws at build. Keep in sync with apps/control-api/src/lib/plans.ts.
 */
import type { Plan } from './types';
import { getStripePricePro, getStripePriceMax, getStripePriceScale } from './env';

export type PlanName = Plan['name'];

/** Plan tiers in increasing order of capability. Index = rank for `requirePlan`. */
export const PLAN_ORDER: readonly PlanName[] = ['free', 'pro', 'max', 'scale'];

/** Build the plan table. Functioned so price-id env vars are read at call time. */
export function getPlans(): Plan[] {
  return [
    {
      name: 'free',
      priceId: '',
      baseMonthlyUsd: 0,
      entitlements: {
        seats: 1,
        lakes: 1,
        storageGb: 5,
        includedComputeHours: 5,
        dynamicAcl: true,
        adminMcp: false,
        auditRetentionDays: 7,
      },
    },
    {
      name: 'pro',
      priceId: getStripePricePro(),
      baseMonthlyUsd: 29,
      entitlements: {
        seats: 3,
        lakes: 2,
        storageGb: 50,
        includedComputeHours: 25,
        dynamicAcl: true,
        adminMcp: false,
        auditRetentionDays: 30,
      },
    },
    {
      name: 'max',
      priceId: getStripePriceMax(),
      baseMonthlyUsd: 99,
      entitlements: {
        seats: 10,
        lakes: 10,
        storageGb: 500,
        includedComputeHours: 75,
        dynamicAcl: true,
        adminMcp: true,
        auditRetentionDays: 90,
      },
    },
    {
      name: 'scale',
      priceId: getStripePriceScale(),
      baseMonthlyUsd: 299,
      entitlements: {
        seats: Number.POSITIVE_INFINITY,
        lakes: Number.POSITIVE_INFINITY,
        storageGb: 2000,
        includedComputeHours: 200,
        dynamicAcl: true,
        adminMcp: true,
        auditRetentionDays: 365,
      },
    },
  ];
}

/** Convenience eager snapshot for UI imports that don't need fresh env. */
export const PLANS: Plan[] = getPlans();

export function getPlan(name: PlanName): Plan {
  const p = getPlans().find((x) => x.name === name);
  if (!p) throw new Error(`Unknown plan: ${name}`);
  return p;
}

/** Shape the @better-auth/stripe plugin wants: `{ name, priceId }`. Free has no price. */
export function stripePlans(): { name: string; priceId: string }[] {
  return getPlans()
    .filter((p) => p.priceId)
    .map((p) => ({ name: p.name, priceId: p.priceId }));
}
