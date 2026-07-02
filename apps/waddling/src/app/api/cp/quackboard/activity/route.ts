import { makeFixtureEntries } from '@/lab/fixtures/quackboard';

/**
 * GET /api/cp/quackboard/activity?topicId=<id>
 * Returns activity entries for the given topic, or all entries when the
 * `topicId` param is omitted. Entries are newest-first. Timestamps are
 * computed at request time so relative display stays accurate.
 */
export function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const topicId = searchParams.get('topicId') ?? undefined;
  return Response.json({ entries: makeFixtureEntries(topicId) });
}
