# Loop 6 build prompt — Team (`/lab/team`)

Build the **Team** surface: the org's humans + their roles, pending invitations, and the
**delegated/connected principals** (humans who have delegated scoped access to agents). This is
the team-oriented governance home. In the ungated `(ux-lab)` design forge with mock data.

waddling context: an org has **members** (humans) with **roles** (owner / admin / member);
owners/admins manage agents, lakes, and billing. Separately, a human can **delegate** their
data access to an agent — the agent then acts with (the human's grants ∩ the agent's grants),
derived per-session and never persisted (this is the "connected" / OAuth-delegated relationship
from the old `/connected` page). The Team surface unifies "who is on this team" with "who has
lent an agent their access".

Scope discipline: ONLY create/edit under `apps/waddling/src/app/(ux-lab)/**`,
`apps/waddling/src/components/waddling/**`, `apps/waddling/src/app/api/cp/**` (mock handlers),
`apps/waddling/src/lab/fixtures/**`. Do NOT touch `(dashboard)`, `(marketing)`, `(auth)`, or
shared `ui/*`.

## Read first (reuse, match idioms)
- ALL `apps/waddling/src/components/waddling/*` primitives — REUSE: PageHeader, SectionCard
  (`headingLevel`), StatusDot, StatPill, EmptyState, CopyButton, and `agent-chips.tsx`
  (VerbChip/ModeChip) + `agent-status.ts` (formatRelative). Match the design language.
- `apps/waddling/src/app/(ux-lab)/lab/agents/page.tsx` — the roster/table + ⋯-menu + AlertDialog
  pattern is the template for the members table (destructive actions behind confirms; amber for
  reversible, destructive-red for irreversible — see how Suspend vs Delete are colored there).
- `apps/waddling/src/components/dashboard/fetch.ts` — `fetchCp`/`cpPost`. Contracts:
  `GET /api/cp/settings → { org, members, apiKeys }` (members live here),
  `POST /api/cp/settings/members → { ok }`,
  `GET /api/cp/delegations → { delegations }`.
- `apps/waddling/src/lib/types.ts` — reuse `MemberRow`, `OrgInfo`, delegation types if present;
  extend fixture-local types if a field is missing (document it).
- `apps/waddling/src/lab/fixtures/agents.ts` — reuse the SAME agent names/ids so delegations
  reference real agents.
- shadcn `select`, `dropdown-menu`, `alert-dialog`, `dialog`, `table`, `badge`, `avatar`, `input`.

## Deliverable

### 1. Mock backend (dev-gated; guard each with the NEXT_PUBLIC_CONTROL_API_URL 404 check)
- `GET /api/cp/settings` (or a focused `GET /api/cp/team`) → `{ org, members, invites }` where
  `members: { id, name, email, role: 'owner'|'admin'|'member', status: 'active'|'invited',
  joinedAt, avatarUrl? }[]` (~4 members incl. the current user as owner + one pending invite),
  and `invites: { id, email, role, invitedAt, invitedBy }[]` (~1–2 pending).
- `GET /api/cp/delegations → { delegations: { id, principalName, principalEmail, agentId,
  agentName, scopeSummary, status: 'active'|'revoked', grantedAt }[] }` — ~2–3 delegations from
  members to agents (e.g. "insight-bot acts as alice@… on Event Lake: read events, conversions").
- Mutations (echo success / optimistic): `POST /api/cp/settings/members` (invite),
  `POST /api/cp/team/members/:id/role` (change role), `DELETE /api/cp/team/members/:id` (remove),
  `POST /api/cp/team/invites/:id/revoke`, `POST /api/cp/delegations/:id/revoke`.

### 2. Team page — `src/app/(ux-lab)/lab/team/page.tsx` (replace placeholder)
- `PageHeader` "Team" + description ("People in your organization and the agents they've lent
  access to.") + a primary **"Invite member"** action (opens a Dialog: email input + role
  `Select` → POST invite; success toast + optimistic add to the list).
- A row of `StatPill`s: members, pending invites, admins/owners, active delegations.
- **Two sections** (stacked SectionCards, or a tab if cleaner — keep ONE screen):
  - **Members** — a real `<table>`: avatar + name + email, **role** (editable via a `Select` or a
    ⋯-menu "Change role" — owners can change others; the sole owner can't be demoted, and you can't
    remove yourself without transfer — surface these as disabled/explained, not silent),
    status (active / `invited` badge), joined. ⋯-menu: Change role, **Remove** (AlertDialog
    confirm; destructive-red). Pending invites appear inline (or a sub-list) with **Resend** /
    **Revoke** (revoke = confirm). EmptyState only if truly empty (won't happen — owner exists).
  - **Delegated access** — the connected principals: a list/table of delegations — principal
    (human) → agent, a one-line **scope summary**, granted-relative, status; each with **Revoke**
    (AlertDialog confirm). A one-line explainer of what delegation means + that scope is the
    intersection of the human's grants and the agent's grants (derived per session, never stored).
    First-class EmptyState ("No delegated access yet") with a short explanation.

## Quality bar (carry forward ALL prior lessons — these have been graded)
- ONE h1 per page (PageHeader); sections use real h2/h3; the Invite dialog + role Select have
  proper labels; role `Select` and any custom toggle are accessible.
- **Every destructive/irreversible action (Remove member, Revoke invite, Revoke delegation) uses a
  shadcn AlertDialog confirm**; reversible-vs-irreversible color discipline (amber vs destructive).
- Real `<table>` semantics; accessible names on icon-only controls (⋯ menus, copy); status via
  StatusDot or a clearly-labeled badge (not color alone); roles read as text.
- Keyboard-operable + visibly focusable throughout; dialogs are shadcn (accessible).
- Forward flow & few screens: ONE screen; Invite is a dialog (no nav away); no dead ends; the
  delegated-access section links agents to `/lab/agents/[id]` and explains itself.
- Dark-first AND correct in light mode (theme tokens only; no hardcoded colour except the
  established amber/destructive action-button convention). Cohesive with shell + Home + Connect +
  Data + Agents + Quackboard + the waddling/* primitives.
- TypeScript strict, no `any` in props; reuse `types.ts`/fixtures. Run `pnpm run typecheck`
  (from `apps/waddling`) and fix NEW errors in your files. Do not start a dev server.

## Output
Report: files created/changed, the `/lab/team` behavior (Members + Delegated access, invite flow,
role change, removes/revokes), new fixtures/handlers/types, what was reused, and typecheck status.
