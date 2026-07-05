import { makeFixtureAgents } from '@/lab/fixtures/agents';
import { authorFromBody, type AclPostBody } from '@/lab/fixtures/grants';
import type { AgentSummary } from '@/lib/types';

/**
 * GET /api/cp/agents
 * Mock handler — returns fixture agents with `lastSeenAt` computed at request
 * time so the Home launchpad always shows a realistic Active/Idle/Suspended mix.
 * Guards against serving when the real control-api is configured.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ agents: makeFixtureAgents() });
}

/**
 * POST /api/cp/agents
 * Mock handler — creates a new agent and returns it alongside a reveal-once
 * `sk_agent_…` API key. The key is generated here and never stored; in
 * production this would be hashed server-side and returned once.
 *
 * Expected body: { name, description?, mode?, defaultRole?, grants?: AclAuthorBody[] }
 * where each grant mirrors the POST /api/cp/acl author body (target defaults to
 * the new agent). Response: { agent: AgentSummary; key: string }.
 *
 * The lab mock creates the agent and echoes it back; granted access is not
 * persisted here (no store), but the shape is accepted so the create flow can post
 * the draft's statements in one call exactly as production control-api fans them out.
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const body = (await request.json()) as {
    name?: string;
    description?: string;
    mode?: string;
    defaultRole?: string;
    grants?: unknown[];
  };

  const name = (body.name ?? 'unnamed-agent').trim();
  const description = body.description?.trim();
  const agentMode = body.mode === 'delegated' ? 'delegated' : 'autonomous';
  const defaultRole = body.defaultRole ?? 'reader';

  // Generate a believable reveal-once key
  const randomHex = () =>
    Math.random().toString(16).slice(2).padStart(16, '0');
  const key = `sk_agent_${randomHex()}${randomHex()}`;

  const agent: AgentSummary = {
    id: `agt_${randomHex()}`,
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    name,
    description,
    defaultRole,
    mode: agentMode,
    status: 'active',
    lastSeenAt: undefined,
    owner: 'mirri@anomalous.computer',
    activeSessions: 0,
  };

  // Fan out the draft's grants best-effort (per-grant result, not transactional).
  const grants = Array.isArray(body.grants)
    ? (body.grants as AclPostBody[]).map((g) => {
        const withDefaults: AclPostBody = {
          ...g,
          target: g.membership ? undefined : g.target ?? { kind: 'agent', agentId: agent.id },
          membership: g.membership ? { ...g.membership, agentId: g.membership.agentId ?? agent.id } : undefined,
        };
        const row = authorFromBody(withDefaults);
        return { datalakeId: g.datalakeId ?? null, sql: row.sql, ok: true as const };
      })
    : [];

  return Response.json({ agent, key, grants }, { status: 201 });
}
