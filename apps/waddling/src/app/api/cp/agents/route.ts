/**
 * /api/cp/agents (W1) — machine principals (§2 agent, §4b list_agents).
 *
 * GET  → list this org's agents (AgentSummary[]).
 * POST → create an agent + a bound `sk_agent_…` API key (Better Auth), 1:1.
 *        Returns the plaintext key ONCE. Gated by the org's agent quota.
 *        Session callers only (creating a key requires a browser session).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { query, queryOne, withTransaction } from '@/lib/db';
import { getEntitlements } from '@/lib/entitlements';
import { getPostHogServer } from '@/lib/posthog-server';
import { resolveCaller, parseBody, handle, ok, err, AuthError } from '../_shared';
import type { AgentSummary } from '@/lib/types';

const CreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultRole: z.string().default('reader'),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
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
      // owner = the user who owns the agent's API key (apikey.userId → user).
      `SELECT a.id, a.org_id, a.name, a.description, a.default_role, a.mode, a.status,
              a.last_seen_at, a.api_key_id,
              COALESCE(u.name, u.email) AS owner
         FROM waddling.agent a
         LEFT JOIN "apikey" k ON k.id = a.api_key_id
         LEFT JOIN "user" u   ON u.id = k."userId"
        WHERE a.org_id = $1 AND ($2::text IS NULL OR a.status = $2)
        ORDER BY a.created_at ASC`,
      [caller.orgId, status],
    );
    const agents: AgentSummary[] = rows.rows.map((r) => ({
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
    return ok({ agents });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    if (caller.kind !== 'user') {
      throw new AuthError('session_required', 403, 'Creating an agent requires a dashboard session');
    }
    const input = await parseBody(req, CreateSchema);

    const ent = await getEntitlements(caller.orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.agent WHERE org_id = $1 AND status <> 'revoked'`,
      [caller.orgId],
    );
    if (Number(count?.n ?? 0) >= ent.agents) {
      return err('agent_quota_exceeded', 402, `Plan allows ${ent.agents} agent(s)`);
    }

    // Create the Better Auth API key bound to the org (uses caller's session).
    // Exactly one key per agent (one-key-per-agent): the key is minted here, 1:1
    // with the agent row below, and the agent_api_key_unique index forbids reuse.
    const created = await auth.api.createApiKey({
      body: {
        name: input.name,
        organizationId: caller.orgId,
        metadata: { agent: input.name },
      },
      headers: req.headers,
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
        // 'via:dashboard' distinguishes from Stream B's device-link claim which
        // also fires agent_created with 'via:device-link'.
        getPostHogServer().capture({
          distinctId: caller.callerId,
          event: 'agent_created',
          properties: { via: 'dashboard' },
          groups: { organization: caller.orgId },
        });
      }
      return ok(
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
          return err('api_key_in_use', 409, 'That API key already backs another agent');
        }
        return err('agent_name_taken', 409, 'An agent with that name already exists');
      }
      throw e;
    }
  });
}
