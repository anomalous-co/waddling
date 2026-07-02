/**
 * POST /api/cp/agents/:id/keys/:keyId/revoke
 * Revokes the specified API key. The UI optimistically removes the key.
 * Guards against serving when the real control-api is configured.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; keyId: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  // params are validated by presence — mock always succeeds
  await params;
  return Response.json({ ok: true });
}
