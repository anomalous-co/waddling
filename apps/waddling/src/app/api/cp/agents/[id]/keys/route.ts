import { makeFixtureAgentKeys } from '@/lab/fixtures/agent-keys';
import type { AgentKey } from '@/lab/fixtures/agent-keys';

/**
 * GET /api/cp/agents/:id/keys
 * Returns all keys for the given agent.
 * Guards against serving when the real control-api is configured.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  const keys = makeFixtureAgentKeys(id);
  return Response.json({ keys });
}

/**
 * POST /api/cp/agents/:id/keys
 * Issues a new reveal-once API key for the agent. The secret is returned ONCE.
 * Body: { label?: string }
 * Response: { key: AgentKey; secret: string }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  const body = (await request.json()) as { label?: string };

  const randomHex = () =>
    Math.random().toString(16).slice(2).padStart(16, '0');
  const secret = `sk_agent_${randomHex()}${randomHex()}`;
  const maskedPrefix = `${secret.slice(0, 18)}…`;

  const key: AgentKey = {
    id: `key_${randomHex().slice(0, 8)}`,
    label: (body.label ?? 'API key').trim() || 'API key',
    maskedPrefix,
    createdAt: new Date().toISOString(),
  };

  return Response.json({ key, secret, agentId: id }, { status: 201 });
}
