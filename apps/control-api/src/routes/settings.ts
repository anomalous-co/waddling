/**
 * /api/cp/settings — Hono port of apps/waddling/src/app/api/cp/settings{,/members}/route.ts.
 *
 * GET  /         → { org, members, apiKeys } for the caller's org. `org` is the
 *                  organization row; `members` joins member→user for names/emails;
 *                  `apiKeys` are the org's agents' Better Auth `apikey` rows (linked
 *                  via agent.api_key_id).
 * POST /members  → invite a member: create a pending invitation row (Better Auth
 *                  `invitation` schema) and send the invitation email (lib/email).
 *                  Returns { ok }.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, parseBody, handle, ok, err } from '../lib/cp-shared';
import { sendEmail, invitationEmail } from '../lib/email';

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
}
interface ApiKeyJoinRow {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  agent_id: string;
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
}

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
  orgId: z.string().optional(), // ignored; the caller's org is authoritative
});

const INVITE_TTL_DAYS = 7;

const settings = new Hono<{ Bindings: Env }>();

// GET / — org settings read (org + members + apiKeys).
settings.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);

    const org = await queryOne<OrgRow>(
      `SELECT id, name, slug, "createdAt" FROM "organization" WHERE id = $1`,
      [caller.orgId],
    );
    if (!org) return err(c, 'org_not_found', 404);

    const memberRows = await query<MemberJoinRow>(
      `SELECT m.id, m."userId" AS "userId", u.name, u.email, m.role, m."createdAt"
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
      role: (m.role ?? 'member') as 'owner' | 'admin' | 'member',
      joinedAt: m.createdAt,
    }));

    const keyRows = await query<ApiKeyJoinRow>(
      `SELECT k.id, k.name, k.prefix, k.start, a.id AS agent_id,
              k."createdAt", k."expiresAt", k."lastRequest"
         FROM "apikey" k
         JOIN waddling.agent a ON a.api_key_id = k.id
        WHERE a.org_id = $1
        ORDER BY k."createdAt" ASC`,
      [caller.orgId],
    );
    const apiKeys = keyRows.rows.map((k) => ({
      id: k.id,
      name: k.name ?? 'agent key',
      prefix: k.prefix ?? k.start ?? '',
      agentId: k.agent_id,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt ?? undefined,
      lastUsedAt: k.lastRequest ?? undefined,
    }));

    return ok(c, {
      org: { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt },
      members,
      apiKeys,
    });
  }),
);

// POST /members — invite a member to the caller's org.
settings.post('/members', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const { email, role } = await parseBody(c, InviteSchema);

    const invitationId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400e3).toISOString();
    await query(
      `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "inviterId")
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [invitationId, caller.orgId, email, role, expiresAt, caller.callerId],
    );

    // Send the invitation email (best-effort: the pending row is the source of truth, so a
    // mailer failure must not fail the invite). Accept URL mirrors the Better Auth org hook.
    const org = await queryOne<{ name: string }>(
      `SELECT name FROM "organization" WHERE id = $1`,
      [caller.orgId],
    );
    const inviter = await queryOne<{ name: string | null }>(
      `SELECT name FROM "user" WHERE id = $1`,
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
    );

    return ok(c, { ok: true, email, role }, 201);
  }),
);

export { settings };
