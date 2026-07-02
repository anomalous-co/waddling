/**
 * POST /api/cp/team/delegations/[id]/revoke
 * Mock handler — marks a delegation as revoked.
 * Guarded: returns 404 when NEXT_PUBLIC_CONTROL_API_URL is set (real API in use).
 *
 * Response: { ok: true }
 */
export function POST() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ ok: true });
}
