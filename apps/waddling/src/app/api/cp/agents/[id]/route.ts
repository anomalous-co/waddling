import { makeFixtureAgentRow } from '@/lab/fixtures/agents';

/**
 * GET /api/cp/agents/:id
 * Returns full agent detail for the agent with the given id.
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
  const agent = makeFixtureAgentRow(id);
  if (!agent) {
    return Response.json({ error: `Agent '${id}' not found` }, { status: 404 });
  }
  return Response.json({ agent });
}

/**
 * DELETE /api/cp/agents/:id
 * Deletes the agent. UI removes it optimistically and navigates back.
 * Guards against serving when the real control-api is configured.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  await params;
  return Response.json({ ok: true });
}
