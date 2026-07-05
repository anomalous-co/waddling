import { makeRoles } from '@/lab/fixtures/roles';

/**
 * GET /api/cp/roles?datalakeId=
 *
 * Lab MOCK — the org's named birdshot roles for the Picker's role combobox +
 * grant-to-role. Shape: { roles: [{ name, memberCount }] }.
 *
 * In production the browser calls control-api directly; this 404s once
 * NEXT_PUBLIC_CONTROL_API_URL is set. Local/UX-lab only.
 */
export function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const datalakeId = new URL(request.url).searchParams.get('datalakeId');
  if (!datalakeId) {
    return Response.json(
      { error: 'datalakeId query param is required', code: 'datalakeId_required' },
      { status: 400 },
    );
  }
  return Response.json({ roles: makeRoles(datalakeId) });
}
