/**
 * Stripe.js loader (browser-safe, memoized).
 *
 * The billing page mounts a Payment Element in-page (Stripe Elements) for the
 * free→paid conversion. That needs the account's PUBLISHABLE key, inlined into the
 * client bundle via `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (Next inlines NEXT_PUBLIC_*
 * at build). The UI ships as an OpenNext Cloudflare Worker, so this var must be set
 * in the WORKERS BUILD env — and its mode (pk_test_ / pk_live_) MUST match the
 * control-api secret key's mode, or Elements silently fails to mount.
 *
 * Unset ⇒ `getStripe()` resolves null and `stripeConfigured` is false; callers hide
 * the embedded upgrade dialog and degrade gracefully.
 */
import { loadStripe, type Stripe } from '@stripe/stripe-js';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export const stripeConfigured = !!PUBLISHABLE_KEY;

let promise: Promise<Stripe | null> | null = null;

/** Memoized Stripe.js instance. Resolves null when the publishable key is unset. */
export function getStripe(): Promise<Stripe | null> {
  if (!PUBLISHABLE_KEY) {
    if (typeof window !== 'undefined') {
      console.warn('[stripe] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set — embedded checkout disabled');
    }
    return Promise.resolve(null);
  }
  if (!promise) promise = loadStripe(PUBLISHABLE_KEY);
  return promise;
}
