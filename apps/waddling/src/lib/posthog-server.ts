/**
 * Canonical server-side PostHog singleton (Stream C — FUNNEL).
 *
 * Uses posthog-node v5.x. Rules:
 *  - Returns a NOOP client when POSTHOG_KEY (or NEXT_PUBLIC_POSTHOG_KEY fallback)
 *    is absent — never constructs PostHog with an empty/placeholder key.
 *  - Returns a NOOP client when WADDLING_TELEMETRY=0.
 *  - Extends PhLike interface with groupIdentify (org_created events need it).
 *  - flushAt:1 / flushInterval:0 for serverless-safe fire-and-forget behaviour.
 *
 * NOTE: Stream B's device-link/_shared.ts has its own independent singleton
 * (uses a 'ph_placeholder' fallback instead of going NOOP on missing key).
 * TODO (integrator): collapse both singletons to this one after Stream B ships;
 * device-link/_shared.ts posthog() should re-export from here.
 *
 * NEVER capture: SQL text, API keys, JWTs, email addresses (emails belong only in
 * identify person-properties), or connection strings.
 */

import { PostHog } from 'posthog-node';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CaptureArgs {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}

export interface IdentifyArgs {
  distinctId: string;
  properties?: Record<string, unknown>;
}

export interface AliasArgs {
  distinctId: string;
  alias: string;
}

export interface GroupIdentifyArgs {
  groupType: string;
  groupKey: string;
  properties?: Record<string, unknown>;
}

export interface PhServer {
  capture(args: CaptureArgs): void;
  identify(args: IdentifyArgs): void;
  alias(args: AliasArgs): void;
  groupIdentify(args: GroupIdentifyArgs): void;
}

// ── NOOP ─────────────────────────────────────────────────────────────────────

const NOOP: PhServer = {
  capture() {},
  identify() {},
  alias() {},
  groupIdentify() {},
};

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: PostHog | null | undefined; // undefined = not yet resolved

function telemetryEnabled(): boolean {
  return process.env['WADDLING_TELEMETRY'] !== '0';
}

/**
 * Returns the PhServer singleton, or NOOP when telemetry is disabled or when
 * the PostHog key is absent.
 *
 * Lazy construction — safe to import at module level.
 */
export function getPostHogServer(): PhServer {
  if (!telemetryEnabled()) return NOOP;

  if (_instance === undefined) {
    const key =
      process.env['POSTHOG_KEY'] ??
      process.env['NEXT_PUBLIC_POSTHOG_KEY'] ??
      '';
    if (!key) {
      _instance = null; // no key — stay NOOP
    } else {
      _instance = new PostHog(key, {
        host:
          process.env['POSTHOG_HOST'] ??
          process.env['NEXT_PUBLIC_POSTHOG_HOST'] ??
          'https://us.i.posthog.com',
        flushAt: 1,
        flushInterval: 0,
      });
    }
  }

  return _instance ?? NOOP;
}

// ── Convenience helpers ──────────────────────────────────────────────────────

/** device:<uuid> distinct id used pre-auth for anonymous funnel tracking. */
export function deviceDistinctId(deviceId: string): string {
  return `device:${deviceId}`;
}
