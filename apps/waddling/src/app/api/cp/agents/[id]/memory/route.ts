import { makeFixtureMemory } from '@/lab/fixtures/quackboard';

/**
 * GET /api/cp/agents/:id/memory
 * Returns the private agent_memory entries for the given agent.
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
  const entries = makeFixtureMemory(id);
  return Response.json({ entries });
}
