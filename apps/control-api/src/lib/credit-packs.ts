/**
 * Credit packs — the prepaid top-up catalog + Stripe Checkout fulfillment.
 *
 * A pack is a fixed Stripe Price (one SKU per dollar size, created in ANO-64). The UI
 * offers the configured packs; a purchase is a one-time `mode:'payment'` Checkout Session
 * (see routes/billing.ts). Fulfillment happens on the WEBHOOK — never the success_url
 * redirect (the user can close the tab; the redirect is not guaranteed).
 *
 * GRANT AMOUNT comes from Stripe's signed `amount_total`, NOT client-supplied metadata —
 * it's the actual charge, tamper-proof, and can't drift from a renamed catalog entry.
 * (1 paid USD = 1 credit-USD; bonus-credit packs would instead derive µUSD from the
 * catalog — a deliberate future change, flagged below.)
 */
import type Stripe from 'stripe';
import type { Env } from './env';
import { grantCredits, MICRO_PER_USD } from './credits';

export interface CreditPack {
  id: string; // stable id carried in Checkout metadata
  label: string;
  usd: number;
  /** The Env key holding this pack's Stripe Price id (filled by ANO-64). */
  priceEnvKey: 'STRIPE_PRICE_CREDIT_10' | 'STRIPE_PRICE_CREDIT_25' | 'STRIPE_PRICE_CREDIT_100';
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: 'credits_10', label: '$10 credits', usd: 10, priceEnvKey: 'STRIPE_PRICE_CREDIT_10' },
  { id: 'credits_25', label: '$25 credits', usd: 25, priceEnvKey: 'STRIPE_PRICE_CREDIT_25' },
  { id: 'credits_100', label: '$100 credits', usd: 100, priceEnvKey: 'STRIPE_PRICE_CREDIT_100' },
];

export function getPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/** Resolve a pack's Stripe Price id, or undefined if unset / still a placeholder. */
export function packPriceId(env: Env, pack: CreditPack): string | undefined {
  const id = env[pack.priceEnvKey];
  if (!id || /placeholder/i.test(id)) return undefined;
  return id;
}

/** Packs that are actually purchasable in this deployment (have a real Price id). */
export function availablePacks(env: Env): { id: string; label: string; usd: number }[] {
  return CREDIT_PACKS.filter((p) => packPriceId(env, p)).map(({ id, label, usd }) => ({
    id,
    label,
    usd,
  }));
}

/**
 * Fulfill a paid credit-pack Checkout Session → grant credits. Wired from the
 * @better-auth/stripe plugin's `onEvent` (post-signature-verification, awaited; a throw
 * here returns non-2xx so Stripe retries). Idempotent on `creditpack:<session.id>` — the
 * PURCHASE unit, so a webhook redelivery OR a second event type for the same session
 * (completed + async_payment_succeeded) grants exactly once.
 *
 * Handles both `checkout.session.completed` (instant methods → paid immediately) and
 * `checkout.session.async_payment_succeeded` (delayed methods settle later). A `completed`
 * event that is still `unpaid` (async pending) is skipped here and granted when its
 * async_payment_succeeded arrives.
 */
export async function fulfillCreditPackEvent(event: Stripe.Event): Promise<void> {
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return;
  }
  const s = event.data.object as Stripe.Checkout.Session;
  if (s.mode !== 'payment') return; // subscriptions are handled by the plugin itself
  if (s.metadata?.kind !== 'credit_pack') return;
  if (s.payment_status !== 'paid') return; // wait for async settlement

  const orgId = s.metadata.orgId ?? s.client_reference_id ?? undefined;
  if (!orgId) {
    console.log(`[credit-packs] PAID session ${s.id} has no orgId — credits NOT granted (reconcile manually)`);
    return;
  }
  const currency = (s.currency ?? 'usd').toLowerCase();
  if (currency !== 'usd') {
    console.log(`[credit-packs] PAID session ${s.id} currency=${currency} (expected usd) — credits NOT granted (reconcile)`);
    return;
  }
  const cents = s.amount_total;
  if (cents == null || cents <= 0) {
    console.log(`[credit-packs] PAID session ${s.id} has amount_total=${cents} — credits NOT granted (reconcile)`);
    return;
  }
  // cents → µUSD: 1 cent = 10,000 µUSD (MICRO_PER_USD / 100).
  const micro = cents * (MICRO_PER_USD / 100);
  const res = await grantCredits(orgId, micro, 'credit_pack', `creditpack:${s.id}`, {
    refKind: 'credit_pack',
    refId: s.id,
    createdBy: 'stripe',
  });
  console.log(
    `[credit-packs] org ${orgId} ${res.applied ? 'granted' : 'replay (no-op)'} ${micro} µUSD from session ${s.id} (pack ${s.metadata.packId ?? '?'})`,
  );
}
