/**
 * DELETE /api/cp/acl/:id
 * Removes a single literal GRANT/DENY statement row by id (spec §13). The UI
 * removes it optimistically. Mirrors control-api's `{ success, id }` envelope.
 * Guards against serving when the real control-api is configured.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { id } = await params;
  return Response.json({ success: true, id });
}
