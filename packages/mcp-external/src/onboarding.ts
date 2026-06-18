// Device-code onboarding for the External MCP server (FUNNEL / Stream B).
//
// When no API key resolves at startup, the server boots in ONBOARDING MODE:
//   - registers waddling_signup {}        → starts a device link, returns the
//                                            verify URL + code for the human
//   - registers waddling_signup_status {} → polls; on 'claimed' persists the key
//                                            0600 and unlocks the full surface
//   - the 8 real data tools are still registered, but gated: until linked they
//     return { error:'not_linked', hint:'Run waddling_signup …' } so the agent
//     knows exactly how to self-serve.
//
// After a successful claim the credentials are live in-memory (and on disk), so
// the full surface works WITHOUT a restart.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DeviceLinkInit, DeviceLinkPoll } from "@waddling/control-schema";
import {
  onboardingBaseUrl,
  persistCredentials,
  type ResolvedCredentials,
} from "./credentials";

/**
 * Mutable link state shared with the data tools. `creds` is null until a link is
 * claimed; the data tools read `state.creds` on every call so a mid-session
 * claim takes effect immediately.
 */
export interface LinkState {
  creds: ResolvedCredentials | null;
  deviceId: string;
  /** poll_token of the in-flight link, set by waddling_signup. */
  pollToken?: string;
  verifyUrl?: string;
}

function json(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
    ...(isError ? { isError: true } : {}),
  };
}

/** The structured payload every gated data tool returns while unlinked. */
export function notLinked(): CallToolResult {
  return json(
    {
      error: "not_linked",
      hint: "Run waddling_signup to connect this device — takes 60 seconds.",
    },
    true,
  );
}

export function registerOnboardingTools(server: McpServer, state: LinkState): void {
  const baseUrl = onboardingBaseUrl();

  server.registerTool(
    "waddling_signup",
    {
      description:
        "Connect this device to waddling (one-time, ~60s). Returns a verify_url and a short " +
        "code — show BOTH to the human and ask them to open the link and sign in. Then poll " +
        "waddling_signup_status until it reports connected. Use this whenever a waddling tool " +
        "returns { error:'not_linked' }.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const res = await fetch(`${baseUrl}/api/cp/device-link`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: state.deviceId }),
        });
        const body = (await res.json()) as DeviceLinkInit & { error?: string; detail?: string };
        if (!res.ok) {
          return json({ error: body.error ?? "signup_failed", reason: body.detail ?? res.statusText }, true);
        }
        state.pollToken = body.pollToken;
        state.verifyUrl = body.verifyUrl;
        return json({
          verify_url: body.verifyUrl,
          code: body.code,
          expires_at: body.expiresAt,
          instructions:
            "Open this link, sign in, and I will detect it automatically. " +
            "Once you've signed in, ask me to check the connection (waddling_signup_status).",
        });
      } catch (err) {
        return json({ error: "signup_failed", reason: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  server.registerTool(
    "waddling_signup_status",
    {
      description:
        "Check whether the human has finished connecting this device. On success the API key is " +
        "saved locally and the full waddling tool surface unlocks immediately (no restart) — then " +
        "RETRY the original task the user asked for. Returns { status: pending|claimed|expired }.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      if (!state.pollToken) {
        return json(
          { status: "no_pending_link", hint: "Call waddling_signup first to start a connection." },
          true,
        );
      }
      try {
        const url = `${baseUrl}/api/cp/device-link/poll?token=${encodeURIComponent(state.pollToken)}`;
        const res = await fetch(url);
        const body = (await res.json()) as DeviceLinkPoll & { error?: string; detail?: string };
        if (!res.ok) {
          return json({ error: body.error ?? "poll_failed", reason: body.detail ?? res.statusText }, true);
        }
        if (body.status === "expired") {
          state.pollToken = undefined;
          return json({
            status: "expired",
            hint: "The link expired (15m). Run waddling_signup to start a fresh one.",
          });
        }
        if (body.status === "claimed" && body.apiKey) {
          // Persist + go live in-memory so the full surface works without restart.
          persistCredentials(body.apiKey, baseUrl);
          state.creds = { apiKey: body.apiKey, baseUrl, source: "file" };
          state.pollToken = undefined;
          return json({
            status: "claimed",
            connected: true,
            message:
              "Connected. The full waddling tool surface is now available — retry the task the user " +
              "originally asked for (start with waddling_list_endpoints).",
          });
        }
        if (body.status === "claimed") {
          // Already linked on a prior poll (key already delivered).
          return json({ status: "claimed", connected: true });
        }
        return json({
          status: "pending",
          hint: state.verifyUrl
            ? `Still waiting. Make sure the human opened ${state.verifyUrl} and signed in.`
            : "Still waiting for the human to sign in.",
        });
      } catch (err) {
        return json({ error: "poll_failed", reason: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );
}
