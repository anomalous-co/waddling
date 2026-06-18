/**
 * /api/cp/sessions/[id] (W1) — single session detail for the dashboard.
 *
 * GET → { session, queries }:
 *   session  — the agent_session enriched with the source agent (name + owner),
 *              the endpoint name, and the actor who opened it (a user, for
 *              run-as-agent sessions; otherwise the agent itself).
 *   queries  — the audit_event 'query' rows for this session (newest first),
 *              with decision + (admin-only) reason.
 *
 * Org-scoped: a session is only reachable by its own org.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, handle, ok, err } from '../../_shared';

interface SessionRow {
  id: string;
  org_id: string;
  sid: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
  granted_roles: string[];
  started_at: string;
  expires_at: string;
  agent_id: string;
  agent_name: string | null;
  owner: string | null;
  endpoint_id: string;
  endpoint_name: string | null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;

    const s = await queryOne<SessionRow>(
      `SELECT se.id, se.org_id, se.sid, se.status, se.granted_roles,
              se.started_at, se.expires_at,
              se.agent_id, a.name AS agent_name,
              COALESCE(u.name, u.email) AS owner,
              se.endpoint_id, e.name AS endpoint_name
         FROM waddling.agent_session se
         LEFT JOIN waddling.agent a  ON a.id = se.agent_id
         LEFT JOIN "apikey" k        ON k.id = a.api_key_id
         LEFT JOIN "user" u          ON u.id = k."userId"
         LEFT JOIN waddling.endpoint e ON e.id = se.endpoint_id
        WHERE se.id = $1`,
      [id],
    );
    if (!s || s.org_id !== caller.orgId) return err('session_not_found', 404);

    // Who opened the session: the 'attach' audit row's actor (a user id for
    // run-as-agent; an agent id otherwise). Resolve to a display name if a user.
    const attach = await queryOne<{ actor: string | null; actor_name: string | null }>(
      `SELECT ev.actor, COALESCE(u.name, u.email) AS actor_name
         FROM waddling.audit_event ev
         LEFT JOIN "user" u ON u.id = ev.actor
        WHERE ev.session_id = $1 AND ev.event = 'attach'
        ORDER BY ev.ts ASC LIMIT 1`,
      [id],
    );

    const queryRows = await query<{
      ts: string;
      query: string | null;
      decision: 'allow' | 'deny' | null;
      reason: string | null;
    }>(
      `SELECT ts, query, decision, reason
         FROM waddling.audit_event
        WHERE session_id = $1 AND event = 'query'
        ORDER BY ts DESC
        LIMIT 200`,
      [id],
    );

    return ok({
      session: {
        id: s.id,
        sid: s.sid,
        status: s.status,
        startedAt: s.started_at,
        expiresAt: s.expires_at,
        grantedRoles: s.granted_roles,
        agentId: s.agent_id,
        agentName: s.agent_name ?? undefined,
        owner: s.owner ?? undefined,
        endpointId: s.endpoint_id,
        endpointName: s.endpoint_name ?? undefined,
        actor: attach?.actor ?? undefined,
        actorName: attach?.actor_name ?? undefined,
      },
      queries: queryRows.rows.map((r) => ({
        ts: r.ts,
        query: r.query ?? '',
        decision: r.decision ?? undefined,
        reason: r.reason ?? undefined,
      })),
    });
  });
}
