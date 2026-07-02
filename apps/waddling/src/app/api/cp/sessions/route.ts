import { FIXTURE_SESSIONS } from '@/lab/fixtures/sessions';

/**
 * GET /api/cp/sessions
 * Mock handler — returns fixture live sessions for the UX lab.
 * Guards against serving when the real control-api is configured.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ sessions: FIXTURE_SESSIONS });
}
