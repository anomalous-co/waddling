import { FIXTURE_LAKE_DETAILS } from '@/lab/fixtures/datalake-catalog';

/**
 * GET /api/cp/datalakes/:id
 * Mock handler — returns fixture lake detail including a catalog (schemas +
 * tables) for the connect wizard's "Scope access" step. The `catalog` field
 * is a lab-local extension of DatalakeDetail (documented in datalake-catalog.ts).
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
  const datalake = FIXTURE_LAKE_DETAILS[id];

  if (!datalake) {
    return Response.json(
      { error: `Data lake '${id}' not found` },
      { status: 404 },
    );
  }

  return Response.json({ datalake });
}
