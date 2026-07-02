/**
 * POST /api/cp/sessions/:id/kill
 * Kills a live session, dropping its connection. The UI removes it optimistically.
 * Guards against serving when the real control-api is configured.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  await params;
  return Response.json({ ok: true });
}
