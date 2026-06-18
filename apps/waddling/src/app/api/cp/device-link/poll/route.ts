/**
 * GET /api/cp/device-link/poll?token=…  (FUNNEL / Stream B — UNAUTHENTICATED)
 *
 * The onboarding agent polls here with its pollToken until a human claims the
 * link. Responses:
 *   { status:'pending' }                              — not claimed yet
 *   { status:'expired' }                              — past TTL (or never existed)
 *   { status:'claimed', apiKey, orgId, agentId }      — EXACTLY ONCE, then the
 *                                                        key is NULLed at-rest
 *   { status:'claimed' }                              — subsequent polls (no key)
 *
 * The one-shot delivery uses an atomic UPDATE … RETURNING that NULLs api_key_once
 * in the same statement, so two concurrent polls can never both read the key.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { handle, ok } from '../../_shared';
import type { DeviceLinkPoll } from '@waddling/control-schema';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    if (!token) {
      // Treat a missing/unknown token as expired so we never leak existence.
      return ok<DeviceLinkPoll>({ status: 'expired' });
    }

    // Lazily mark past-TTL pending rows expired (no background sweeper needed).
    await query(
      `UPDATE waddling.device_link
          SET status = 'expired'
        WHERE poll_token = $1 AND status = 'pending' AND expires_at <= now()`,
      [token],
    );

    const row = await query<{
      status: 'pending' | 'claimed' | 'expired';
      api_key_once: string | null;
      org_id: string | null;
      agent_id: string | null;
    }>(
      `SELECT status, api_key_once, org_id, agent_id
         FROM waddling.device_link
        WHERE poll_token = $1`,
      [token],
    );

    const r = row.rows[0];
    if (!r) return ok<DeviceLinkPoll>({ status: 'expired' });
    if (r.status !== 'claimed') return ok<DeviceLinkPoll>({ status: r.status });

    // Atomic one-shot key delivery: claim & NULL in a single statement.
    const delivered = await query<{ api_key_once: string; org_id: string | null; agent_id: string | null }>(
      `UPDATE waddling.device_link
          SET api_key_once = NULL
        WHERE poll_token = $1 AND api_key_once IS NOT NULL
        RETURNING api_key_once, org_id, agent_id`,
      [token],
    );

    const d = delivered.rows[0];
    if (d) {
      return ok<DeviceLinkPoll>({
        status: 'claimed',
        apiKey: d.api_key_once,
        orgId: d.org_id ?? undefined,
        agentId: d.agent_id ?? undefined,
      });
    }
    // Already delivered — claimed but no key.
    return ok<DeviceLinkPoll>({ status: 'claimed' });
  });
}
