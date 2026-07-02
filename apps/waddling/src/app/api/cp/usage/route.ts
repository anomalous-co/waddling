import {
  FIXTURE_USAGE_ROLLUP,
  FIXTURE_USAGE_SERIES,
  FIXTURE_CREDIT_BALANCE_CENTS,
} from '@/lab/fixtures/usage';

/**
 * GET /api/cp/usage
 * Mock handler — returns fixture usage rollup + series for the UX lab.
 * `creditBalance` (cents) is a lab-local extension field not yet in the schema.
 * Guards against serving when the real control-api is configured.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({
    rollup: FIXTURE_USAGE_ROLLUP,
    series: FIXTURE_USAGE_SERIES,
    creditBalance: FIXTURE_CREDIT_BALANCE_CENTS,
  });
}
