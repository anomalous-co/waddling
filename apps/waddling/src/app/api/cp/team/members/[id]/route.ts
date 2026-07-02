/**
 * DELETE /api/cp/team/members/[id]
 * Mock handler — removes a member from the org.
 * Guarded: returns 404 when NEXT_PUBLIC_CONTROL_API_URL is set (real API in use).
 *
 * Response: { ok: true }
 */
export function DELETE() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ ok: true });
}
