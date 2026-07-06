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
  name: 'free' | 'pro' | 'max' | 'scale';
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

    // Included-compute envelope remaining (µUSD ledger balance, re-denominated).
    const balanceMicro = await getBalanceMicro(caller.orgId);
    const comped = await isOrgComped(caller.orgId);

    // Local 7-day no-card trial (grants Pro). `active` ⇒ show "trial — N days left" and the
    // "add a card to keep Pro" conversion CTA; there is no Stripe subscription yet.
    const trialRow = await queryOne<{ trialEndsAt: string | null }>(
      `SELECT "trialEndsAt" FROM "organization" WHERE id = $1`,
      [caller.orgId],
    ).catch(() => null);
    const trialEndsAt = trialRow?.trialEndsAt ?? null;
    const trialActive = !!trialEndsAt && Date.parse(trialEndsAt) > Date.now() && !sub;

    return ok(c, {
      plan: planInfo,
      entitlements: plan.entitlements,
      invoices: [] as Invoice[],
      comped,
      trial: { endsAt: trialEndsAt, active: trialActive },
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
    const subscribed = planName !== 'free';
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

// ── Embedded subscription checkout (Stripe Elements) ─────────────────────────
//
// The @better-auth/stripe plugin only speaks HOSTED Checkout (returns a redirect
// url). To mount a Payment Element IN-PAGE we create the Stripe subscription here
// and hand back a client secret for the Element to confirm. Reconciliation into the
// `subscription` row that entitlements read is the plugin's: we mint + persist
// organization.stripeCustomerId, then create the subscription on that org customer
// with a configured plan price, so the plugin's `customer.subscription.created`
// webhook resolves the org (findReferenceByStripeCustomerId, enabled by the stripe
// plugin's `organization: { enabled: true }` option) and writes the row. Portal /
// cancel / plan-switch stay on the plugin; only the free→paid card entry is embedded.

const SubscriptionCheckoutSchema = z.object({ plan: z.enum(['pro', 'max', 'scale']) });

type SelfServePlan = 'pro' | 'max' | 'scale';

function priceForPlan(env: Env, plan: SelfServePlan): string {
  return { pro: env.STRIPE_PRICE_PRO, max: env.STRIPE_PRICE_MAX, scale: env.STRIPE_PRICE_SCALE }[plan];
}

/** Metered subscription items (compute + storage overage) attached alongside the base price.
 *  Metered ⇒ no upfront charge; usage is reported to their Billing Meters. Skipped when a
 *  price id is unset/placeholder so a partially-configured env still creates the base sub. */
function meteredItems(env: Env): { price: string }[] {
  const items: { price: string }[] = [];
  for (const p of [env.STRIPE_PRICE_COMPUTE, env.STRIPE_PRICE_STORAGE]) {
    if (p && !/placeholder/i.test(p)) items.push({ price: p });
  }
  return items;
}

/** billing-manage = org owner/admin (mirrors the plugin's authorizeReference). */
async function isBillingManager(caller: { callerId: string; orgId: string }): Promise<boolean> {
  const row = await queryOne<{ role: string }>(
    `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
    [caller.callerId, caller.orgId],
  ).catch(() => null);
  return !!row && (row.role === 'owner' || row.role === 'admin');
}

/** The org's live subscription (active/trialing) Stripe id, or null. */
async function activeSubscriptionId(orgId: string): Promise<string | null> {
  const row = await queryOne<{ stripeSubscriptionId: string | null }>(
    `SELECT "stripeSubscriptionId" FROM "subscription"
      WHERE "referenceId" = $1 AND status IN ('active','trialing')
      ORDER BY "periodEnd" DESC NULLS LAST LIMIT 1`,
    [orgId],
  ).catch(() => null);
  return row?.stripeSubscriptionId ?? null;
}

/**
 * Return the org's Stripe customer id, minting + persisting one if absent. Mirrors
 * the plugin's own customer creation (metadata.referenceId is what
 * findReferenceByStripeCustomerId resolves back to). The conditional UPDATE guards
 * against two concurrent create calls double-minting: the loser deletes its extra
 * customer and adopts the winner's.
 */
async function ensureOrgStripeCustomer(
  stripe: Stripe,
  orgId: string,
): Promise<string> {
  const row = await queryOne<{ stripeCustomerId: string | null; name: string | null }>(
    `SELECT "stripeCustomerId", name FROM "organization" WHERE id = $1`,
    [orgId],
  ).catch(() => null);
  if (row?.stripeCustomerId) return row.stripeCustomerId;

  const customer = await stripe.customers.create({
    name: row?.name ?? undefined,
    metadata: { referenceId: orgId, organizationId: orgId },
  });
  const won = await queryOne<{ stripeCustomerId: string | null }>(
    `UPDATE "organization" SET "stripeCustomerId" = $1
       WHERE id = $2 AND "stripeCustomerId" IS NULL
       RETURNING "stripeCustomerId"`,
    [customer.id, orgId],
  ).catch(() => null);
  if (won?.stripeCustomerId) return won.stripeCustomerId;

  // Lost the race (or no org row): adopt whoever won and discard our extra customer.
  const winner = await queryOne<{ stripeCustomerId: string | null }>(
    `SELECT "stripeCustomerId" FROM "organization" WHERE id = $1`,
    [orgId],
  ).catch(() => null);
  if (winner?.stripeCustomerId && winner.stripeCustomerId !== customer.id) {
    await stripe.customers.del(customer.id).catch(() => {});
    return winner.stripeCustomerId;
  }
  return customer.id;
}

/**
 * POST /subscription-checkout — create an unconfirmed subscription and return the
 * client secret for an in-page Payment/Setup Element to confirm.
 *
 * Owner/admin only. Free/trial→paid conversion ONLY: if the org already has an active or
 * trialing Stripe subscription this 409s (plan switches go through /subscription-change,
 * which needs no new card). Returns the first invoice's PaymentIntent client secret for an
 * in-page Payment Element to confirm. The 7-day trial is LOCAL (org.trialEndsAt) — there is
 * no Stripe trial subscription, so this always creates a real, immediately-charged sub.
 */
billing.post('/subscription-checkout', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isBillingManager(caller))) {
      return err(c, 'forbidden', 403, 'Only an organization owner or admin can manage billing.');
    }

    const { plan } = await parseBody(c, SubscriptionCheckoutSchema);
    const priceId = priceForPlan(c.env, plan);
    if (!priceId || /placeholder/i.test(priceId)) {
      return err(c, 'billing_not_configured', 409, `No Stripe price configured for the ${plan} plan.`);
    }

    // Double-billing guard — check the ENTITLEMENTS source of truth, not Stripe. A
    // legacy org that subscribed via the old hosted flow has a user-scoped customer,
    // so a Stripe list on the org customer would miss it and we'd create a second live
    // subscription. The `subscription` row (referenceId=orgId) spans every customer scope.
    const live = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM "subscription"
        WHERE "referenceId" = $1 AND status IN ('active','trialing') LIMIT 1`,
      [caller.orgId],
    ).catch(() => null);
    if (live) {
      return err(c, 'already_subscribed', 409, 'This organization already has an active subscription.');
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const customerId = await ensureOrgStripeCustomer(stripe, caller.orgId);

    // Sweep abandoned incompletes on the org customer so retries don't stack duplicates.
    const existing = await stripe.subscriptions.list({ customer: customerId, status: 'incomplete', limit: 20 });
    for (const s of existing.data) {
      await stripe.subscriptions.cancel(s.id).catch(() => {});
    }

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }, ...meteredItems(c.env)],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.confirmation_secret', 'pending_setup_intent'],
      metadata: { referenceId: caller.orgId },
    });

    const invoice = sub.latest_invoice;
    const clientSecret =
      invoice && typeof invoice === 'object' ? invoice.confirmation_secret?.client_secret ?? null : null;
    if (!clientSecret) {
      return err(c, 'stripe_no_payment_intent', 502, 'Stripe returned no payment intent for the subscription.');
    }
    return ok(c, { type: 'payment' as const, clientSecret, subscriptionId: sub.id });
  }),
);

// ── Manage an existing subscription (in-app modal, no hosted portal) ─────────
const SubscriptionChangeSchema = z.object({ plan: z.enum(['pro', 'max', 'scale']) });

/**
 * POST /subscription-change — switch an existing subscription to a higher tier.
 *
 * Owner/admin only. The card is already on file, so no Elements — we update the
 * Stripe subscription item to the new price with proration. During a trial there's
 * no immediate charge (the plan just changes and the trial continues); on an active
 * sub Stripe prorates against the saved card. The plugin's `onSubscriptionUpdated`
 * webhook reconciles the new plan into the local row that entitlements read.
 */
billing.post('/subscription-change', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isBillingManager(caller))) {
      return err(c, 'forbidden', 403, 'Only an organization owner or admin can manage billing.');
    }
    const { plan } = await parseBody(c, SubscriptionChangeSchema);
    const priceId = priceForPlan(c.env, plan);
    if (!priceId || /placeholder/i.test(priceId)) {
      return err(c, 'billing_not_configured', 409, `No Stripe price configured for the ${plan} plan.`);
    }
    const subId = await activeSubscriptionId(caller.orgId);
    if (!subId) {
      return err(c, 'no_subscription', 409, 'This organization has no active subscription to change.');
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const sub = await stripe.subscriptions.retrieve(subId);
    // The BASE (licensed) item — NOT a metered item. A sub carries base + compute + storage
    // items; only the base price is swapped on a tier change, leaving the meters attached.
    const baseItem =
      sub.items.data.find((it) => it.price?.recurring?.usage_type !== 'metered') ?? sub.items.data[0];
    if (!baseItem?.id) return err(c, 'stripe_no_item', 502, 'Subscription has no base line item to update.');
    if (baseItem.price?.id === priceId) {
      return err(c, 'already_on_plan', 409, `Already on the ${plan} plan.`);
    }

    await stripe.subscriptions.update(subId, {
      items: [{ id: baseItem.id, price: priceId }],
      proration_behavior: 'create_prorations',
    });
    return ok(c, { ok: true, plan });
  }),
);

/**
 * POST /subscription-cancel — cancel at period end (keeps access through the paid
 * period). Owner/admin only. The webhook reflects cancelAtPeriodEnd into the row.
 */
billing.post('/subscription-cancel', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isBillingManager(caller))) {
      return err(c, 'forbidden', 403, 'Only an organization owner or admin can manage billing.');
    }
    const subId = await activeSubscriptionId(caller.orgId);
    if (!subId) {
      return err(c, 'no_subscription', 409, 'This organization has no active subscription to cancel.');
    }
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    return ok(c, { ok: true });
  }),
);

// The self-serve paid tiers.
const CheckoutIntentSchema = z.object({ toPlan: z.enum(['pro', 'max', 'scale']) });

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
