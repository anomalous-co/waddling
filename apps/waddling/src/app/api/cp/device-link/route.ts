/**
 * POST /api/cp/device-link  (FUNNEL / Stream B — UNAUTHENTICATED)
 *
 * Starts an agent-driven device-code onboarding. The External MCP server
 * (ONBOARDING mode) calls this with its persisted {deviceId}; we mint a
 * human-friendly `code` + an opaque `pollToken`, persist a pending row (15m
 * TTL), and return the verify URL the agent shows the human.
 *
 * No session/API-key required — the caller has nothing yet; that's the point.
 * Abuse is bounded by a per-IP in-memory rate-limit bucket.
 *
 * PostHog: device_link_created (distinct_id = device:<deviceId>).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { getAppUrl } from '@/lib/env';
import { parseBody, handle, ok, err } from '../_shared';
import type { DeviceLinkInit } from '@waddling/control-schema';
import {
  generateCode,
  generatePollToken,
  newId,
  rateLimitOk,
  clientIp,
  posthog,
  deviceDistinctId,
} from './_shared';

const InitSchema = z.object({
  deviceId: z.string().min(1).max(200),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const ip = clientIp(req);
    if (!rateLimitOk(ip)) {
      return err(
        'rate_limited',
        429,
        'Too many device-link requests from this IP. Wait a minute and retry.',
      );
    }

    const { deviceId } = await parseBody(req, InitSchema);

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

    const appUrl = getAppUrl().replace(/\/+$/, '');
    const verifyUrl = `${appUrl}/link?code=${encodeURIComponent(code)}`;

    posthog().capture({
      distinctId: deviceDistinctId(deviceId),
      event: 'device_link_created',
      properties: { source: 'mcp-external' },
    });

    const body: DeviceLinkInit = { code, verifyUrl, pollToken, expiresAt };
    return ok(body, 201);
  });
}
