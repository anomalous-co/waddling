/**
 * /api/cp/team — org team management (members, invitations, human→agent delegations).
 *
 * Distinct from /api/cp/settings: that route returns { org, members, apiKeys } with a
 * lean MemberRow; the team surface needs a richer shape (invited status separated out,
 * isCurrentUser for the self-removal guard, and a delegations view). Both read the same
 * Better Auth tables ("organization", "member", "invitation", "user") + waddling.delegation.
 *
 * GET  /                          → { org, members, invites }
 * POST /                          → invite a member (or re-send an existing pending invite)
 * GET  /delegations               → { delegations } (org-wide; owner/admin only, else empty)
 * POST /members/:id/role          → change a member's role (owner/admin only; sole-owner guard)
 * DELETE /members/:id             → remove a member (owner/admin only; sole-owner guard)
 * POST /invites/:id/revoke        → cancel a pending invitation (owner/admin only)
 * POST /delegations/:id/revoke    → revoke any principal's delegation (owner/admin only) + recompile
 *
 * Mutations are gated to org owner/admin. Reads (GET /) are allowed to any member.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { getEntitlements } from '../lib/entitlements';
import { recompileAndEnqueue } from '../lib/gateway-dispatch';
import { resolveCaller, parseBody, handle, ok, err, type Caller } from '../lib/cp-shared';
import { sendEmail, invitationEmail } from '../lib/email';

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 86400e3;

// ── Role helpers ────────────────────────────────────────────────────────────────
// Better Auth stores member.role as a string; it MAY be comma-separated for multiple
// roles (delegations.ts splits the same way). Normalise to the single highest-privilege
// role the UI renders, and detect ownership for the sole-owner guard.

function roleList(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map((r) => r.trim()).filter(Boolean);
}

function highestRole(raw: string | null | undefined): 'owner' | 'admin' | 'member' {
  const roles = roleList(raw);
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('admin')) return 'admin';
  return 'member';
}

/** Rank for the role hierarchy: a caller may only act on a STRICTLY lower-ranked member. */
function roleRank(role: 'owner' | 'admin' | 'member'): number {
  return role === 'owner' ? 3 : role === 'admin' ? 2 : 1;
}

/** The caller's normalized role in their org ('none' if not a member). */
async function getCallerRole(caller: Caller): Promise<'owner' | 'admin' | 'member' | 'none'> {
  const member = await queryOne<{ role: string }>(
    `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
    [caller.callerId, caller.orgId],
  );
  if (!member) return 'none';
  return highestRole(member.role);
}

/** True when the caller is an owner/admin of their org. */
async function isAdmin(caller: Caller): Promise<boolean> {
  const role = await getCallerRole(caller);
  return role === 'owner' || role === 'admin';
}


// ── Row types ─────────────────────────────────────────────────────────────────────

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}
interface MemberJoinRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: string | null;
  createdAt: string;
  image: string | null;
}
interface InviteJoinRow {
  id: string;
  email: string;
  role: string | null;
  expiresAt: string | null;
  inviter_email: string | null;
}
interface DelegationJoinRow {
  id: string;
  user_id: string;
  principal_name: string | null;
  principal_email: string | null;
  agent_id: string | null;
  agent_name: string | null;
  datalake_id: string | null;
  datalake_name: string | null;
  schema_name: string;
  table_name: string;
  columns: string[] | null;
  capability: string;
  created_at: string;
}

// ── scopeSummary builder ────────────────────────────────────────────────────────
// "Event Lake: read events" / "Event Lake: read events.amount,events.ts" / "All lakes: read *.*"

function scopeSummary(r: DelegationJoinRow): string {
  const lake = r.datalake_name ?? (r.datalake_id ? 'a lake' : 'All lakes');
  const sel =
    r.schema_name === '*' && r.table_name === '*'
      ? '*.*'
      : r.table_name === '*'
        ? `${r.schema_name}.*`
        : r.columns && r.columns.length > 0
          ? r.columns.map((col) => `${r.table_name}.${col}`).join(', ')
          : r.table_name;
  return `${lake}: ${r.capability} ${sel}`;
}

const team = new Hono<{ Bindings: Env }>();

// GET / — org + active members + pending invites. Any member may read.
team.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);

    const org = await queryOne<OrgRow>(
      `SELECT id, name, slug, "createdAt" FROM "organization" WHERE id = $1`,
      [caller.orgId],
    );
    if (!org) return err(c, 'org_not_found', 404);

    const memberRows = await query<MemberJoinRow>(
      `SELECT m.id, m."userId" AS "userId", u.name, u.email, m.role, m."createdAt", u.image
         FROM "member" m
         JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1
        ORDER BY m."createdAt" ASC`,
      [caller.orgId],
    );
    const members = memberRows.rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.name ?? m.email,
      email: m.email,
      role: highestRole(m.role),
      status: 'active' as const,
      joinedAt: m.createdAt,
      avatarUrl: m.image ?? undefined,
      isCurrentUser: m.userId === caller.callerId || undefined,
    }));

    // Pending invitations. Better Auth's invitation row has no createdAt; derive invitedAt
    // from expiresAt minus the known TTL (the invite path always sets expiresAt = now + TTL).
    const inviteRows = await query<InviteJoinRow>(
      `SELECT i.id, i.email, i.role, i."expiresAt", u.email AS inviter_email
         FROM "invitation" i
         LEFT JOIN "user" u ON u.id = i."inviterId"
        WHERE i."organizationId" = $1 AND i.status = 'pending'
        ORDER BY i."expiresAt" DESC`,
      [caller.orgId],
    );
    const invites = inviteRows.rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: (i.role === 'admin' ? 'admin' : 'member') as 'admin' | 'member',
      invitedAt: i.expiresAt
        ? new Date(new Date(i.expiresAt).getTime() - INVITE_TTL_MS).toISOString()
        : new Date().toISOString(),
      invitedBy: i.inviter_email ?? '',
    }));

    return ok(c, {
      org: { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt },
      members,
      invites,
    });
  }),
);

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
});

// POST / — invite a member, or re-send if a pending invite already exists. Owner/admin only.
team.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isAdmin(caller))) {
      return err(c, 'forbidden', 403, 'Owner or admin role required to invite members');
    }
    const { email: rawEmail, role } = await parseBody(c, InviteSchema);
    const email = rawEmail.trim().toLowerCase();

    // Already an active member of this org → 409 (the UI guards, but enforce server-side).
    const existingMember = await queryOne<{ id: string }>(
      `SELECT m.id FROM "member" m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1 AND lower(u.email) = $2`,
      [caller.orgId, email],
    );
    if (existingMember) {
      return err(c, 'already_member', 409, `${email} is already a member of this org`);
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    // Re-use an existing pending invite (resend) instead of stacking duplicates.
    const existingInvite = await queryOne<{ id: string }>(
      `SELECT id FROM "invitation"
        WHERE "organizationId" = $1 AND lower(email) = $2 AND status = 'pending'
        ORDER BY "expiresAt" DESC LIMIT 1`,
      [caller.orgId, email],
    );
    // Seat limit (billed tiers only). A seat = an active member OR a pending invite. A NEW
    // invite that would push the org past its plan's seat allowance is blocked; resends
    // (existingInvite) reuse an already-counted seat, so they're exempt. Mirrors the plan-
    // gate pattern (billingOn ⇒ can't enforce a paid limit with no way to pay).
    if (!existingInvite) {
      const billingOn = !!c.env.STRIPE_SECRET_KEY && !/placeholder/i.test(c.env.STRIPE_SECRET_KEY);
      if (billingOn) {
        const ent = await getEntitlements(caller.orgId);
        const seatCount = await queryOne<{ n: string }>(
          `SELECT (
             (SELECT count(*) FROM "member" WHERE "organizationId" = $1)
             + (SELECT count(*) FROM "invitation" WHERE "organizationId" = $1 AND status = 'pending')
           )::text AS n`,
          [caller.orgId],
        );
        if (Number(seatCount?.n ?? 0) >= ent.seats) {
          return err(
            c,
            'seat_quota_exceeded',
            402,
            `Plan allows ${ent.seats} user(s). Upgrade to invite more.`,
          );
        }
      }
    }

    let invitationId: string;
    if (existingInvite) {
      invitationId = existingInvite.id;
      await query(
        `UPDATE "invitation" SET role = $2, "expiresAt" = $3, "inviterId" = $4 WHERE id = $1`,
        [invitationId, role, expiresAt, caller.callerId],
      );
    } else {
      invitationId = crypto.randomUUID();
      await query(
        `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
        [invitationId, caller.orgId, email, role, expiresAt, caller.callerId],
      );
    }

    // Best-effort email (the pending row is the source of truth — a mailer failure must not
    // fail the invite). Accept URL mirrors the Better Auth org hook + settings.ts.
    const org = await queryOne<{ name: string }>(
      `SELECT name FROM "organization" WHERE id = $1`,
      [caller.orgId],
    );
    const inviter = await queryOne<{ name: string | null; email: string }>(
      `SELECT name, email FROM "user" WHERE id = $1`,
      [caller.callerId],
    );
    const webOrigin =
      (c.env.WEB_ORIGIN ?? c.env.BETTER_AUTH_URL ?? '').split(',')[0]?.trim() || '';
    await sendEmail(
      c.env,
      email,
      invitationEmail({
        acceptUrl: `${webOrigin}/accept-invitation/${invitationId}`,
        orgName: org?.name ?? 'your team',
        role,
        inviterName: inviter?.name ?? undefined,
      }),
    ).catch(() => {/* best-effort */});

    return ok(
      c,
      {
        ok: true,
        invite: {
          id: invitationId,
          email,
          role,
          invitedAt: new Date(new Date(expiresAt).getTime() - INVITE_TTL_MS).toISOString(),
          invitedBy: inviter?.email ?? '',
        },
      },
      201,
    );
  }),
);

// GET /delegations — every principal's human→agent delegation in the org. Owner/admin only;
// a non-admin gets an empty list (graceful) rather than a 403 that would break the page load.
team.get('/delegations', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isAdmin(caller))) {
      return ok(c, { delegations: [] });
    }

    const rows = await query<DelegationJoinRow>(
      `SELECT d.id, d.user_id,
              u.name  AS principal_name,
              u.email AS principal_email,
              d.agent_id, a.name AS agent_name,
              d.datalake_id, dl.name AS datalake_name,
              d.schema_name, d.table_name, d.columns, d.capability, d.created_at
         FROM waddling.delegation d
         LEFT JOIN "user" u ON u.id = d.user_id
         LEFT JOIN waddling.agent a ON a.id = d.agent_id
         LEFT JOIN waddling.datalake dl ON dl.id = d.datalake_id
        WHERE d.org_id = $1 AND d.agent_id IS NOT NULL
        ORDER BY d.created_at DESC`,
      [caller.orgId],
    );

    const delegations = rows.rows.map((r) => ({
      id: r.id,
      principalName: r.principal_name ?? r.principal_email ?? 'Unknown user',
      principalEmail: r.principal_email ?? '',
      agentId: r.agent_id ?? '',
      agentName: r.agent_name ?? 'unknown-agent',
      scopeSummary: scopeSummary(r),
      // The delegation table only holds live rows (revoke = delete), so every row is active.
      status: 'active' as const,
      grantedAt: r.created_at,
    }));

    return ok(c, { delegations });
  }),
);

const RoleSchema = z.object({ role: z.enum(['admin', 'member']) });

// POST /members/:id/role — change a member's role. Owner/admin only; can't demote the last owner.
team.post('/members/:id/role', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const callerRole = await getCallerRole(caller);
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return err(c, 'forbidden', 403, 'Owner or admin role required to change roles');
    }
    const memberId = c.req.param('id');
    const { role } = await parseBody(c, RoleSchema);

    const target = await queryOne<{ role: string; organizationId: string }>(
      `SELECT role, "organizationId" FROM "member" WHERE id = $1`,
      [memberId],
    );
    if (!target || target.organizationId !== caller.orgId) {
      return err(c, 'member_not_found', 404);
    }
    // Role-hierarchy guard (mirrors Better Auth): a caller may only act on a member of
    // STRICTLY lower rank. Blocks an admin from demoting an owner or another admin, and
    // subsumes the sole-owner lockout — no one outranks the sole owner, so it can't be
    // demoted and the org can't be orphaned.
    if (roleRank(callerRole) <= roleRank(highestRole(target.role))) {
      return err(c, 'forbidden', 403, 'You cannot change a member whose role is equal to or higher than yours');
    }

    await query(
      `UPDATE "member" SET role = $1 WHERE id = $2 AND "organizationId" = $3`,
      [role, memberId, caller.orgId],
    );
    return ok(c, { ok: true });
  }),
);

// DELETE /members/:id — remove a member. Owner/admin only; can't remove the last owner.
team.delete('/members/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const callerRole = await getCallerRole(caller);
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      return err(c, 'forbidden', 403, 'Owner or admin role required to remove members');
    }
    const memberId = c.req.param('id');

    const target = await queryOne<{ role: string; organizationId: string }>(
      `SELECT role, "organizationId" FROM "member" WHERE id = $1`,
      [memberId],
    );
    if (!target || target.organizationId !== caller.orgId) {
      return err(c, 'member_not_found', 404);
    }
    // Role-hierarchy guard: only act on a strictly lower-ranked member. Prevents an admin
    // removing an owner/peer admin, and keeps the sole owner unremovable (no higher rank
    // exists), so the org can't be orphaned.
    if (roleRank(callerRole) <= roleRank(highestRole(target.role))) {
      return err(c, 'forbidden', 403, 'You cannot remove a member whose role is equal to or higher than yours');
    }

    await query(
      `DELETE FROM "member" WHERE id = $1 AND "organizationId" = $2`,
      [memberId, caller.orgId],
    );
    return ok(c, { ok: true });
  }),
);

// POST /invites/:id/revoke — cancel a pending invitation. Owner/admin only.
team.post('/invites/:id/revoke', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isAdmin(caller))) {
      return err(c, 'forbidden', 403, 'Owner or admin role required to revoke invites');
    }
    const inviteId = c.req.param('id');

    const target = await queryOne<{ organizationId: string }>(
      `SELECT "organizationId" FROM "invitation" WHERE id = $1`,
      [inviteId],
    );
    if (!target || target.organizationId !== caller.orgId) {
      return err(c, 'invite_not_found', 404);
    }
    await query(
      `UPDATE "invitation" SET status = 'canceled' WHERE id = $1 AND "organizationId" = $2`,
      [inviteId, caller.orgId],
    );
    return ok(c, { ok: true });
  }),
);

// POST /delegations/:id/revoke — revoke any principal's delegation (admin authority, NOT the
// own-row gate /api/cp/delegations uses) and recompile so derived grants shrink immediately.
team.post('/delegations/:id/revoke', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!(await isAdmin(caller))) {
      return err(c, 'forbidden', 403, 'Owner or admin role required to revoke delegations');
    }
    const id = c.req.param('id');

    const row = await queryOne<{ org_id: string; datalake_id: string | null }>(
      `SELECT org_id, datalake_id FROM waddling.delegation WHERE id = $1`,
      [id],
    );
    if (!row || row.org_id !== caller.orgId) {
      return err(c, 'delegation_not_found', 404);
    }

    await query(`DELETE FROM waddling.delegation WHERE id = $1 AND org_id = $2`, [id, caller.orgId]);
    // recompileAndEnqueue durably enqueues the policy push BEFORE its best-effort fast-drain
    // kick; the kick reads c.env.HYPERDRIVE (a CF binding, undefined on the GCP/Node path) and
    // can throw there. The DELETE is the source of truth and the enqueue is durable (the cron
    // drain delivers it), so a kick failure must not fail the revoke — swallow it.
    await recompileAndEnqueue(c, row.datalake_id).catch((e) => {
      console.log(`[team] delegation revoke recompile kick failed (cron will retry): ${e instanceof Error ? e.message : String(e)}`);
    });

    return ok(c, { ok: true });
  }),
);

export { team };
