/**
 * UI-only types for the Settings surface.
 *
 * These mirror the real control-api contracts (`/api/cp/settings`, `/api/cp/usage`)
 * — they are NOT lab fixtures. The lab page consumed `UsageSeries`/`TeamOrgInfo`/
 * `BillingInfo` from `@/lab/fixtures/*`; this module replaces those with the shapes
 * the production endpoints actually return.
 */
import type { UsageRollup } from '@/lib/types';

// ── /api/cp/settings → { org, members, apiKeys } ─────────────────────────────

export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  agentId?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface SettingsData {
  org: OrgInfo;
  members: MemberRow[];
  apiKeys: ApiKeyRow[];
}

// ── /api/cp/usage → { rollup, series, credit, … } ────────────────────────────

/** One time-bucket of usage as returned by the real `/api/cp/usage` endpoint. */
export interface UsagePoint {
  /** Bucket timestamp (e.g. "2026-06-29 00:00:00+00"). */
  ts: string;
  queries: number;
  rowsScanned: number;
  sessions: number;
}

export interface UsageResponse {
  rollup: UsageRollup;
  series: UsagePoint[];
  totalQueries: number;
  totalSessions: number;
  plan: string;
  planName: string;
  credit: {
    balanceMicro: number;
    balanceUsd: number;
    spentMicro: number;
    spentUsd: number;
  };
}
