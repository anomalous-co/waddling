/**
 * /api/cp/agents — Hono port of apps/waddling/src/app/api/cp/agents{,/[id]}/route.ts.
 * Machine principals (§2 agent, §4b list_agents / revoke_agent).
 *
 * GET    /        → list this org's agents (AgentSummary[]).
 * POST   /        → create an agent + a bound `sk_agent_…` API key (Better Auth), 1:1.
 *                   Returns the plaintext key ONCE. Gated by the org's agent quota.
 *                   Session callers only (creating a key requires a browser session).
 * GET    /:id     → agent detail (+ apiKeys + sessions).
 * PATCH  /:id     → update name/description/defaultRole/status.
 * DELETE /:id     → instant revoke: birdshot_revoke('user','agent:<id>') across the
 *                   org's running endpoints + mark agent 'revoked' + kill live sessions.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import { getEntitlements } from '../lib/entitlements';
import { gatewayClientFor } from '../lib/gateway-client';
import type { Env } from '../lib/env';
import { resolveCaller, assertOrg, parseBody, handle, ok, err, AuthError } from '../lib/cp-shared';
import { buildAuth } from '../lib/auth';
import type { AgentSummary } from '../lib/types';

const CreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultRole: z.string().default('reader'),
});

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

async function load(id: string): Promise<AgentRow | null> {
  return queryOne<AgentRow>(
    `SELECT id, org_id, name, description, default_role, status, api_key_id, last_seen_at
       FROM waddling.agent WHERE id = $1`,
    [id],
  );
}

const agents = new Hono<{ Bindings: Env }>();

// GET / — list this org's agents.
agents.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const status = c.req.query('status') ?? null;
    const rows = await query<{
      id: string;
      org_id: string;
      name: string;
      description: string | null;
      default_role: string;
      mode: AgentSummary['mode'];
      status: AgentSummary['status'];
      last_seen_at: string | null;
      api_key_id: string | null;
      owner: string | null;
    }>(
      // owner = the user who owns the agent's API key. The Better Auth api-key plugin
      // references the owning user via "referenceId" (NOT "userId" — that column doesn't exist).
      `SELECT a.id, a.org_id, a.name, a.description, a.default_role, a.mode, a.status,
              a.last_seen_at, a.api_key_id,
              COALESCE(u.name, u.email) AS owner
         FROM waddling.agent a
         LEFT JOIN "apikey" k ON k.id = a.api_key_id
         LEFT JOIN "user" u   ON u.id = k."referenceId"
        WHERE a.org_id = $1 AND ($2::text IS NULL OR a.status = $2)
        ORDER BY a.created_at ASC`,
      [caller.orgId, status],
    );
    const list: AgentSummary[] = rows.rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      description: r.description ?? undefined,
      defaultRole: r.default_role,
      mode: r.mode,
      status: r.status,
      lastSeenAt: r.last_seen_at ?? undefined,
      apiKeyId: r.api_key_id ?? undefined,
      owner: r.owner ?? undefined,
    }));
    return ok(c, { agents: list });
  }),
);

// POST / — create an agent + a bound sk_agent_… API key (1:1). Session callers only.
agents.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (caller.kind !== 'user') {
      throw new AuthError('session_required', 403, 'Creating an agent requires a dashboard session');
    }
    const input = await parseBody(c, CreateSchema);

    // Plan quotas only apply when billing is configured (can't enforce a paid limit with
    // no way to pay — mirrors the ACL plan gate + auth.ts stripeConfigured check).
    const billingOn = !!c.env.STRIPE_SECRET_KEY && !/placeholder/i.test(c.env.STRIPE_SECRET_KEY);
    const ent = await getEntitlements(caller.orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.agent WHERE org_id = $1 AND status <> 'revoked'`,
      [caller.orgId],
    );
    if (billingOn && Number(count?.n ?? 0) >= ent.agents) {
      return err(c, 'agent_quota_exceeded', 402, `Plan allows ${ent.agents} agent(s)`);
    }

    // Create the Better Auth API key bound to the org (uses caller's session).
    // Exactly one key per agent (one-key-per-agent): the key is minted here, 1:1
    // with the agent row below, and the agent_api_key_unique index forbids reuse.
    const created = await buildAuth(c.env).api.createApiKey({
      body: {
        name: input.name,
        organizationId: caller.orgId,
        metadata: { agent: input.name },
      },
      headers: c.req.raw.headers,
    });

    try {
      const agent = await queryOne<{ id: string }>(
        // mode defaults to 'autonomous' (agent holds its own key); set explicitly
        // for clarity. Delegated agents are created via the OAuth/AAP flow (phase 2).
        `INSERT INTO waddling.agent (org_id, name, description, api_key_id, default_role, mode, status)
         VALUES ($1,$2,$3,$4,$5,'autonomous','active') RETURNING id`,
        [caller.orgId, input.name, input.description ?? null, created.id, input.defaultRole],
      );
      if (agent?.id) {
        // deferred (Stage C/D): server-side analytics for 'agent_created'
        // (via:dashboard). The original called getPostHogServer().capture, a Node-only
        // posthog-node path that does not bundle/run on workerd (see auth.ts /
        // agent-identity.ts neutered hooks). captureAgentEvent is agent-principal-only
        // and does not fit this user-funnel event.
      }
      return ok(
        c,
        {
          agentId: agent?.id,
          apiKey: created.key, // plaintext — shown once
          apiKeyId: created.id,
        },
        201,
      );
    } catch (e) {
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23505') {
        if (pg.constraint === 'agent_api_key_unique') {
          // The minted key is already bound to another agent — one key per agent.
          return err(c, 'api_key_in_use', 409, 'That API key already backs another agent');
        }
        return err(c, 'agent_name_taken', 409, 'An agent with that name already exists');
      }
      throw e;
    }
  }),
);

// GET /:id — agent detail (+ apiKeys + sessions).
agents.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const row = await load(id);
    if (!row) return err(c, 'agent_not_found', 404);
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
    return ok(c, { agent });
  }),
);

// PATCH /:id — update name/description/defaultRole/status.
agents.patch('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const agent = await load(id);
    if (!agent) return err(c, 'agent_not_found', 404);
    assertOrg(caller, agent.org_id);
    const patch = await parseBody(c, PatchSchema);
    await query(
      `UPDATE waddling.agent
          SET name = COALESCE($2,name),
              description = COALESCE($3,description),
              default_role = COALESCE($4,default_role),
              status = COALESCE($5,status)
        WHERE id = $1`,
      [id, patch.name ?? null, patch.description ?? null, patch.defaultRole ?? null, patch.status ?? null],
    );
    return ok(c, { success: true });
  }),
);

// DELETE /:id — instant revoke across running endpoints + mark revoked + kill sessions.
agents.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const agent = await load(id);
    if (!agent) return err(c, 'agent_not_found', 404);
    assertOrg(caller, agent.org_id);

    let body: z.infer<typeof RevokeSchema> = { reason: 'revoked by admin' };
    try {
      body = await parseBody(c, RevokeSchema);
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

    return ok(c, { success: true, affectedSessions: killed.rowCount ?? 0 });
  }),
);

export { agents };
