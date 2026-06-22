/**
 * /api/cp/device-link — Hono port of apps/waddling/src/app/api/cp/device-link/*
 * (FUNNEL / Stream B — device-code onboarding).
 *
 * POST  /        → start a link (UNAUTHENTICATED): mint a human-friendly code + an
 *                  opaque pollToken, persist a pending row (15m TTL), return the
 *                  verify URL the agent shows the human. Per-IP rate-limited.
 * POST  /claim   → claim a pending code (SESSION-AUTHENTICATED human): create a
 *                  waddling.agent + a bound sk_agent_… API key, stash the plaintext
 *                  key for one-shot poll delivery, flip the row to 'claimed'.
 * GET   /poll    → poll with the pollToken (UNAUTHENTICATED): returns pending /
 *                  expired / claimed; the apiKey is delivered EXACTLY ONCE via an
 *                  atomic UPDATE … RETURNING that NULLs api_key_once in one statement.
 *
 * The device-link _shared.ts helpers (code/token generation, the in-memory per-IP
 * rate-limit bucket) are inlined here. PostHog (posthog-node) does not bundle/run on
 * workerd, so the funnel-event surface is a guarded no-op (mirrors lib/agent-identity)
 * — the request paths are otherwise byte-faithful.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { buildAuth } from '../lib/auth';
import { getEntitlements } from '../lib/entitlements';
import { resolveCaller, parseBody, handle, ok, err, AuthError } from '../lib/cp-shared';
import { makePostHog } from '../lib/posthog';
import type { DeviceLinkInit, DeviceLinkClaimResult, DeviceLinkPoll } from '../lib/types';

// ── Code / token generation (ported from device-link/_shared.ts) ─────────────────

// Crockford-ish alphabet minus ambiguous chars (0/O, 1/I/L) for human readout.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 8-char human-friendly code formatted as XXXX-XXXX (case-insensitive on claim). */
function generateCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalize user-typed codes: uppercase, strip non-alphanumerics, re-hyphenate. */
function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** Opaque, URL-safe poll token (not shown to humans). */
function generatePollToken(): string {
  return `dlt_${randomBytes(24).toString('base64url')}`;
}

function newId(): string {
  return randomUUID();
}

// ── In-memory IP rate-limit bucket (ported from device-link/_shared.ts) ──────────
// Fixed-window: at most N starts per IP per window. Best-effort (per-isolate) — the
// device-link POST is unauthenticated, so this is a cheap abuse brake, not a security
// boundary. Resets across isolate recycles; that's fine for an onboarding funnel.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= MAX_PER_WINDOW) return false;
  b.count += 1;
  return true;
}

/** Best-effort client IP from common proxy headers. */
function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

// ── PostHog ─────────────────────────────────────────────────────────────────────
// Real server-side funnel events over PostHog's HTTP ingestion (makePostHog) — the
// device-code onboarding funnel: device_link_created/claimed, the device→user alias +
// identify, and agent_created. Fire-and-forget via the request executionCtx; a no-op
// when POSTHOG_KEY is unset. Email is a person property on identify only — never an
// event property.

/** device:<uuid> distinct id used pre-auth so we can alias to the user on claim. */
function deviceDistinctId(deviceId: string): string {
  return `device:${deviceId}`;
}

// ── Schemas ────────────────────────────────────────────────────────────────────────

const InitSchema = z.object({
  deviceId: z.string().min(1).max(200),
});

const ClaimSchema = z.object({
  code: z.string().min(1),
  orgId: z.string().optional(),
  agentName: z.string().min(1).max(120).optional(),
});

// ── Routes ───────────────────────────────────────────────────────────────────────

const deviceLink = new Hono<{ Bindings: Env }>();

// POST / — start a device link (UNAUTHENTICATED).
deviceLink.post('/', (c) =>
  handle(c, async () => {
    const ip = clientIp(c);
    if (!rateLimitOk(ip)) {
      return err(
        c,
        'rate_limited',
        429,
        'Too many device-link requests from this IP. Wait a minute and retry.',
      );
    }

    const { deviceId } = await parseBody(c, InitSchema);

    const id = newId();
    const code = generateCode();
    const pollToken = generatePollToken();

    await query(
      `INSERT INTO waddling.device_link (id, code, device_id, poll_token, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [id, code, deviceId, pollToken],
    );

    const row = await query<{ expires_at: string }>(
      `SELECT expires_at FROM waddling.device_link WHERE id = $1`,
      [id],
    );
    const expiresAt = row.rows[0]?.expires_at ?? new Date(Date.now() + 15 * 60_000).toISOString();

    // Public app URL the verify link is built from (original read NEXT_PUBLIC_APP_URL).
    // Falls back to BETTER_AUTH_URL — the app's own base URL in this deployment.
    const appUrl = (c.env.APP_URL ?? c.env.BETTER_AUTH_URL).replace(/\/+$/, '');
    const verifyUrl = `${appUrl}/link?code=${encodeURIComponent(code)}`;

    makePostHog(c.env, c.executionCtx).capture({
      distinctId: deviceDistinctId(deviceId),
      event: 'device_link_created',
      properties: { source: 'mcp-external' },
    });

    const body: DeviceLinkInit = { code, verifyUrl, pollToken, expiresAt };
    return ok(c, body, 201);
  }),
);

// POST /claim — a signed-in human claims a pending code (SESSION-AUTHENTICATED).
deviceLink.post('/claim', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (caller.kind !== 'user') {
      throw new AuthError('session_required', 403, 'Claiming a device link requires a dashboard session');
    }
    const input = await parseBody(c, ClaimSchema);
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
      return err(c, 'invalid_code', 404, 'That code is invalid, already claimed, or expired.');
    }

    const agentName = input.agentName?.trim() || 'claude-code';

    // Agent quota (same gate as /api/cp/agents).
    const ent = await getEntitlements(orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.agent WHERE org_id = $1 AND status <> 'revoked'`,
      [orgId],
    );
    if (Number(count?.n ?? 0) >= ent.agents) {
      return err(c, 'agent_quota_exceeded', 402, `Plan allows ${ent.agents} agent(s)`);
    }

    // Create the Better Auth API key bound to the org (uses caller's session).
    const created = await buildAuth(c.env).api.createApiKey({
      body: {
        name: agentName,
        organizationId: orgId,
        metadata: { agent: agentName, via: 'device-link' },
      },
      headers: c.req.raw.headers,
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
        return err(c, 'agent_name_taken', 409, `An agent named "${agentName}" already exists. Pick another name.`);
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

    const ph = makePostHog(c.env, c.executionCtx);
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
      properties: { default_role: 'reader', via: 'device-link' },
      groups: { organization: orgId },
    });

    const body: DeviceLinkClaimResult = { status: 'claimed', agentId, agentName, orgId };
    return ok(c, body, 201);
  }),
);

// GET /poll?token=… — the onboarding agent polls until a human claims (UNAUTHENTICATED).
deviceLink.get('/poll', (c) =>
  handle(c, async () => {
    const token = new URL(c.req.url).searchParams.get('token') ?? '';
    if (!token) {
      // Treat a missing/unknown token as expired so we never leak existence.
      return ok<DeviceLinkPoll>(c, { status: 'expired' });
    }

    // Lazily mark past-TTL pending rows expired (no background sweeper needed).
    await query(
      `UPDATE waddling.device_link
          SET status = 'expired'
        WHERE poll_token = $1 AND status = 'pending' AND expires_at <= now()`,
      [token],
    );

    const row = await query<{
      status: 'pending' | 'claimed' | 'expired';
      api_key_once: string | null;
      org_id: string | null;
      agent_id: string | null;
    }>(
      `SELECT status, api_key_once, org_id, agent_id
         FROM waddling.device_link
        WHERE poll_token = $1`,
      [token],
    );

    const r = row.rows[0];
    if (!r) return ok<DeviceLinkPoll>(c, { status: 'expired' });
    if (r.status !== 'claimed') return ok<DeviceLinkPoll>(c, { status: r.status });

    // Atomic one-shot key delivery: claim & NULL in a single statement.
    const delivered = await query<{ api_key_once: string; org_id: string | null; agent_id: string | null }>(
      `UPDATE waddling.device_link
          SET api_key_once = NULL
        WHERE poll_token = $1 AND api_key_once IS NOT NULL
        RETURNING api_key_once, org_id, agent_id`,
      [token],
    );

    const d = delivered.rows[0];
    if (d) {
      return ok<DeviceLinkPoll>(c, {
        status: 'claimed',
        apiKey: d.api_key_once,
        orgId: d.org_id ?? undefined,
        agentId: d.agent_id ?? undefined,
      });
    }
    // Already delivered — claimed but no key.
    return ok<DeviceLinkPoll>(c, { status: 'claimed' });
  }),
);

export { deviceLink };
