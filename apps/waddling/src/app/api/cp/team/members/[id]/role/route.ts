/**
 * POST /api/cp/team/members/[id]/role
 * Mock handler — changes a member's role.
 * Guarded: returns 404 when NEXT_PUBLIC_CONTROL_API_URL is set (real API in use).
 *
 * Body: { role: 'owner' | 'admin' | 'member' }
 * Response: { ok: true }
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  // Parse but don't validate in the mock — caller already guards sole-owner
  await request.json();
  return Response.json({ ok: true });
}
