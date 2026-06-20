/**
 * GET /api/cp/whoami — agent self-orientation for the MCP `waddling_whoami` tool.
 *
 * Returns the caller's resolved agent identity (id, org, name), and — when a live
 * session is named via `?session_id` (or a datalake via `?datalake_id`) — that
 * datalake's compiled grants + the session's remaining TTL. Lets an agent learn
 * exactly what it may do WITHOUT triggering a denial.
 *
 * Auth: data-plane read, so delegated OAuth/MCP callers are allowed
 * (resolveCaller(c, true, true)). An api-key agent resolves to itself; a delegated
 * caller has no standing agent until it connects, so without a session it gets its
 * identity + empty grants.
 */
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, handle, ok, err, assertOrg } from '../lib/cp-shared';
import { compilePolicy, grantsForAgent, type AclRuleRow } from '../lib/policy-compiler';
import type { SessionGrant, WhoamiResult } from '../lib/types';

export const whoami = new Hono<{ Bindings: Env }>();

interface SessionRow {
  org_id: string;
  agent_id: string;
  datalake_id: string;
  status: string;
  expires_at: string;
}

const EMPTY_GRANT: SessionGrant = { tables: [] };

whoami.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, true, true);
    const u = new URL(c.req.url);
    const sessionId = u.searchParams.get('session_id') ?? undefined;
    const datalakeParam = u.searchParams.get('datalake_id') ?? u.searchParams.get('endpoint_id') ?? undefined;

    // Resolve the acting agent + (optionally) the datalake whose grants apply.
    let agentId = caller.agentId;
    let datalakeId = datalakeParam;
    let remainingTtlSeconds: number | undefined;

    if (sessionId) {
      const s = await queryOne<SessionRow>(
        `SELECT org_id, agent_id, datalake_id, status, expires_at
           FROM waddling.agent_session WHERE id = $1`,
        [sessionId],
      );
      if (!s) return err(c, 'session_not_found', 404);
      assertOrg(caller, s.org_id);
      agentId = s.agent_id;
      datalakeId = s.datalake_id;
      const ms = new Date(s.expires_at).getTime() - Date.now();
      remainingTtlSeconds = ms > 0 ? Math.floor(ms / 1000) : 0;
    }

    // Identity: api-key agents (and session-resolved agents) have a row; a
    // delegated caller with no session has no standing agent yet.
    let name = caller.delegated ? `claude:${caller.callerId}` : caller.callerId;
    if (agentId) {
      const a = await queryOne<{ org_id: string; name: string }>(
        `SELECT org_id, name FROM waddling.agent WHERE id = $1`,
        [agentId],
      );
      if (!a) return err(c, 'agent_not_found', 404);
      assertOrg(caller, a.org_id);
      name = a.name;
    }

    // Grants are per-(datalake, agent): only meaningful when both are known.
    let grants: SessionGrant = EMPTY_GRANT;
    if (agentId && datalakeId) {
      const ruleRows = await query<AclRuleRow>(
        `SELECT * FROM waddling.acl_rule
          WHERE datalake_id = $1 AND (agent_id = $2 OR agent_id IS NULL)`,
        [datalakeId, agentId],
      );
      const compiled = compilePolicy(ruleRows.rows, new Date());
      grants = grantsForAgent(compiled, agentId);
    }

    const result: WhoamiResult = {
      agentId: agentId ?? caller.callerId,
      orgId: caller.orgId,
      name,
      grants,
      remainingTtlSeconds,
    };
    return ok<WhoamiResult>(c, result);
  }),
);
