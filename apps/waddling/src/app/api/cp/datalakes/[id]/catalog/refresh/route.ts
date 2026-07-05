import { makeCatalog } from '@/lab/fixtures/catalog';

/**
 * POST /api/cp/datalakes/:id/catalog/refresh
 *
 * Lab MOCK — forces a catalog re-snapshot (boot-on-demand in production). Returns
 * the same shape as GET /catalog with a fresh `fetchedAt`. Local/UX-lab only.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  const snapshot = makeCatalog(id);
  // A refresh of a populated lake stamps "now"; a provisioning lake stays empty.
  const fetchedAt = snapshot.schemas.length ? new Date().toISOString() : null;
  return Response.json({ datalakeId: id, ...snapshot, fetchedAt, stale: false });
}
