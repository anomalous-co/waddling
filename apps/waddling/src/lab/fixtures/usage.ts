import type { UsageRollup } from '@/lib/types';

/**
 * UsageSeries — lab-local type (not yet in control-schema).
 * Represents one day's bucketed usage for the sparkline.
 */
export interface UsageSeries {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Fractional session-hours for this day. */
  sessionHours: number;
  /** Total queries executed in this day. */
  queries: number;
}

/** Fixture week of usage for the UX lab. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export const FIXTURE_USAGE_ROLLUP: UsageRollup = {
  orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
  period: 'week',
  queries: 1_847,
  rowsScanned: 42_100_000,
  bytesScanned: 2_350_000_000,
  activeSessions: 2,
  estimatedCost: 4.78,
};

export const FIXTURE_USAGE_SERIES: UsageSeries[] = [
  { date: daysAgo(6), sessionHours: 1.2, queries: 210 },
  { date: daysAgo(5), sessionHours: 2.4, queries: 380 },
  { date: daysAgo(4), sessionHours: 0.8, queries: 145 },
  { date: daysAgo(3), sessionHours: 3.1, queries: 520 },
  { date: daysAgo(2), sessionHours: 1.7, queries: 280 },
  { date: daysAgo(1), sessionHours: 2.9, queries: 210 },
  { date: daysAgo(0), sessionHours: 0.6, queries: 102 },
];

/**
 * creditBalance — lab-local field (not yet in UsageRollup).
 * Represents the org's remaining prepaid credit balance in USD-cents.
 * GUESSED: billing model exists (waddling-context/billing) but the schema
 * type hasn't landed yet.
 */
export const FIXTURE_CREDIT_BALANCE_CENTS = 4_320; // $43.20 remaining
