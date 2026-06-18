/**
 * /api/cp/audit (W1) — query the durable audit_event log (§4b admin_audit).
 *
 * GET  → filtered audit rows (org-scoped). Query params map to AuditQuery.
 * POST → ingest an audit event (gateway / MCP servers push drained birdshot
 *        records + their own events here). API-key or session caller, org-scoped.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, parseBody, handle, ok } from '../_shared';
import type { AuditEventRow } from '@/lib/types';

const IngestSchema = z.object({
  source: z.enum(['gateway', 'control-plane', 'mcp-external', 'mcp-internal']),
  event: z.string().min(1),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  endpointId: z.string().optional(),
  decision: z.enum(['allow', 'deny']).optional(),
  reason: z.string().optional(),
  query: z.string().optional(),
  actor: z.string().optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const u = new URL(req.url);
    const agentId = u.searchParams.get('agentId');
    const since = u.searchParams.get('since');
    const decision = u.searchParams.get('decision');
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 200) || 200, 1000);

    const rows = await query<{
      id: string;
      org_id: string;
      ts: string;
      source: string;
      event: string;
      agent_id: string | null;
      session_id: string | null;
      endpoint_id: string | null;
      decision: 'allow' | 'deny' | null;
      reason: string | null;
      query: string | null;
      actor: string | null;
    }>(
      `SELECT id, org_id, ts, source, event, agent_id, session_id, endpoint_id, decision, reason, query, actor
         FROM waddling.audit_event
        WHERE org_id = $1
          AND ($2::text IS NULL OR agent_id = $2)
          AND ($3::timestamptz IS NULL OR ts >= $3)
          AND ($4::text IS NULL OR decision = $4)
        ORDER BY ts DESC
        LIMIT $5`,
      [caller.orgId, agentId, since, decision, limit],
    );
    const events: AuditEventRow[] = rows.rows.map((r) => ({
      id: Number(r.id),
      orgId: r.org_id,
      ts: r.ts,
      source: r.source,
      event: r.event,
      agentId: r.agent_id ?? undefined,
      sessionId: r.session_id ?? undefined,
      endpointId: r.endpoint_id ?? undefined,
      decision: r.decision ?? undefined,
      reason: r.reason ?? undefined,
      query: r.query ?? undefined,
      actor: r.actor ?? undefined,
    }));
    // Total matching rows (ignoring the LIMIT) so the page can show "N total".
    const totalRow = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.audit_event
        WHERE org_id = $1
          AND ($2::text IS NULL OR agent_id = $2)
          AND ($3::timestamptz IS NULL OR ts >= $3)
          AND ($4::text IS NULL OR decision = $4)`,
      [caller.orgId, agentId, since, decision],
    );
    return ok({ events, total: Number(totalRow?.n ?? events.length) });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const e = await parseBody(req, IngestSchema);
    await query(
      `INSERT INTO waddling.audit_event
         (org_id, source, event, agent_id, session_id, endpoint_id, decision, reason, query, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        caller.orgId,
        e.source,
        e.event,
        e.agentId ?? null,
        e.sessionId ?? null,
        e.endpointId ?? null,
        e.decision ?? null,
        e.reason ?? null,
        e.query ?? null,
        e.actor ?? caller.callerId,
      ],
    );
    return ok({ success: true }, 201);
  });
}
