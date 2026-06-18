/**
 * /api/cp/settings/members (W1) — invite a member to the caller's org.
 *
 * POST { email, role } → create a pending invitation row (Better Auth
 * `invitation` schema). Email delivery is owned by the deployment's mailer;
 * the demo just records the pending invite. Returns { ok: true }.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { resolveCaller, parseBody, handle, ok } from '../../_shared';

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
  orgId: z.string().optional(), // ignored; the caller's org is authoritative
});

const INVITE_TTL_DAYS = 7;

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { email, role } = await parseBody(req, InviteSchema);

    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400e3).toISOString();
    await query(
      `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "inviterId")
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [crypto.randomUUID(), caller.orgId, email, role, expiresAt, caller.callerId],
    );

    return ok({ ok: true, email, role }, 201);
  });
}
