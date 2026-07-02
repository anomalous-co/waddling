import { makeFixtureWorkspaces } from '@/lab/fixtures/workspaces';

/**
 * GET /api/cp/workspaces
 * Mock handler — returns fixture workspace summaries for the UX lab.
 * Workspaces are per-agent durable DuckDB scratch DBs attached to a data lake.
 * Guards against serving when the real control-api is configured.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ workspaces: makeFixtureWorkspaces() });
}
