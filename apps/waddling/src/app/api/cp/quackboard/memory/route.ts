import { makeFixtureMemory } from '@/lab/fixtures/quackboard';

/**
 * GET /api/cp/quackboard/memory?agent=<id>
 * Returns per-agent durable memory entries. The agent's private store is
 * surfaced here for human oversight — read-only. Timestamps are computed at
 * request time. Omit the `agent` param to retrieve all agents' memory.
 */
export function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agent') ?? undefined;
  return Response.json({ entries: makeFixtureMemory(agentId) });
}
