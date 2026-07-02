import { makeFixtureAgentRow } from '@/lab/fixtures/agents';

/**
 * POST /api/cp/agents/:id/suspend
 * Suspends the given agent. Returns the updated agent with status='suspended'.
 * Mock: echoes the fixture agent with status overridden. UI updates optimistically.
 * Guards against serving when the real control-api is configured.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  const agent = makeFixtureAgentRow(id);
  if (!agent) {
    return Response.json({ error: `Agent '${id}' not found` }, { status: 404 });
  }
  return Response.json({ agent: { ...agent, status: 'suspended' } });
}
