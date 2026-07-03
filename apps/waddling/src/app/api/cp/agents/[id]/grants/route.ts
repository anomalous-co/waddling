import { makeFixtureKeyGrants } from '@/lab/fixtures/grants';

/**
 * GET /api/cp/agents/:id/grants?datalakeId=…
 *
 * Lab MOCK for the agent-detail Grant SQL panel. Returns the key's LITERAL
 * GRANT/DENY SQL for a datalake — the subject's own rows ∪ PUBLIC ∪ transitive
 * roles — verbatim, exactly as control-api's `grantsForKey` resolves them.
 *
 * In production these `/api/cp/*` handlers do NOT run: the browser calls the
 * standalone control-api Worker directly (fetchCp → cpUrl → control-api origin),
 * and this route 404s the moment NEXT_PUBLIC_CONTROL_API_URL is set. It only
 * serves the local/UX-lab single-origin dev where control-api is unconfigured.
 *
 * Mirrors the sibling mock at `keys/route.ts` (guard + fixture).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  const datalakeId = new URL(request.url).searchParams.get('datalakeId');
  if (!datalakeId) {
    return Response.json(
      { error: 'datalakeId query param is required', code: 'datalakeId_required' },
      { status: 400 },
    );
  }
  const statements = makeFixtureKeyGrants(id, datalakeId);
  return Response.json({ agentId: id, datalakeId, statements });
}
