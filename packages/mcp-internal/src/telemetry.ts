// PostHog telemetry for the Internal (admin) MCP server (FUNNEL / Stream B).
//
// Same posthog-node singleton shape as the external server: flushAt:1 for stdio,
// awaited shutdown() on exit, disabled when WADDLING_TELEMETRY=0 or no real
// POSTHOG_KEY is baked. distinct_id is device:<uuid> persisted in
// ~/.waddling/device.json (shared convention with the external CLI).
//
// NEVER capture SQL text, API keys, JWTs, or emails in properties.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PostHog } from "posthog-node";

const PLACEHOLDER_KEY = "ph_placeholder";

export interface Telemetry {
  capture(event: string, properties?: Record<string, unknown>, orgId?: string): void;
  shutdown(): Promise<void>;
}

const NOOP: Telemetry = {
  capture() {},
  async shutdown() {},
};

function getOrCreateDeviceId(): string {
  const dir = join(homedir(), ".waddling");
  const file = join(dir, "device.json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { device_id?: string };
    if (data.device_id) return data.device_id;
  } catch {
    /* create below */
  }
  const id = randomUUID();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ device_id: id }), { mode: 0o600 });
  } catch {
    /* ephemeral id is fine for this run */
  }
  return id;
}

/** Enabled only when not opted-out AND a real (non-placeholder) key is baked. */
export function telemetryEnabled(): boolean {
  if (process.env["WADDLING_TELEMETRY"] === "0") return false;
  const key = process.env["POSTHOG_KEY"];
  return !!key && key !== PLACEHOLDER_KEY;
}

export function createTelemetry(): Telemetry {
  if (!telemetryEnabled()) return NOOP;
  const distinctId = `device:${getOrCreateDeviceId()}`;
  const client = new PostHog(process.env["POSTHOG_KEY"]!, {
    host: process.env["POSTHOG_HOST"] ?? "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
  return {
    capture(event, properties, orgId) {
      try {
        client.capture({
          distinctId,
          event,
          properties,
          ...(orgId ? { groups: { organization: orgId } } : {}),
        });
      } catch {
        /* telemetry must never break the tool */
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
