/**
 * POST /api/cp/device-link/claim  (FUNNEL / Stream B — SESSION-AUTHENTICATED)
 *
 * A signed-in human (from the /link page) claims a pending device code. We:
 *   1. resolve the caller's org (explicit orgId must belong to them),
 *   2. create a waddling.agent + a bound sk_agent_… API key (same path as
 *      /api/cp/agents POST — reuses auth.api.createApiKey + the agent row),
 *   3. stash the plaintext key in device_link.api_key_once for ONE-shot poll
 *      delivery and flip the row to 'claimed'.
 *
 * PostHog: device_link_claimed + alias(device:<deviceId> → userId) + identify +
 * agent_created — closing the pre-auth → user funnel.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { getEntitlements } from '@/lib/entitlements';
import { resolveCaller, parseBody, handle, ok, err, AuthError } from '../../_shared';
import type { DeviceLinkClaimResult } from '@waddling/control-schema';
import { normalizeCode, posthog, deviceDistinctId } from '../_shared';

const ClaimSchema = z.object({
  code: z.string().min(1),
  orgId: z.string().optional(),
  agentName: z.string().min(1).max(120).optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    if (caller.kind !== 'user') {
      throw new AuthError('session_required', 403, 'Claiming a device link requires a dashboard session');
    }
    const input = await parseBody(req, ClaimSchema);
    const code = normalizeCode(input.code);

    // If the human chose an org, it must be one they belong to.
    let orgId = caller.orgId;
    if (input.orgId) {
      const member = await queryOne<{ organizationId: string }>(
        `SELECT "organizationId" FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, input.orgId],
      ).catch(() => null);
      if (!member) {
        throw new AuthError('forbidden', 403, 'You are not a member of that organization');
      }
      orgId = input.orgId;
    }
    if (!orgId) {
      throw new AuthError('no_organization', 403, 'No organization to attach the agent to');
    }

    // Find a live pending link for this code.
    const link = await queryOne<{ id: string; device_id: string }>(
      `SELECT id, device_id FROM waddling.device_link
        WHERE code = $1 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [code],
    );
    if (!link) {
      return err('invalid_code', 404, 'That code is invalid, already claimed, or expired.');
    }

    const agentName = input.agentName?.trim() || 'claude-code';

    // Agent quota (same gate as /api/cp/agents).
    const ent = await getEntitlements(orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.agent WHERE org_id = $1 AND status <> 'revoked'`,
      [orgId],
    );
    if (Number(count?.n ?? 0) >= ent.agents) {
      return err('agent_quota_exceeded', 402, `Plan allows ${ent.agents} agent(s)`);
    }

    // Create the Better Auth API key bound to the org (uses caller's session).
    const created = await auth.api.createApiKey({
      body: {
        name: agentName,
        organizationId: orgId,
        metadata: { agent: agentName, via: 'device-link' },
      },
      headers: req.headers,
    });

    let agentId: string;
    try {
      const agent = await queryOne<{ id: string }>(
        `INSERT INTO waddling.agent (org_id, name, description, api_key_id, default_role, status)
         VALUES ($1,$2,$3,$4,'reader','active') RETURNING id`,
        [orgId, agentName, 'Connected via device link', created.id],
      );
      agentId = agent!.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return err('agent_name_taken', 409, `An agent named "${agentName}" already exists. Pick another name.`);
      }
      throw e;
    }

    // Flip the link to claimed and stash the one-shot key.
    await query(
      `UPDATE waddling.device_link
          SET status = 'claimed', claimed_by_user = $2, org_id = $3,
              agent_id = $4, api_key_once = $5
        WHERE id = $1`,
      [link.id, caller.callerId, orgId, agentId, created.key],
    );

    // ── Funnel: alias the device to the user, identify, record the claim ──
    // Email is a PERSON property on identify (allowed) — never put it in event
    // properties. Read it from the user row (cheap, already authenticated).
    const userRow = await queryOne<{ email: string }>(
      `SELECT email FROM "user" WHERE id = $1`,
      [caller.callerId],
    ).catch(() => null);

    const ph = posthog();
    ph.alias({ distinctId: deviceDistinctId(link.device_id), alias: caller.callerId });
    ph.identify({
      distinctId: caller.callerId,
      properties: {
        ...(userRow?.email ? { email: userRow.email } : {}),
        $set_once: { onboarded_via: 'device-link' },
      },
    });
    ph.capture({
      distinctId: caller.callerId,
      event: 'device_link_claimed',
      properties: { agent_name: agentName },
      groups: { organization: orgId },
    });
    ph.capture({
      distinctId: caller.callerId,
      event: 'agent_created',
      properties: { via: 'device-link' },
      groups: { organization: orgId },
    });

    const body: DeviceLinkClaimResult = { status: 'claimed', agentId, agentName, orgId };
    return ok(body, 201);
  });
}
