import {
  FIXTURE_TEAM_ORG,
  FIXTURE_TEAM_MEMBERS,
  FIXTURE_TEAM_INVITES,
} from '@/lab/fixtures/team';
import type { TeamInviteRow } from '@/lab/fixtures/team';

/**
 * GET /api/cp/team
 * Mock handler — returns org info, active members, and pending invites.
 * Guarded: returns 404 when NEXT_PUBLIC_CONTROL_API_URL is set (real API in use).
 *
 * Shape: { org: TeamOrgInfo; members: TeamMemberRow[]; invites: TeamInviteRow[] }
 *
 * NOTE: This route is separate from /api/cp/settings (used by (dashboard)/settings)
 * to avoid shape collisions — that route returns { org, members, apiKeys } with a
 * different MemberRow shape (no status:'invited' or isCurrentUser).
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({
    org: FIXTURE_TEAM_ORG,
    members: FIXTURE_TEAM_MEMBERS,
    invites: FIXTURE_TEAM_INVITES,
  });
}

/**
 * POST /api/cp/team
 * Mock handler — sends an invitation email and returns an optimistic invite row.
 * Body: { email: string; role: 'admin' | 'member' }
 * Response: { ok: true; invite: TeamInviteRow }
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const body = (await request.json()) as { email?: string; role?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  const role = body.role === 'admin' ? 'admin' : 'member';

  const invite: TeamInviteRow = {
    id: `inv_${Math.random().toString(16).slice(2, 10)}`,
    email,
    role,
    invitedAt: new Date().toISOString(),
    invitedBy: FIXTURE_TEAM_MEMBERS.find((m) => m.isCurrentUser)?.email ?? 'mirri@anomalous.computer',
  };

  // Validate: members can't be re-invited (basic guard for the mock)
  const alreadyMember = FIXTURE_TEAM_MEMBERS.some((m) => m.email === email);
  if (alreadyMember) {
    return Response.json(
      { error: `${email} is already a member.` },
      { status: 409 },
    );
  }

  return Response.json({ ok: true, invite }, { status: 201 });
}
