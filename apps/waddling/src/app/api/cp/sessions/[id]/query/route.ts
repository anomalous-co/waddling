/**
 * /api/cp/sessions/[id]/query (W1) — RETIRED.
 *
 * This route used to forward agent SQL to the gateway's POST /gw/query proxy,
 * which executed it on the gateway's TRUSTED control connection — the single
 * bypass of the birdshot chokepoint. Both are gone.
 *
 * The agent data path is now the MCP session: `waddling_connect` starts a
 * per-agent workspace actor, and `waddling_query` runs SQL on that workspace,
 * which reaches the lake only via a birdshot-gated quack connection. Agent SQL
 * never touches a trusted gateway connection.
 *
 * Kept as an authenticated stub (rather than deleted outright) so any client
 * still pointed here gets a clear, structured redirect instead of a 404. Full
 * deletion is a follow-on once all callers are on the MCP path.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { resolveCaller, handle } from '../../../_shared';

export async function POST(
  req: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    // Authenticate like the rest of the data-plane surface so this isn't an open
    // endpoint, but execute nothing — the bypass is gone.
    await resolveCaller(req, true, true);
    return NextResponse.json(
      {
        error: 'use_mcp_session',
        reason:
          'This query route is retired. Run queries through an MCP session: waddling_connect, then waddling_query. Agent SQL reaches the lake only via the birdshot-gated workspace path.',
      },
      { status: 410 },
    );
  });
}
