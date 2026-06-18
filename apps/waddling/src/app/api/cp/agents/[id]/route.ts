/**
 * /api/cp/agents/[id] (W1) — agent detail + instant revoke (§4b revoke_agent).
 *
 * GET    → agent detail.
 * PATCH  → update name/description/defaultRole/status.
 * DELETE → instant revoke: birdshot_revoke('user','agent:<id>') across the org's
 *          running endpoints + mark agent 'revoked' + kill its live sessions.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { gatewayClientFor } from '@/lib/gateway-client';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../../_shared';

interface AgentRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  default_role: string;
  status: string;
  api_key_id: string | null;
  last_seen_at: string | null;
}

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  defaultRole: z.string().optional(),
  status: z.enum(['active', 'suspended', 'revoked']).optional(),
});

const RevokeSchema = z.object({
  reason: z.string().default('revoked by admin'),
  expiresSeconds: z.number().int().positive().optional(),
});

async function load(id: string): Promise<AgentRow | null> {
  return queryOne<AgentRow>(
    `SELECT id, org_id, name, description, default_role, status, api_key_id, last_seen_at
       FROM waddling.agent WHERE id = $1`,
    [id],
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const row = await load(id);
    if (!row) return err('agent_not_found', 404);
    assertOrg(caller, row.org_id);

    // API keys for this agent (Better Auth `apikey` rows linked via agent.api_key_id).
    const keyRows = await query<{
      id: string;
      name: string | null;
      start: string | null;
      prefix: string | null;
      createdAt: string;
      expiresAt: string | null;
      lastRequest: string | null;
    }>(
      `SELECT id, name, start, prefix, "createdAt", "expiresAt", "lastRequest"
         FROM "apikey" WHERE id = $1`,
      [row.api_key_id],
    );
    const apiKeys = keyRows.rows.map((k) => ({
      id: k.id,
      name: k.name ?? 'agent key',
      prefix: k.prefix ?? k.start ?? '',
      agentId: row.id,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt ?? undefined,
      lastUsedAt: k.lastRequest ?? undefined,
    }));

    // Sessions for this agent (newest first).
    const sessRows = await query<{
      id: string;
      org_id: string;
      agent_id: string;
      endpoint_id: string;
      sid: string;
      status: 'active' | 'expired' | 'revoked' | 'killed';
      granted_roles: string[];
      started_at: string;
      expires_at: string;
    }>(
      `SELECT id, org_id, agent_id, endpoint_id, sid, status, granted_roles, started_at, expires_at
         FROM waddling.agent_session WHERE agent_id = $1
        ORDER BY started_at DESC LIMIT 100`,
      [row.id],
    );
    const sessions = sessRows.rows.map((s) => ({
      id: s.id,
      orgId: s.org_id,
      agentId: s.agent_id,
      endpointId: s.endpoint_id,
      sid: s.sid,
      status: s.status,
      grantedRoles: s.granted_roles,
      startedAt: s.started_at,
      expiresAt: s.expires_at,
    }));

    const agent = {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      description: row.description ?? undefined,
      defaultRole: row.default_role,
      status: row.status,
      lastSeenAt: row.last_seen_at ?? undefined,
      apiKeyId: row.api_key_id ?? undefined,
      apiKeys,
      sessions,
    };
    return ok({ agent });
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const agent = await load(id);
    if (!agent) return err('agent_not_found', 404);
    assertOrg(caller, agent.org_id);
    const patch = await parseBody(req, PatchSchema);
    await query(
      `UPDATE waddling.agent
          SET name = COALESCE($2,name),
              description = COALESCE($3,description),
              default_role = COALESCE($4,default_role),
              status = COALESCE($5,status)
        WHERE id = $1`,
      [id, patch.name ?? null, patch.description ?? null, patch.defaultRole ?? null, patch.status ?? null],
    );
    return ok({ success: true });
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const agent = await load(id);
    if (!agent) return err('agent_not_found', 404);
    assertOrg(caller, agent.org_id);

    let body: z.infer<typeof RevokeSchema> = { reason: 'revoked by admin' };
    try {
      body = await parseBody(req, RevokeSchema);
    } catch {
      // empty body is fine → defaults
    }

    // Push birdshot_revoke to every running endpoint in the org (the agent could
    // hold sessions on any of them).
    const endpoints = await query<{
      id: string;
      gateway_host: string | null;
      quack_port: number | null;
      server_token: string;
    }>(
      `SELECT id, gateway_host, quack_port, server_token FROM waddling.endpoint
        WHERE org_id = $1 AND status = 'running'`,
      [agent.org_id],
    );
    const expiresUs = body.expiresSeconds ? body.expiresSeconds * 1_000_000 : undefined;
    for (const ep of endpoints.rows) {
      try {
        await gatewayClientFor(ep).revoke({
          endpointId: ep.id,
          kind: 'user',
          id: `agent:${id}`,
          reason: body.reason,
          expiresUs,
        });
      } catch {
        // best effort per endpoint
      }
    }

    // Mark agent revoked + kill live sessions.
    await query(`UPDATE waddling.agent SET status = 'revoked' WHERE id = $1`, [id]);
    const killed = await query(
      `UPDATE waddling.agent_session SET status='revoked', ended_at=now()
        WHERE agent_id = $1 AND status = 'active' RETURNING id`,
      [id],
    );
    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, decision, reason, actor)
       VALUES ($1,'control-plane','revoke',$2,'deny',$3,$4)`,
      [agent.org_id, id, body.reason, caller.callerId],
    );

    return ok({ success: true, affectedSessions: killed.rowCount ?? 0 });
  });
}
