#!/usr/bin/env node
/**
 * ANO-64 — create the real Stripe products + prices for Waddling billing.
 *
 * Monetization model (see docs/credit-unit-economics.md):
 *   • Tiers are recurring monthly subscriptions whose price = the credit balance the
 *     org resets to each month — Pro $49/mo, Enterprise $199/mo (Free has no price).
 *   • Top-ups are one-time prepaid credit purchases — $10 / $25 / $100.
 *
 * IDEMPOTENT: every price carries a stable `lookup_key`. Re-running reuses the existing
 * price for a key instead of creating a duplicate, so this is safe to run repeatedly
 * (and across test → live) without piling up SKUs.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=rk_test_... node scripts/stripe-setup-products.mjs
 *
 * Prints the env mapping to paste into wrangler.jsonc vars (test) / secrets (live).
 * The KEY IS NEVER STORED BY THIS SCRIPT — it is read from the environment only.
 */
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is required (pass it inline; do not commit it).');
  process.exit(1);
}
const mode = key.includes('_test_') ? 'TEST' : 'LIVE';
const stripe = new Stripe(key);

/**
 * Desired catalog. `envKey` is the Env var (env.ts) that must hold the resulting
 * price id. `recurring` marks the monthly subscription tiers.
 */
const CATALOG = [
  {
    lookupKey: 'pro_monthly',
    envKey: 'STRIPE_PRICE_PRO',
    product: { name: 'Waddling Pro', description: 'Pro tier — $49/mo, resets to $49 credits monthly.' },
    unitAmount: 4900,
    recurring: true,
  },
  {
    lookupKey: 'enterprise_monthly',
    envKey: 'STRIPE_PRICE_ENTERPRISE',
    product: { name: 'Waddling Enterprise', description: 'Enterprise tier — $199/mo, resets to $199 credits monthly.' },
    unitAmount: 19900,
    recurring: true,
  },
  {
    lookupKey: 'credit_10',
    envKey: 'STRIPE_PRICE_CREDIT_10',
    product: { name: 'Waddling Credits — $10', description: 'One-time $10 prepaid credit top-up.' },
    unitAmount: 1000,
    recurring: false,
  },
  {
    lookupKey: 'credit_25',
    envKey: 'STRIPE_PRICE_CREDIT_25',
    product: { name: 'Waddling Credits — $25', description: 'One-time $25 prepaid credit top-up.' },
    unitAmount: 2500,
    recurring: false,
  },
  {
    lookupKey: 'credit_100',
    envKey: 'STRIPE_PRICE_CREDIT_100',
    product: { name: 'Waddling Credits — $100', description: 'One-time $100 prepaid credit top-up.' },
    unitAmount: 10000,
    recurring: false,
  },
];

/** Find an existing active price by lookup_key, or null. */
async function existingPrice(lookupKey) {
  const res = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  return res.data[0] ?? null;
}

async function ensure(entry) {
  const found = await existingPrice(entry.lookupKey);
  if (found) {
    return { envKey: entry.envKey, lookupKey: entry.lookupKey, priceId: found.id, reused: true };
  }
  // Create the product, then a price carrying the stable lookup_key.
  const product = await stripe.products.create({
    name: entry.product.name,
    description: entry.product.description,
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: entry.unitAmount,
    lookup_key: entry.lookupKey,
    ...(entry.recurring ? { recurring: { interval: 'month' } } : {}),
  });
  return { envKey: entry.envKey, lookupKey: entry.lookupKey, priceId: price.id, reused: false };
}

console.log(`\nStripe catalog setup — ${mode} mode\n`);
const results = [];
for (const entry of CATALOG) {
  const r = await ensure(entry);
  results.push(r);
  console.log(`  ${r.reused ? 'reuse ' : 'create'}  ${r.lookupKey.padEnd(20)} ${r.priceId}`);
}

console.log('\nEnv mapping (paste into apps/control-api/wrangler.jsonc "vars" for test):\n');
for (const r of results) {
  console.log(`  "${r.envKey}": "${r.priceId}",`);
}
console.log('\nDone. For LIVE, re-run with a live secret key and set these as Worker secrets.\n');
