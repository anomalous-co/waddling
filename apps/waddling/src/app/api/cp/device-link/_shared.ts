/**
 * Device-link route helpers (FUNNEL / Stream B).
 *
 * Self-contained glue for the three /api/cp/device-link/* routes:
 *   - human-friendly code + opaque poll-token generation
 *   - a simple in-memory per-IP rate-limit bucket for the unauthenticated POST
 *   - a lazily-constructed posthog-node singleton for server-side funnel events
 *
 * Reuses the structured-error funnel from ../_shared (err/ok/handle) so device
 * routes behave like the rest of /api/cp/*.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

// ── Code / token generation ──────────────────────────────────────────────────

// Crockford-ish alphabet minus ambiguous chars (0/O, 1/I/L) for human readout.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 8-char human-friendly code formatted as XXXX-XXXX (case-insensitive on claim). */
export function generateCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalize user-typed codes: uppercase, strip non-alphanumerics, re-hyphenate. */
export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** Opaque, URL-safe poll token (not shown to humans). */
export function generatePollToken(): string {
  return `dlt_${randomBytes(24).toString('base64url')}`;
}

export function newId(): string {
  return randomUUID();
}

// ── In-memory IP rate-limit bucket ───────────────────────────────────────────
// Fixed-window: at most N starts per IP per window. Best-effort (per-process) —
// the device-link POST is unauthenticated, so this is a cheap abuse brake, not a
// security boundary. Resets across deploys; that's fine for an onboarding funnel.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimitOk(ip: string): boolean {
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
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

// ── PostHog server singleton ─────────────────────────────────────────────────
// flushAt:1 keeps funnel events from being lost in short-lived serverless
// invocations. Disabled when WADDLING_TELEMETRY=0 (returns a no-op).

let _ph: PostHog | null | undefined;

interface PhLike {
  capture(args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  }): void;
  alias(args: { distinctId: string; alias: string }): void;
  identify(args: {
    distinctId: string;
    properties?: Record<string, unknown>;
  }): void;
}

const NOOP_PH: PhLike = {
  capture() {},
  alias() {},
  identify() {},
};

const PLACEHOLDER_KEY = 'ph_placeholder';

function bakedKey(): string | undefined {
  const key = process.env['POSTHOG_KEY'] ?? process.env['NEXT_PUBLIC_POSTHOG_KEY'];
  return key && key !== PLACEHOLDER_KEY ? key : undefined;
}

/** Enabled only when not opted-out AND a real (non-placeholder) key is baked. */
export function telemetryEnabled(): boolean {
  return process.env['WADDLING_TELEMETRY'] !== '0' && !!bakedKey();
}

export function posthog(): PhLike {
  if (!telemetryEnabled()) return NOOP_PH;
  if (_ph === undefined) {
    _ph = new PostHog(bakedKey()!, {
      host: process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _ph ?? NOOP_PH;
}

/** device:<uuid> distinct id used pre-auth so we can alias to the user on claim. */
export function deviceDistinctId(deviceId: string): string {
  return `device:${deviceId}`;
}
