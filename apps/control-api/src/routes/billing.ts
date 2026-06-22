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
import { z } from 'zod';
import Stripe from 'stripe';
import { Hono } from 'hono';
import { queryOne } from '../lib/db';
import { getActivePlan, getActivePlanName } from '../lib/entitlements';
import { getBalanceMicro, MICRO_PER_USD } from '../lib/credits';
import { isOrgComped } from '../lib/comp';
import { getPack, packPriceId, availablePacks } from '../lib/credit-packs';
import type { Env } from '../lib/env';
import { makePostHog } from '../lib/posthog';
import { resolveCaller, parseBody, handle, ok, err } from '../lib/cp-shared';

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
      // Conversion-funnel signal: a free org loaded the billing/upgrade surface.
      // Authoritative + non-spoofable (server-side), fire-and-forget via waitUntil
      // so it never blocks the read; no-op when POSTHOG_KEY is unset.
      makePostHog(c.env, c.executionCtx).capture({
        distinctId: caller.callerId,
        event: 'upgrade_viewed',
        properties: { from_plan: plan.name, surface: 'billing_page' },
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

    // Prepaid credit balance + the purchasable packs, for the top-up surface.
    const balanceMicro = await getBalanceMicro(caller.orgId);
    const comped = await isOrgComped(caller.orgId);
    return ok(c, {
      plan: planInfo,
      entitlements: plan.entitlements,
      invoices: [] as Invoice[],
      comped,
      credit: { balanceMicro, balanceUsd: balanceMicro / MICRO_PER_USD },
      creditPacks: availablePacks(c.env),
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

/**
 * GET /status — the payment-onboarding gate's source of truth.
 *
 * "Has paid" (→ may enter the dashboard) = an active/trialing subscription OR at least
 * one purchased credit pack. It is ledger EXISTENCE (`reason='credit_pack'`), not
 * balance > 0 — an org that bought a pack and spent it to zero has still paid. The $5
 * starter grant uses a different reason and is excluded.
 *
 * Unlike every other cp route this passes `requireOrg=false`: a freshly-signed-up user
 * with no org must get `{hasOrg:false}` (so the gate routes them to org-creation) rather
 * than a 403 it can't interpret. No PostHog side-effect here (cf. GET /), so it is safe
 * to call from SSR on every dashboard render.
 */
billing.get('/status', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, false);
    if (!caller.orgId) return ok(c, { hasOrg: false, paid: false, comped: false });
    // Complimentary orgs (company domains) are free forever — paid regardless of plan.
    const comped = await isOrgComped(caller.orgId);
    const planName = await getActivePlanName(caller.orgId);
    const subscribed = planName === 'pro' || planName === 'enterprise';
    const boughtPack = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM waddling.credit_ledger
        WHERE org_id = $1 AND reason = 'credit_pack' LIMIT 1`,
      [caller.orgId],
    ).catch(() => null);
    const paid = comped || subscribed || !!boughtPack;
    return ok(c, { hasOrg: true, paid, comped });
  }),
);

const CreditPackSchema = z.object({
  packId: z.string().min(1),
  // App-relative return path for the Checkout success/cancel redirect (e.g.
  // '/onboarding?step=confirming'). Must start with a single '/' (open-redirect guard);
  // defaults to the billing settings tab.
  returnPath: z
    .string()
    .regex(/^\/(?!\/)/, 'returnPath must be an app-relative path starting with "/"')
    .optional(),
});

/**
 * POST /credit-pack — start a one-time Stripe Checkout to buy a prepaid credit pack.
 *
 * Returns a Checkout URL; the dashboard redirects to it. Credits are NOT granted here —
 * fulfillment is on the webhook (`fulfillCreditPackEvent` via the stripe plugin's onEvent),
 * keyed on the session id so a closed tab / redelivery still grants exactly once.
 *
 * TODO(ANO-80): gate to admin+ once resolveCaller exposes org role (billing-manage = admin+).
 */
billing.post('/credit-pack', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const { packId, returnPath } = await parseBody(c, CreditPackSchema);
    const pack = getPack(packId);
    if (!pack) return err(c, 'unknown_pack', 400, `No such credit pack: ${packId}`);
    const priceId = packPriceId(c.env, pack);
    if (!priceId) {
      return err(c, 'billing_not_configured', 409, 'Credit packs are not configured for this deployment yet.');
    }

    const web = (c.env.WEB_ORIGIN ?? '').split(',')[0]?.trim() || c.env.BETTER_AUTH_URL;
    // App-relative return target (validated to start with a single '/'); the onboarding
    // gate passes '/onboarding?step=confirming', the settings tab '/dashboard/settings?tab=billing'.
    const ret = returnPath ?? '/dashboard/billing';
    const sep = ret.includes('?') ? '&' : '?';
    // Per-request Stripe client (workerd: fetch HTTP client; never module-cache it).
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${web}${ret}${sep}topup=success`,
        cancel_url: `${web}${ret}${sep}topup=cancel`,
        // Belt-and-suspenders org binding for fulfillment (metadata + client_reference_id).
        client_reference_id: caller.orgId,
        metadata: { orgId: caller.orgId, packId: pack.id, kind: 'credit_pack' },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    return ok(c, { url: session.url });
  }),
);

const CheckoutIntentSchema = z.object({ toPlan: z.enum(['pro', 'enterprise']) });

/**
 * POST /checkout-intent — record that the user is starting a subscription checkout,
 * just before the dashboard redirects to the Better-Auth/Stripe upgrade flow
 * (`/api/auth/subscription/upgrade`). Server-side so the conversion event is
 * non-spoofable; fire-and-forget so it never delays the redirect. No Stripe call
 * here — this only emits the funnel event; the actual Checkout is the plugin's.
 */
billing.post('/checkout-intent', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const { toPlan } = await parseBody(c, CheckoutIntentSchema);
    const from = await getActivePlan(caller.orgId);
    makePostHog(c.env, c.executionCtx).capture({
      distinctId: caller.callerId,
      event: 'checkout_started',
      properties: { to_plan: toPlan, from_plan: from.name },
      groups: { organization: caller.orgId },
    });
    return ok(c, { ok: true });
  }),
);

export { billing };
