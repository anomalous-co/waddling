/**
 * Stripe usage-based metering — reports OVERAGE (usage beyond the included envelope) to the
 * Billing Meters, for PAID orgs only.
 *
 * The credit ledger stays the source of truth for the included compute envelope and the
 * free/trial cutoff (hasCredit). This module is the thin bridge that, once a paid org's
 * envelope is exhausted, forwards the excess to Stripe so it lands on the monthly invoice.
 * A card-less trial/free org has no Stripe customer here, so nothing is reported — it pauses
 * at envelope-zero via hasCredit instead. Idempotent via the meter-event `identifier`.
 */
import Stripe from 'stripe';
import type { Env } from './env';
import { queryOne } from './db';
import { MICRO_PER_USD } from './credits';

const COMPUTE_METER_EVENT = 'waddling_compute_overage';
const STORAGE_METER_EVENT = 'waddling_storage_overage';

export function meteringConfigured(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY && !/placeholder/i.test(env.STRIPE_SECRET_KEY);
}

/** The org's Stripe customer id IF it has an active PAID subscription (real Stripe sub, not a
 *  local trial). Null ⇒ don't meter (free/trial pause at envelope-zero instead). */
async function paidCustomerId(orgId: string): Promise<string | null> {
  const row = await queryOne<{ cust: string | null }>(
    `SELECT o."stripeCustomerId" AS cust
       FROM "organization" o
       JOIN "subscription" s ON s."referenceId" = o.id
      WHERE o.id = $1
        AND s.status IN ('active','trialing')
        AND s."stripeSubscriptionId" IS NOT NULL
      LIMIT 1`,
    [orgId],
  ).catch(() => null);
  return row?.cust ?? null;
}

function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

/**
 * Report compute overage (µUSD) to the compute meter, in CENTS (the metered price is $0.01/unit,
 * so cents × $0.01 = the overage dollars). No-op when metering is unconfigured, the amount rounds
 * to zero, or the org isn't a paid Stripe customer. `identifier` (e.g. `session:<id>`) dedupes
 * replays. Never throws to the caller — a metering hiccup must not break the debit sweep.
 */
export async function reportComputeOverage(
  env: Env,
  orgId: string,
  overageMicro: number,
  identifier: string,
): Promise<void> {
  try {
    if (!meteringConfigured(env) || overageMicro <= 0) return;
    const cents = Math.round(overageMicro / (MICRO_PER_USD / 100)); // µUSD → cents
    if (cents <= 0) return;
    const cust = await paidCustomerId(orgId);
    if (!cust) return;
    await stripeClient(env).billing.meterEvents.create({
      event_name: COMPUTE_METER_EVENT,
      identifier,
      payload: { stripe_customer_id: cust, value: String(cents) },
    });
  } catch (e) {
    console.log(`[metering] compute overage report failed (${identifier}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Report a paid org's storage OVERAGE (GB over the tier cap) to the storage meter (aggregation
 * 'last' → the invoice bills the period's latest level × $0.04/GB). Reported by the storage sweep
 * once lake-size measurement (ANO / task #11) lands; safe no-op until then.
 */
export async function reportStorageOverage(
  env: Env,
  orgId: string,
  gbOver: number,
  identifier: string,
): Promise<void> {
  try {
    if (!meteringConfigured(env) || gbOver <= 0) return;
    const cust = await paidCustomerId(orgId);
    if (!cust) return;
    await stripeClient(env).billing.meterEvents.create({
      event_name: STORAGE_METER_EVENT,
      identifier,
      payload: { stripe_customer_id: cust, value: String(Math.ceil(gbOver)) },
    });
  } catch (e) {
    console.log(`[metering] storage overage report failed (${identifier}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
