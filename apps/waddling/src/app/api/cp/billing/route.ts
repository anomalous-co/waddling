/**
 * /api/cp/billing (W1) — org billing summary (§5, §6).
 *
 * Checkout / portal / cancel are owned by the @better-auth/stripe plugin under
 * `/api/auth/subscription/*` (upgrade, billing-portal, cancel, list) and the
 * webhook at `/api/auth/stripe/webhook`. This route gives the dashboard a single
 * consolidated read: current plan + entitlements + active subscription + the
 * canonical action paths (so W2 doesn't hard-code Better Auth URLs).
 *
 * GET → { plan, entitlements, subscription, actions }.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { getActivePlan } from '@/lib/entitlements';
import { getPostHogServer } from '@/lib/posthog-server';
import { resolveCaller, handle, ok } from '../_shared';

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const plan = await getActivePlan(caller.orgId);

    // upgrade_viewed: the dashboard loads /api/cp/billing when showing the
    // billing page. Emit once per GET when the user is on the free plan so
    // the funnel captures top-of-upgrade-flow intent.
    // TODO: checkout_started → fire from dashboard when user clicks upgrade
    //   (client-side posthog.capture or a thin POST to /api/cp/billing/checkout-started).
    // TODO: checkout_completed → fire from @better-auth/stripe webhook handler
    //   (customer.subscription.created / invoice.payment_succeeded) — requires
    //   either a stripe plugin callback (onSubscriptionComplete if the plugin
    //   exposes it) or a thin catch-all in /api/auth/[...all]/route.ts that
    //   we don't own.
    if (plan.name === 'free') {
      getPostHogServer().capture({
        distinctId: caller.callerId,
        event: 'upgrade_viewed',
        properties: { current_plan: 'free', surface: 'billing_page' },
        groups: { organization: caller.orgId },
      });
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

    return ok({
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
  });
}
