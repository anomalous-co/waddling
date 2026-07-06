/**
 * Stripe plans + entitlements catalog (ported from apps/waddling/src/lib/plans.ts).
 *
 * `getPlans()` is the source of truth for the per-plan entitlement LIMITS consumed
 * by entitlements.ts (requirePlan / getActivePlan / quota gates). Those gates read
 * only `entitlements` + `PLAN_ORDER` — never `priceId` — so the catalog stays
 * env-free here and its signatures are stable for the route wave.
 *
 * Workers difference vs the original: the original read Stripe price ids from env
 * (`getStripePricePro()`/`getStripePriceScale()`) at call time. On workerd
 * there is no module-load env, and the ONLY consumer of priceId — the
 * @better-auth/stripe `subscription.plans` array — is built by auth.ts's own
 * inlined `stripePlans(env)` (which threads env.STRIPE_PRICE_* directly). So this
 * module's `priceId` field has no live reader; it is left as a placeholder. The
 * `stripePlans()` helper below is preserved for signature compatibility but is
 * likewise unused by auth.ts.
 */
import type { Plan } from './types';

export type PlanName = Plan['name'];

/** Plan tiers in increasing order of capability. Index = rank for `requirePlan`. */
export const PLAN_ORDER: readonly PlanName[] = ['free', 'starter', 'pro', 'scale', 'enterprise'];

/**
 * Build the plan table (entitlement limits per tier). Functioned (not a frozen
 * const) to mirror the original; env-free here — see the module note on priceId.
 */
export function getPlans(): Plan[] {
  return [
    {
      name: 'free',
      priceId: '',
      monthlyCreditUsd: 5,
      entitlements: {
        endpoints: 1,
        agents: 2,
        dynamicAcl: false,
        adminMcp: false,
        auditRetentionDays: 7,
      },
    },
    {
      // 'starter' is the $15/mo entry tier — the personal data store. One data
      // lake plus the org's memory lake (kind='quackboard', exempt from the
      // endpoint quota — see datalakes.ts), 3 agents. `free` above stays as the
      // implicit default/lapsed floor; starter is the cheapest PURCHASABLE tier.
      // dynamicAcl MUST be true here: per-agent access control is the product's
      // core mechanic (advertised on the pricing page), not a Pro upsell — a
      // Starter org that can't grant its own agent anything is a broken product,
      // not a paywall. acl.ts's requirePlan('pro') gate only matters once
      // billingOn is true; before that this bug was silently dormant.
      name: 'starter',
      priceId: '',
      monthlyCreditUsd: 15,
      entitlements: {
        endpoints: 1,
        agents: 3,
        dynamicAcl: true,
        adminMcp: false,
        auditRetentionDays: 30,
      },
    },
    {
      name: 'pro',
      // priceId placeholder: the live Stripe price id is threaded into auth.ts's
      // own stripePlans(env) from env.STRIPE_PRICE_PRO; the entitlement gates that
      // read this catalog never look at priceId.
      priceId: '',
      monthlyCreditUsd: 49,
      entitlements: {
        endpoints: 5,
        agents: 25,
        dynamicAcl: true,
        adminMcp: true,
        auditRetentionDays: 90,
      },
    },
    {
      // 'scale' is the self-serve top tier — everything pro has, uncapped, billed
      // at $199/mo. Its live Stripe price id is threaded in via env.STRIPE_PRICE_SCALE.
      name: 'scale',
      priceId: '',
      monthlyCreditUsd: 199,
      entitlements: {
        endpoints: Number.POSITIVE_INFINITY,
        agents: Number.POSITIVE_INFINITY,
        dynamicAcl: true,
        adminMcp: true,
        auditRetentionDays: 365,
      },
    },
    {
      // 'enterprise' is sales-led (contact-us): dedicated isolated gateways, dedicated
      // R2, SSO/SAML, SLA — none of which is auto-provisionable yet, so there is NO
      // self-serve Stripe price (priceId stays ''; excluded from stripePlans). Its
      // entitlements mirror scale until the dedicated-tenancy gates exist; the monthly
      // credit is a negotiated baseline set per-contract.
      name: 'enterprise',
      priceId: '',
      monthlyCreditUsd: 199,
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

/** Convenience eager snapshot for imports that don't need fresh env. */
export const PLANS: Plan[] = getPlans();

export function getPlan(name: PlanName): Plan {
  const p = getPlans().find((x) => x.name === name);
  if (!p) throw new Error(`Unknown plan: ${name}`);
  return p;
}

/**
 * Shape the @better-auth/stripe plugin wants: `{ name, priceId }`. Preserved for
 * signature parity with the original; NOT a live caller this wave (auth.ts inlines
 * its own env-threaded version). Returns nothing while priceIds are placeholders.
 */
export function stripePlans(): { name: string; priceId: string }[] {
  return getPlans()
    .filter((p) => p.priceId) // free plan (and placeholder priceIds) have none
    .map((p) => ({ name: p.name, priceId: p.priceId }));
}
