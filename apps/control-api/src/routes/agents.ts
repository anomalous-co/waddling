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
import type { Env } from '../lib/env';
import { resolveCaller, assertOrg, parseBody, handle, ok, err, AuthError } from '../lib/cp-shared';
import {
  grantsForKeyDetailed, agentSubject, granteeFromInput,
  grant, deny, applyStatement, GRANULAR_PRIVILEGES,
} from '../lib/grant-store';
import { parseStatement } from '../lib/grant-parse';
import { makePostHog } from '../lib/posthog';
import { buildAuth } from '../lib/auth';
import {
  enqueueRevokeDispatch,
  enqueueSnapshotDispatch,
  kickDispatch,
} from '../lib/gateway-dispatch';
import type { AgentSummary } from '../lib/types';

// The discriminated grantee for a create-time grant (defaults to the NEW agent when omitted).
const CreateTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }),
  z.object({ kind: z.literal('role'), role: z.string().min(1) }),
  z.object({ kind: z.literal('public') }),
]);

// One initial GRANULAR grant authored at agent creation (grant-ux-plan §5/§8.2). Each is
// applied through the literal GRANT/DENY-SQL store (lib/grant-store.applyStatement), NOT the
// retired coarse acl_rule+compiler path. `target` defaults to the new agent's subject.
const GrantInputSchema = z.object({
  datalakeId: z.string().min(1),
  target: CreateTargetSchema.optional(),
  privilege: z.enum(GRANULAR_PRIVILEGES).optional(),
  privileges: z.array(z.enum(GRANULAR_PRIVILEGES)).optional(),
  columns: z.array(z.string()).optional(),
  schema: z.string().default('*'),
  table: z.string().default('*'),
  allTablesInSchema: z.boolean().optional(),
  effect: z.enum(['allow', 'deny']).default('allow'),
});

const CreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultRole: z.string().default('reader'),
  // Autonomous (agent holds its own key) is the default; delegated agents act on a
  // user's behalf. Settable at creation (the column has existed since migration 003).
  mode: z.enum(['autonomous', 'delegated']).default('autonomous'),
  // Optional: create the agent AND its initial scope in one action. Omitted ⇒
  // today's behavior (agent with no grants). Inserted as agent-subject acl_rule rows,
  // then a single recompile+push per datalake.
  grants: z.array(GrantInputSchema).optional(),
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
  mode: AgentSummary['mode'];
  status: string;
  api_key_id: string | null;
  last_seen_at: string | null;
}

async function load(id: string): Promise<AgentRow | null> {
  return queryOne<AgentRow>(
    `SELECT id, org_id, name, description, default_role, mode, status, api_key_id, last_seen_at
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
      active_sessions: number;
    }>(
      // owner = the user who owns the agent's API key. The Better Auth api-key plugin
      // references the owning user via "referenceId" (NOT "userId" — that column doesn't exist).
      // active_sessions: live session count per agent, for the roster's session signal.
      `SELECT a.id, a.org_id, a.name, a.description, a.default_role, a.mode, a.status,
              a.last_seen_at, a.api_key_id,
              COALESCE(u.name, u.email) AS owner,
              (SELECT count(*) FROM waddling.agent_session s
                WHERE s.agent_id = a.id AND s.status = 'active')::int AS active_sessions
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
      activeSessions: r.active_sessions ?? 0,
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

    // Validate any initial grants' target datalakes UP-FRONT (before minting a key), so a
    // bad grant can't orphan an agent+key. All must belong to the caller's org.
    if (input.grants?.length) {
      const ids = [...new Set(input.grants.map((g) => g.datalakeId))];
      const rows = await query<{ id: string }>(
        `SELECT id FROM waddling.datalake WHERE id = ANY($1) AND org_id = $2`,
        [ids, caller.orgId],
      );
      const valid = new Set(rows.rows.map((r) => r.id));
      const missing = ids.filter((id) => !valid.has(id));
      if (missing.length) {
        return err(c, 'datalake_not_found', 404, `datalake(s) not in this org: ${missing.join(', ')}`);
      }
    }

    // Agents are unbounded — the plan sells SEATS (org users) + lakes + compute, not agent
    // count. Seat limits are gated at invite time (routes/team.ts); compute + storage caps
    // bound the actual cost. So no per-agent quota here.

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
      const agentRow = await queryOne<{ id: string; org_id: string; name: string; description: string | null; default_role: string; mode: AgentSummary['mode']; status: AgentSummary['status']; last_seen_at: string | null; api_key_id: string | null }>(
        // mode is caller-supplied (defaults to 'autonomous'). Note: a delegated agent
        // still gets a bound key here; the OAuth/AAP flow remains a separate path.
        `INSERT INTO waddling.agent (org_id, name, description, api_key_id, default_role, mode, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active')
         RETURNING id, org_id, name, description, default_role, mode, status, api_key_id, last_seen_at`,
        [caller.orgId, input.name, input.description ?? null, created.id, input.defaultRole, input.mode],
      );
      if (agentRow?.id) {
        // Provisioning funnel: a new agent was created from the dashboard. Server-side,
        // fire-and-forget via waitUntil; no-op when POSTHOG_KEY is unset.
        makePostHog(c.env, c.executionCtx).capture({
          distinctId: caller.callerId,
          event: 'agent_created',
          properties: { default_role: agentRow.default_role, via: 'dashboard' },
          groups: { organization: caller.orgId },
        });
      }
      // Create-and-scope (granular): apply the initial grants through the literal GRANT/DENY-SQL
      // store — the SAME path as POST /api/cp/acl. The agent + key are already minted (returned
      // once), so a grant failure must NOT fail the whole create: apply best-effort and report
      // per-grant success/failure. `target` defaults to the new agent's own subject.
      const grantResults: { datalakeId: string; sql: string | null; ok: boolean; error?: string }[] = [];
      if (agentRow?.id && input.grants?.length) {
        // Mirror POST /api/cp/acl's owner/admin gate: a create-time grant to a role or PUBLIC
        // (org-wide) requires owner/admin — the agent-target default (common path) does not.
        const wantsAdmin = input.grants.some((g) => g.target && g.target.kind !== 'agent');
        let isAdmin = false;
        if (wantsAdmin) {
          const member = await queryOne<{ role: string }>(
            `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
            [caller.callerId, caller.orgId],
          );
          isAdmin = !!member && ['owner', 'admin'].includes(member.role);
        }
        for (const g of input.grants) {
          let sql: string | null = null;
          try {
            if (g.target && g.target.kind !== 'agent' && !isAdmin) {
              throw new Error('Only org owners and admins may author role/PUBLIC grants');
            }
            const privileges = g.privileges && g.privileges.length
              ? g.privileges
              : (g.privilege ? [g.privilege] : []);
            if (privileges.length === 0) throw new Error('a privilege (or non-empty privileges[]) is required');
            const to = granteeFromInput(g.target ?? { kind: 'agent', agentId: agentRow.id });
            const on = (g.allTablesInSchema || g.table === '*')
              ? `ALL TABLES IN SCHEMA ${g.schema}`
              : `${g.schema}.${g.table}`;
            const opts = { privileges, columns: g.columns, on, to };
            sql = g.effect === 'deny' ? deny(opts) : grant(opts);
            await applyStatement(g.datalakeId, sql);
            grantResults.push({ datalakeId: g.datalakeId, sql, ok: true });
          } catch (e) {
            grantResults.push({ datalakeId: g.datalakeId, sql, ok: false, error: (e as Error).message });
          }
        }
      }

      // agent + key: additive fields for the dashboard (backward-compatible with
      // existing consumers that read agentId/apiKey/apiKeyId).
      const agent: AgentSummary | undefined = agentRow
        ? {
            id: agentRow.id,
            orgId: agentRow.org_id,
            name: agentRow.name,
            description: agentRow.description ?? undefined,
            defaultRole: agentRow.default_role,
            mode: agentRow.mode,
            status: agentRow.status,
            lastSeenAt: agentRow.last_seen_at ?? undefined,
            apiKeyId: agentRow.api_key_id ?? undefined,
          }
        : undefined;
      return ok(
        c,
        {
          agentId: agentRow?.id,
          apiKey: created.key, // plaintext — shown once
          apiKeyId: created.id,
          // additive fields (dashboard + future consumers):
          agent,
          key: created.key, // alias for apiKey — shown once
          grants: grantResults, // per-grant apply result (best-effort; may be empty)
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
      datalake_id: string;
      sid: string;
      status: 'active' | 'expired' | 'revoked' | 'killed';
      granted_roles: string[];
      started_at: string;
      expires_at: string;
    }>(
      `SELECT id, org_id, agent_id, datalake_id, sid, status, granted_roles, started_at, expires_at
         FROM waddling.agent_session WHERE agent_id = $1
        ORDER BY started_at DESC LIMIT 100`,
      [row.id],
    );
    const sessions = sessRows.rows.map((s) => ({
      id: s.id,
      orgId: s.org_id,
      agentId: s.agent_id,
      datalakeId: s.datalake_id,
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
      mode: row.mode,
      status: row.status,
      lastSeenAt: row.last_seen_at ?? undefined,
      apiKeyId: row.api_key_id ?? undefined,
      apiKeys,
      sessions,
    };
    return ok(c, { agent });
  }),
);

// GET /:id/grants — the agent key's LITERAL GRANT/DENY SQL for a datalake (spec §13). Returns
// grantsForKeyDetailed(datalake, 'agent:<id>'): the subject's own rows ∪ PUBLIC ∪ transitive
// roles, each as { sql, parsed, inherited } so the UI can render + mark inherited rows read-only
// (grant-ux-plan §4.1). Org-scoped; ?datalakeId= required.
agents.get('/:id/grants', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const url = new URL(c.req.url);
    const datalakeId = url.searchParams.get('datalakeId');
    if (!datalakeId) return err(c, 'datalakeId_required', 400, 'datalakeId query param is required');

    const agent = await load(id);
    if (!agent) return err(c, 'agent_not_found', 404);
    assertOrg(caller, agent.org_id);

    // Tenant-isolate the datalake too.
    const ep = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!ep) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, ep.org_id);

    // Resolved own ∪ PUBLIC ∪ transitive-role statements, each carrying its `parsed`
    // decomposition + `inherited` provenance (own rows → null; role/PUBLIC rows → read-only in
    // the UI). See grant-ux-plan §4.1.
    const resolved = await grantsForKeyDetailed(datalakeId, agentSubject(id));
    const statements = resolved.map((r) => ({
      sql: r.stmt,
      parsed: parseStatement(r.stmt),
      inherited: r.inherited,
    }));
    return ok(c, { agentId: id, datalakeId, statements });
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

    // Durable gate FIRST: flip status='revoked' (resolveCaller blocks any reconnect with
    // this agent's key — restart-safe, the real backstop) and kill live sessions. Doing
    // this before the recompile below is what makes compileEndpointPolicy (which filters
    // status='active') drop the agent's grants from the re-pushed snapshot.
    await query(`UPDATE waddling.agent SET status = 'revoked' WHERE id = $1`, [id]);
    const killed = await query(
      `UPDATE waddling.agent_session SET status='revoked', ended_at=now()
        WHERE agent_id = $1 AND status = 'active' RETURNING id`,
      [id],
    );

    // Durably revoke on every running endpoint (the agent could hold a warm session on
    // any). Two enqueues per endpoint, both retried via the outbox until they land:
    //   • revoke  — instant in-memory denylist on warm replicas (covers the live session
    //               until its 15-min JWT expires; a cold/restarted replica is safe by the
    //               fresh-connect + status gate, so it needs no denylist replay).
    //   • snapshot — recompile drops the now-revoked agent's grants from the director's
    //               durable cache, so a cold-boot doesn't re-arm stale grants.
    const endpoints = await query<{ id: string }>(
      `SELECT id FROM waddling.datalake WHERE org_id = $1 AND status = 'running'`,
      [agent.org_id],
    );
    const expiresUs = body.expiresSeconds ? body.expiresSeconds * 1_000_000 : undefined;
    for (const ep of endpoints.rows) {
      await enqueueRevokeDispatch(ep.id, {
        kind: 'user',
        id: `agent:${id}`,
        reason: body.reason,
        expiresUs,
      });
      await enqueueSnapshotDispatch(ep.id);
      kickDispatch(c, ep.id);
    }
    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, decision, reason, actor)
       VALUES ($1,'control-plane','revoke',$2,'deny',$3,$4)`,
      [agent.org_id, id, body.reason, caller.callerId],
    );

    return ok(c, { success: true, affectedSessions: killed.rowCount ?? 0 });
  }),
);

export { agents };
