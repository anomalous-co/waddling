/**
 * Lab fixtures for the Billing section of Settings.
 *
 * waddling billing = PREPAID CREDITS: a plan grants a monthly credit allotment
 * (balance resets to the tier max each month); users top up in >= $10 chunks;
 * usage is per-second billed against credits at ~$0.50/session-hour. All money
 * is integer cents (never float-dollar fields).
 */

export interface BillingInvoice {
  id: string;
  /** ISO date. */
  date: string;
  amountCents: number;
  status: 'paid' | 'open' | 'void';
}

export interface BillingInfo {
  plan: string;
  /** Current prepaid credit balance, integer cents. */
  creditBalanceCents: number;
  /** Monthly credit allotment for the plan, integer cents. */
  monthlyAllotmentCents: number;
  /** Headline usage rate, integer cents per session-hour. */
  ratePerSessionHourCents: number;
  /** ISO date the allotment renews / resets. */
  renewsAt: string;
  invoices: BillingInvoice[];
}

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  return daysFromNow(-n);
}

export const FIXTURE_BILLING: BillingInfo = {
  plan: 'Team',
  // Consistent with the Home launchpad "Credit balance $43.20".
  creditBalanceCents: 4_320,
  monthlyAllotmentCents: 10_000,
  ratePerSessionHourCents: 50, // $0.50 / session-hour
  renewsAt: daysFromNow(12),
  invoices: [
    { id: 'in_03', date: daysAgo(2), amountCents: 5_000, status: 'paid' },
    { id: 'in_02', date: daysAgo(33), amountCents: 10_000, status: 'paid' },
    { id: 'in_01', date: daysAgo(64), amountCents: 10_000, status: 'paid' },
  ],
};
