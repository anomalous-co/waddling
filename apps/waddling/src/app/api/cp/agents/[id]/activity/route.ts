import { makeFixtureActivity } from '@/lab/fixtures/agent-activity';
import type { AgentActivityRollup } from '@/lab/fixtures/agent-activity';

/**
 * GET /api/cp/agents/:id/activity
 * Returns the activity log and usage rollup for the given agent.
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
  const entries = makeFixtureActivity(id);

  // Derive rollup from entries so the metrics row stays self-consistent.
  const rollup: AgentActivityRollup = {
    queriesToday: entries.filter((e) => e.kind === 'query').length,
    denials: entries.filter((e) => e.decision === 'deny').length,
    creditSpentCents: entries.reduce((sum, e) => sum + (e.costCents ?? 0), 0),
    lastActiveAt: entries[0]?.at ?? new Date().toISOString(),
  };

  return Response.json({ entries, rollup });
}
