// PostHog telemetry for the External MCP server (FUNNEL / Stream B).
//
// posthog-node singleton tuned for a stdio CLI: flushAt:1 so single events are
// not lost when the process is short-lived, and an awaited shutdown() on exit.
// Disabled (no-op) when WADDLING_TELEMETRY=0 or no real POSTHOG_KEY is baked.
//
// Identity: distinct_id is always `device:<uuid>` pre-link; the control plane
// performs alias(device:<id> → userId) server-side at claim, so the CLI never
// needs the userId. NEVER capture SQL text, API keys, JWTs, or emails here.

import { PostHog } from "posthog-node";

// Placeholder sentinel: when POSTHOG_KEY is unset (or left at this value) no real
// key is baked, so telemetry stays a no-op — we never open an HTTP client.
const PLACEHOLDER_KEY = "ph_placeholder";

export interface Telemetry {
  capture(event: string, properties?: Record<string, unknown>): void;
  /** Mark a $set_once person property the first time it's seen this process. */
  setOnce(property: string, properties?: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

const NOOP: Telemetry = {
  capture() {},
  setOnce() {},
  async shutdown() {},
};

/** Enabled only when not opted-out AND a real (non-placeholder) key is baked. */
export function telemetryEnabled(): boolean {
  if (process.env["WADDLING_TELEMETRY"] === "0") return false;
  const key = process.env["POSTHOG_KEY"];
  return !!key && key !== PLACEHOLDER_KEY;
}

/**
 * Build a telemetry handle bound to a device distinct-id. Call shutdown() once
 * before process exit to flush. When disabled, returns a no-op handle that opens
 * no network client (important for the stdio CLI: no per-event POST, no exit hang).
 */
export function createTelemetry(deviceId: string): Telemetry {
  if (!telemetryEnabled()) return NOOP;
  const distinctId = `device:${deviceId}`;
  const client = new PostHog(process.env["POSTHOG_KEY"]!, {
    host: process.env["POSTHOG_HOST"] ?? "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
  // Track $set_once keys already sent this process so first_query fires once.
  const seen = new Set<string>();
  return {
    capture(event, properties) {
      try {
        client.capture({ distinctId, event, properties });
      } catch {
        /* telemetry must never break the tool */
      }
    },
    setOnce(property, properties) {
      if (seen.has(property)) return;
      seen.add(property);
      try {
        // Canonical event name (e.g. 'first_query'); the $set_once payload lands
        // on the person profile, deduped server-side too.
        client.capture({ distinctId, event: property, properties: { ...properties, $set_once: { [property]: true } } });
      } catch {
        /* ignore */
      }
    },
    async shutdown() {
      try {
        await client.shutdown();
      } catch {
        /* ignore */
      }
    },
  };
}
