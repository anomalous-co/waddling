/**
 * DELETE /api/cp/acl/:id
 * Revokes a single ACL grant by id. The UI removes it optimistically.
 * Guards against serving when the real control-api is configured.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  await params; // validate presence; mock always succeeds
  return Response.json({ ok: true });
}
