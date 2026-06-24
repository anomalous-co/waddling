/**
 * Stripe plans + entitlements (§6, W1).
 *
 * `PLANS` is the single source of truth consumed by:
 *  - auth.ts        → maps to the @better-auth/stripe `subscription.plans` array
 *  - entitlements.ts → requirePlan / getActivePlan / entitlement gates
 *  - W5 pricing page → reads PLANS for display
 *
 * priceId placeholders come from env (lazy) so import never throws at build.
 */
import type { Plan } from './types';
import { getStripePricePro, getStripePriceScale } from './env';

export type PlanName = Plan['name'];

/** Plan tiers in increasing order of capability. Index = rank for `requirePlan`. */
export const PLAN_ORDER: readonly PlanName[] = ['free', 'pro', 'scale', 'enterprise'];

/**
 * Build the plan table. Functioned (not a frozen const) so price-id env vars are
 * read at call time, not module-eval time.
 */
export function getPlans(): Plan[] {
  return [
    {
      name: 'free',
      priceId: '',
      entitlements: {
        endpoints: 1,
        agents: 2,
        dynamicAcl: false,
        adminMcp: false,
        auditRetentionDays: 7,
      },
    },
    {
      name: 'pro',
      priceId: getStripePricePro(),
      entitlements: {
        endpoints: 5,
        agents: 25,
        dynamicAcl: true,
        adminMcp: true,
        auditRetentionDays: 90,
      },
    },
    {
      // Self-serve top tier — everything pro has, uncapped, $199/mo.
      name: 'scale',
      priceId: getStripePriceScale(),
      entitlements: {
        endpoints: Number.POSITIVE_INFINITY,
        agents: Number.POSITIVE_INFINITY,
        dynamicAcl: true,
        adminMcp: true,
        auditRetentionDays: 365,
      },
    },
    {
      // Sales-led (contact-us): dedicated gateways, dedicated R2, SSO/SAML, SLA.
      // No self-serve Stripe price — priceId stays '' so stripePlans() omits it.
      name: 'enterprise',
      priceId: '',
      entitlements: {
        endpoints: Number.POSITIVE_INFINITY,
        agents: Number.POSITIVE_INFINITY,
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

/** Shape the @better-auth/stripe plugin wants: `{ name, priceId }` (+ limits optional). */
export function stripePlans(): { name: string; priceId: string }[] {
  return getPlans()
    .filter((p) => p.priceId) // free plan has no Stripe price
    .map((p) => ({ name: p.name, priceId: p.priceId }));
}
