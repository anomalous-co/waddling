/**
 * Typed fetch helper for /api/cp/* control-plane endpoints.
 *
 * Assumed response envelope (W1 must match):
 *   Success:  { data: T }   — or plain T[] for list routes (see per-route notes)
 *   Error:    { error: string; code?: string; status?: number }
 *
 * Per-route contracts W2 assumes (W1 must align):
 *   GET  /api/cp/endpoints          → { endpoints: EndpointSummary[] }
 *   GET  /api/cp/endpoints/:id      → { endpoint: EndpointRow }
 *   GET  /api/cp/agents             → { agents: AgentSummary[] }
 *   GET  /api/cp/agents/:id         → { agent: AgentRow }
 *   GET  /api/cp/acl                → { rules: AclRuleRow[] }
 *   POST /api/cp/acl                → { rule: AclRuleRow }      (402 on free = upgrade_required)
 *   DELETE /api/cp/acl/:id          → { ok: true }
 *   GET  /api/cp/audit              → { events: AuditEventRow[]; total: number }
 *   GET  /api/cp/usage              → { rollup: UsageRollup; series: UsageSeries[] }
 *   GET  /api/cp/billing            → { plan: PlanInfo; portalUrl?: string; invoices?: Invoice[] }
 *   POST /api/cp/billing/checkout   → { url: string }
 *   POST /api/cp/billing/portal     → { url: string }
 *   GET  /api/cp/settings           → { org: OrgInfo; members: MemberRow[]; apiKeys: ApiKeyRow[] }
 *   POST /api/cp/settings/members   → { ok: true }
 *   POST /api/cp/agents             → { agent: AgentRow; key?: string }   (key = reveal-once)
 *   POST /api/cp/agents/:id/revoke  → { ok: true }
 *   DELETE /api/cp/agents/:id       → { ok: true }
 *   POST /api/cp/sessions/:id/kill  → { ok: true }
 */

export interface CpError {
  error: string;
  code?: string;
}

export type CpResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; status: number };

// The /api/cp/* routes now live in the standalone control-api Worker, not this
// app — prefix every call with its origin (cpUrl). Same-origin when unset.
import { cpUrl } from '@/lib/control-api';

export async function fetchCp<T>(
  path: string,
  init?: RequestInit,
): Promise<CpResult<T>> {
  try {
    const res = await fetch(cpUrl(path), {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      ...init,
    });
    const body = (await res.json()) as T | CpError;
    if (!res.ok) {
      const err = body as CpError;
      return {
        ok: false,
        error: err.error ?? `HTTP ${res.status}`,
        code: err.code,
        status: res.status,
      };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Network error',
      status: 0,
    };
  }
}

export function cpPost<T>(path: string, body: unknown): Promise<CpResult<T>> {
  return fetchCp<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function cpDelete<T>(path: string): Promise<CpResult<T>> {
  return fetchCp<T>(path, { method: 'DELETE' });
}
