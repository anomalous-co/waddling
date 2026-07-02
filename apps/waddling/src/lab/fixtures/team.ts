/**
 * Team surface fixture types and data.
 *
 * These types are defined here (not in @/lib/types / control-schema) because:
 * - MemberRow in the dashboard only has { id, userId, name, email, role, joinedAt } —
 *   no `status:'invited'` or `isCurrentUser` flag.
 * - The Team delegation shape (principalName, agentId, agentName, scopeSummary) is
 *   deliberately different from (dashboard)/connected DelegationRow (ACL-grant shaped).
 * - Keeping team types here mirrors the agents-fixture precedent: richer lab-local shapes
 *   live in fixtures/, not in the published control-schema.
 *
 * agentId values in FIXTURE_TEAM_DELEGATIONS match FIXTURE_AGENTS in fixtures/agents.ts
 * so /lab/agents/[id] links resolve.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TeamOrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

/**
 * Active or invited org member.
 * `isCurrentUser` marks the logged-in user so the UI can guard self-removal.
 */
export interface TeamMemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  /** active = joined; invited = pending invite acceptance. */
  status: 'active' | 'invited';
  joinedAt: string;
  avatarUrl?: string;
  /** True for the current session user — UI guards self-removal. */
  isCurrentUser?: boolean;
}

/**
 * Pending invitation (not yet accepted).
 * Displayed as a sub-list within the Members section.
 */
export interface TeamInviteRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedAt: string;
  /** Email of the org member who sent the invite. */
  invitedBy: string;
}

/**
 * Human→agent delegation: a member has lent an agent their scoped access.
 * The agent acts with (member's grants ∩ agent's grants), derived per session.
 *
 * NOT the same as (dashboard)/connected DelegationRow — that is ACL-grant shaped.
 * These two shapes serve different UX surfaces and must not share a route.
 */
export interface TeamDelegationRow {
  id: string;
  principalName: string;
  principalEmail: string;
  agentId: string;
  agentName: string;
  /** One-line human-readable scope, e.g. "Event Lake: read events, conversions". */
  scopeSummary: string;
  status: 'active' | 'revoked';
  grantedAt: string;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

export const FIXTURE_TEAM_ORG: TeamOrgInfo = {
  id: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
  name: 'Anomalous',
  slug: 'anomalous',
  createdAt: '2025-09-01T00:00:00Z',
};

/**
 * mirri@anomalous.computer is the sole owner and current user.
 * ownerCount === 1 → demote/remove disabled for that member (sole-owner guard).
 */
export const FIXTURE_TEAM_MEMBERS: TeamMemberRow[] = [
  {
    id: 'mbr_01',
    userId: 'usr_01',
    name: 'Mirri B.',
    email: 'mirri@anomalous.computer',
    role: 'owner',
    status: 'active',
    joinedAt: '2025-09-01T00:00:00Z',
    isCurrentUser: true,
  },
  {
    id: 'mbr_02',
    userId: 'usr_02',
    name: 'Alice Chen',
    email: 'alice@anomalous.computer',
    role: 'admin',
    status: 'active',
    joinedAt: '2025-10-15T09:00:00Z',
  },
  {
    id: 'mbr_03',
    userId: 'usr_03',
    name: 'Bob Nakamura',
    email: 'bob@anomalous.computer',
    role: 'member',
    status: 'active',
    joinedAt: '2026-01-20T14:00:00Z',
  },
  {
    id: 'mbr_04',
    userId: 'usr_04',
    name: 'Priya Nair',
    email: 'priya@anomalous.computer',
    role: 'member',
    status: 'active',
    joinedAt: '2026-03-05T11:00:00Z',
  },
];

export const FIXTURE_TEAM_INVITES: TeamInviteRow[] = [
  {
    id: 'inv_01',
    email: 'dev@example.com',
    role: 'member',
    invitedAt: '2026-06-25T10:00:00Z',
    invitedBy: 'mirri@anomalous.computer',
  },
  {
    id: 'inv_02',
    email: 'analyst@partner.io',
    role: 'admin',
    invitedAt: '2026-06-27T16:00:00Z',
    invitedBy: 'alice@anomalous.computer',
  },
];

/**
 * Delegation fixtures.
 *
 * agentId values MUST match FIXTURE_AGENTS in lab/fixtures/agents.ts:
 *   agt_02j8k9m2n3p4q5r6s7t8u9v0x = insight-bot   (mode:'delegated')
 *   agt_01j8k9m2n3p4q5r6s7t8u9v0w = analytics-etl (mode:'autonomous')
 *
 * dlg_03 is revoked to demonstrate the revoked state (shown as a badge, still listed).
 */
export const FIXTURE_TEAM_DELEGATIONS: TeamDelegationRow[] = [
  {
    id: 'dlg_01',
    principalName: 'Alice Chen',
    principalEmail: 'alice@anomalous.computer',
    agentId: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    agentName: 'insight-bot',
    scopeSummary: 'Event Lake: read events, conversions',
    status: 'active',
    grantedAt: '2026-06-10T09:00:00Z',
  },
  {
    id: 'dlg_02',
    principalName: 'Mirri B.',
    principalEmail: 'mirri@anomalous.computer',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    agentName: 'analytics-etl',
    scopeSummary: 'Event Lake: read events, sessions, funnels',
    status: 'active',
    grantedAt: '2026-05-20T14:30:00Z',
  },
  {
    id: 'dlg_03',
    principalName: 'Bob Nakamura',
    principalEmail: 'bob@anomalous.computer',
    agentId: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    agentName: 'insight-bot',
    scopeSummary: 'Product Lake: read page_views',
    status: 'revoked',
    grantedAt: '2026-04-01T08:00:00Z',
  },
];
