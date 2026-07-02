import { makeFixtureGroups } from '@/lab/fixtures/quackboard';

/**
 * GET /api/cp/quackboard/groups
 * Returns project groups and their topics.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json(makeFixtureGroups());
}
