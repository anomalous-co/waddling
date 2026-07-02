import { FIXTURE_TEAM_DELEGATIONS } from '@/lab/fixtures/team';

/**
 * GET /api/cp/team/delegations
 * Mock handler — returns the org's human→agent delegation records.
 * Guarded: returns 404 when NEXT_PUBLIC_CONTROL_API_URL is set (real API in use).
 *
 * Shape: { delegations: TeamDelegationRow[] }
 *
 * NOTE: Separate from /api/cp/delegations (used by (dashboard)/connected) which
 * returns the ACL-grant shaped DelegationRow (schemaName/tableName/capability).
 * These two routes serve different UX surfaces with different data shapes.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ delegations: FIXTURE_TEAM_DELEGATIONS });
}
