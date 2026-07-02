/**
 * Team surface UI types.
 *
 * These are deliberately richer than the published control-schema rows (and than the
 * (dashboard)/connected DelegationRow): they carry UI-only fields like `status:'invited'`,
 * `isCurrentUser`, and a one-line human `scopeSummary`. They are the contract the real
 * /api/cp/team endpoints (apps/control-api/src/routes/team.ts) return.
 */

export interface TeamOrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

/** Active org member. `isCurrentUser` marks the logged-in user so the UI guards self-removal. */
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
  isCurrentUser?: boolean;
}

/** Pending invitation (not yet accepted). */
export interface TeamInviteRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedAt: string;
  /** Email of the org member who sent the invite. */
  invitedBy: string;
}

/**
 * Human→agent delegation: a member has lent an agent their scoped access. The agent acts
 * with (member's grants ∩ delegation scope), derived per session.
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
