/**
 * /api/cp/billing — Hono port of apps/waddling/src/app/api/cp/billing/route.ts.
 * Org billing summary (§5, §6).
 *
 * Checkout / portal / cancel are owned by the @better-auth/stripe plugin under
 * `/api/auth/subscription/*` (upgrade, billing-portal, cancel, list) and the
 * webhook at `/api/auth/stripe/webhook`. This route gives the dashboard a single
 * consolidated read: current plan + entitlements + active subscription + the
 * canonical action paths (so the dashboard doesn't hard-code Better Auth URLs).
 *
 * GET → { plan, entitlements, subscription, actions }.
 *
 * No Stripe client is constructed here: the handler only reads the `subscription`
 * row (owned by @better-auth/stripe, via lib/db) and returns the plugin's action
 * paths as strings. The actual checkout/portal operations run through the Better
 * Auth handler at /api/auth/subscription/*, where the stripe client is built with
 * Stripe.createFetchHttpClient() (see lib/auth.ts) — those need a REAL Stripe key
 * to function against live Stripe; the placeholder key in env is enough to read this
 * summary (it touches no Stripe API).
 */
import { Hono } from 'hono';
import { queryOne } from '../lib/db';
import { getActivePlan } from '../lib/entitlements';
import type { Env } from '../lib/env';
import { resolveCaller, handle, ok } from '../lib/cp-shared';

interface SubRow {
  plan: string | null;
  status: string | null;
  stripeSubscriptionId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
}

/** Mirrors the dashboard billing page's PlanInfo / Invoice shapes. */
interface PlanInfo {
  name: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
}
interface Invoice {
  id: string;
  amount: number;
  currency: string;
  status: string;
  date: string;
  url?: string;
}

const billing = new Hono<{ Bindings: Env }>();

billing.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const plan = await getActivePlan(caller.orgId);

    if (plan.name === 'free') {
      // deferred (Stage C/D): server-side analytics for 'upgrade_viewed'
      // (current_plan:free, surface:billing_page). The original called
      // getPostHogServer().capture, a Node-only posthog-node path that does not
      // bundle/run on workerd (see auth.ts neutered hooks). captureAgentEvent is
      // agent-principal-only and does not fit this user-funnel event.
    }

    const sub = await queryOne<SubRow>(
      `SELECT plan, status, "stripeSubscriptionId", "periodStart", "periodEnd", "cancelAtPeriodEnd"
         FROM "subscription"
        WHERE "referenceId" = $1
        ORDER BY "periodEnd" DESC NULLS LAST
        LIMIT 1`,
      [caller.orgId],
    ).catch(() => null);

    // Shape matches the dashboard's BillingData: `plan` is an object (PlanInfo)
    // with name + subscription status, plus an `invoices` list. Invoices come
    // from Stripe in a configured deployment; the demo has none, so [].
    const subStatus = (sub?.status as PlanInfo['status'] | undefined) ?? 'active';
    const planInfo: PlanInfo = {
      name: plan.name,
      status: subStatus,
      currentPeriodEnd: sub?.periodEnd ?? undefined,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    };

    return ok(c, {
      plan: planInfo,
      entitlements: plan.entitlements,
      invoices: [] as Invoice[],
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            subscriptionId: sub.stripeSubscriptionId,
            periodStart: sub.periodStart,
            periodEnd: sub.periodEnd,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
          }
        : null,
      // Better-Auth/Stripe plugin endpoints the dashboard POSTs to (referenceId=orgId).
      actions: {
        upgrade: '/api/auth/subscription/upgrade',
        portal: '/api/auth/subscription/billing-portal',
        cancel: '/api/auth/subscription/cancel',
        list: '/api/auth/subscription/list',
      },
    });
  }),
);

export { billing };
