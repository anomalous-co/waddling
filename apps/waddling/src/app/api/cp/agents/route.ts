import { makeFixtureAgents } from '@/lab/fixtures/agents';
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
 * Expected body: { name: string; description?: string; mode?: 'read-only' | 'read-write' }
 * Response: { agent: AgentSummary; key: string }
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const body = (await request.json()) as {
    name?: string;
    description?: string;
    mode?: string;
  };

  const name = (body.name ?? 'unnamed-agent').trim();
  const description = body.description?.trim();

  // Generate a believable reveal-once key
  const randomHex = () =>
    Math.random().toString(16).slice(2).padStart(16, '0');
  const key = `sk_agent_${randomHex()}${randomHex()}`;

  const agent: AgentSummary = {
    id: `agt_${randomHex()}`,
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    name,
    description,
    defaultRole: 'reader',
    mode: 'autonomous',
    status: 'active',
    lastSeenAt: undefined,
    owner: 'mirri@anomalous.computer',
    activeSessions: 0,
  };

  return Response.json({ agent, key }, { status: 201 });
}
