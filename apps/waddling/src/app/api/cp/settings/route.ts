/**
 * /api/cp/settings (W1) — org settings read for the dashboard Settings page.
 *
 * GET → { org, members, apiKeys } for the caller's org. `org` is the
 * organization row; `members` joins member→user for names/emails; `apiKeys`
 * are the org's agents' Better Auth `apikey` rows (linked via agent.api_key_id).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, handle, ok, err } from '../_shared';

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);

    const org = await queryOne<OrgRow>(
      `SELECT id, name, slug, "createdAt" FROM "organization" WHERE id = $1`,
      [caller.orgId],
    );
    if (!org) return err('org_not_found', 404);

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

    return ok({
      org: { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt },
      members,
      apiKeys,
    });
  });
}
