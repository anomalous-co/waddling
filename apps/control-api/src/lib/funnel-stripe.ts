/**
 * Conversion-funnel event for subscription checkouts.
 *
 * The @better-auth/stripe plugin owns the subscription lifecycle (Checkout, the
 * `subscription` table, webhook verification). This module only listens — from the
 * plugin's awaited `onEvent` hook — for a settled subscription Checkout and emits the
 * `checkout_completed` funnel event, attached to the org owner so it lands in the same
 * person funnel as signup. It reads the row the plugin already wrote (onEvent fires
 * after the plugin's own handling) to resolve org + plan.
 *
 * Best-effort: never throws (a throw would 5xx the webhook and trigger Stripe retries),
 * and no-ops when POSTHOG_KEY is unset. The capture rides the webhook request's
 * executionCtx so the fire-and-forget POST survives past the response.
 */
import type Stripe from 'stripe';
import type { Env } from './env';
import { queryOne } from './db';
import { makePostHog } from './posthog';

type ExecutionCtx = { waitUntil(p: Promise<unknown>): void } | undefined;

interface SubLookup {
  plan: string | null;
  referenceId: string | null;
}
interface OwnerRow {
  userId: string;
}

export async function captureCheckoutCompletedEvent(
  env: Env,
  event: Stripe.Event,
  executionCtx: ExecutionCtx,
): Promise<void> {
  try {
    if (event.type !== 'checkout.session.completed') return;
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.mode !== 'subscription') return; // credit packs (mode=payment) → fulfillCreditPackEvent

    const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
    if (!subId) return;

    // The plugin has already upserted the subscription row keyed by the Stripe
    // subscription id → gives us the org (referenceId) and the plan name.
    const sub = await queryOne<SubLookup>(
      `SELECT plan, "referenceId" FROM "subscription" WHERE "stripeSubscriptionId" = $1`,
      [subId],
    ).catch(() => null);

    const orgId =
      sub?.referenceId ?? s.client_reference_id ?? (s.metadata?.orgId as string | undefined) ?? undefined;
    if (!orgId) return;
    const plan = sub?.plan ?? 'pro';

    // Attach the conversion to a person: the org owner. A funnel event with no
    // person can't join the signup→paid funnel, so skip if we can't resolve one.
    const owner = await queryOne<OwnerRow>(
      `SELECT "userId" FROM "member" WHERE "organizationId" = $1 AND role = 'owner' ORDER BY "createdAt" ASC LIMIT 1`,
      [orgId],
    ).catch(() => null);
    if (!owner?.userId) return;

    makePostHog(env, executionCtx).capture({
      distinctId: owner.userId,
      event: 'checkout_completed',
      properties: { plan, mrr_cents: s.amount_total ?? undefined },
      groups: { organization: orgId },
    });
  } catch {
    // analytics must never fail the webhook.
  }
}
