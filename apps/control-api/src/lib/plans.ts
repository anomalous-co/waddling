/**
 * Plan catalog + entitlement limits.
 *
 * `getPlans()` is the source of truth for the per-plan entitlement LIMITS consumed by
 * entitlements.ts (requirePlan / getActivePlan / quota gates: seats, lakes, storage,
 * compute envelope). Those gates read only `entitlements` + `PLAN_ORDER` — never
 * `priceId` — so the catalog stays env-free here.
 *
 * Model: flat monthly base fee (`baseMonthlyUsd`, the Stripe subscription price) +
 * an included envelope (storage GB + compute Duckling-hours) + metered overage. The
 * live Stripe price ids are threaded into auth.ts's own `stripePlans(env)` from
 * env.STRIPE_PRICE_*, so `priceId` here is a placeholder with no live reader.
 */
import type { Plan } from './types';

export type PlanName = Plan['name'];

/** Plan tiers in increasing order of capability. Index = rank for `requirePlan`. */
export const PLAN_ORDER: readonly PlanName[] = ['free', 'pro', 'max', 'scale'];

export function getPlans(): Plan[] {
  return [
    {
      // Implicit floor: lapsed / no active subscription. Also the entitlement set the
      // 7-day no-card trial mirrors is 'pro' (see entitlements trial handling), NOT this.
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
      // $29/mo entry tier. dynamicAcl MUST be true — per-agent access control is the
      // product's core mechanic, not an upsell.
      name: 'pro',
      priceId: '',
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
      // $99/mo — teams. Adds the internal admin MCP server + more of everything.
      name: 'max',
      priceId: '',
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
      // $299/mo self-serve top tier — uncapped seats + lakes, largest envelope.
      name: 'scale',
      priceId: '',
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

/** Convenience eager snapshot for imports that don't need fresh env. */
export const PLANS: Plan[] = getPlans();

export function getPlan(name: PlanName): Plan {
  const p = getPlans().find((x) => x.name === name);
  if (!p) throw new Error(`Unknown plan: ${name}`);
  return p;
}
