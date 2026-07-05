import { makeCatalog } from '@/lab/fixtures/catalog';

/**
 * GET /api/cp/datalakes/:id/catalog
 *
 * Lab MOCK for the schema browser — the unfiltered, admin-only authoring catalog
 * snapshot (schemas → tables → columns) birdshot serves. Shape:
 *
 *   { schemas: [{ name, tables: [{ name, columns: [{ name, type }] }] }], fetchedAt, stale? }
 *
 * `fetchedAt === null` (+ empty schemas) models a still-provisioning lake; a real
 * gateway-unreachable case surfaces as a fetch error the client handles.
 *
 * In production the browser calls control-api directly; this 404s once
 * NEXT_PUBLIC_CONTROL_API_URL is set. Local/UX-lab only.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  const snapshot = makeCatalog(id);
  return Response.json({ datalakeId: id, ...snapshot });
}
