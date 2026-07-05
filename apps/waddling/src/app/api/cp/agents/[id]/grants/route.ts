import { makeResolvedGrants } from '@/lab/fixtures/grants';

/**
 * GET /api/cp/agents/:id/grants?datalakeId=…
 *
 * Lab MOCK for the AccessManager. Returns the key's RESOLVED statements — the
 * subject's own rows ∪ PUBLIC ∪ transitive roles — each DECOMPOSED server-side:
 *
 *   { statements: Array<{ sql, parsed: ParsedStatement | null,
 *                         inherited: null | {via:'role',role} | {via:'public'} }> }
 *
 * The Picker renders from `parsed` (parsed===null → Advanced bucket) and reads
 * `inherited` to split own (editable) from role/PUBLIC (read-only).
 *
 * In production these `/api/cp/*` handlers do NOT run: the browser calls the
 * standalone control-api Worker directly and this route 404s once
 * NEXT_PUBLIC_CONTROL_API_URL is set. Local/UX-lab single-origin dev only.
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
  const statements = makeResolvedGrants(id, datalakeId);
  return Response.json({ agentId: id, datalakeId, statements });
}
