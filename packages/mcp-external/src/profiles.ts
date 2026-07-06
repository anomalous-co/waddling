// Profile-management tools for @waddling/mcp.
//
// A "profile" is a named, durable bearer-token credential stored locally
// (~/.waddling/credentials.json) — each backed by its own waddling agent identity
// and its own ACL grants. Holding several profiles lets one npx install carry
// multiple permission scopes (e.g. "analyst" read-only, "etl" write). These tools
// are LOCAL: they read/write the credential store and never touch the data plane,
// except waddling_profile_remove, which also revokes the key server-side.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ControlPlaneError, type WaddlingClient } from "./client";
import {
  ENV_PROFILE,
  listProfiles,
  persistProfile,
  removeProfile,
  resolveProfile,
  setDefaultProfile,
} from "./credentials";

function json(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value },
    ...(isError ? { isError: true } : {}),
  };
}

/** Best-effort: read the agent identity behind a profile's key (never throws fatally). */
async function whoamiFor(client: WaddlingClient, profile: string): Promise<{ agentId?: string; agentName?: string }> {
  try {
    const r = await client.cp<{ agentId?: string; agent?: string; name?: string }>("/api/cp/whoami", { profile });
    return { agentId: r.agentId, agentName: r.agent ?? r.name };
  } catch {
    return {};
  }
}

export function registerProfileTools(server: McpServer, client: WaddlingClient): void {
  // ── waddling_profiles_list ─────────────────────────────────────────────────
  server.registerTool(
    "waddling_profiles_list",
    {
      description:
        "List the bearer-token profiles this install holds. Each profile is a durable, named " +
        "credential backed by its own waddling agent identity and ACL grants. Returns " +
        "[{ name, is_default, source, masked, base_url, agent_name? }]. Use a profile `name` as the " +
        "`profile` argument on any data or access tool to act as that identity; omit it to use the default.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const profiles = listProfiles();
      return json({
        profiles: profiles.map((p) => ({
          name: p.name,
          is_default: p.isDefault,
          source: p.source,
          masked: p.masked,
          base_url: p.baseUrl,
          agent_name: p.agentName,
        })),
        default: profiles.find((p) => p.isDefault)?.name ?? null,
        hint:
          profiles.length === 0
            ? "No profiles yet. Run waddling_signup to connect one, or waddling_profile_add to import an existing sk_ key."
            : undefined,
      });
    },
  );

  // ── waddling_profile_default ───────────────────────────────────────────────
  server.registerTool(
    "waddling_profile_default",
    {
      description:
        "Set which profile is used by default (when a tool call omits `profile`). Pass the profile " +
        "`name` from waddling_profiles_list.",
      inputSchema: {
        profile: z.string().describe("Name of the stored profile to make default."),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        setDefaultProfile(args.profile);
        return json({ ok: true, default: args.profile });
      } catch (err) {
        return json({ error: "no_such_profile", reason: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  // ── waddling_profile_add ───────────────────────────────────────────────────
  server.registerTool(
    "waddling_profile_add",
    {
      description:
        "Import an existing waddling API key (sk_agent_…) as a named profile. Use this to add a key a " +
        "human created for you in the dashboard, or to register a second identity. The key is stored " +
        "locally (0600) and validated with a whoami call. Returns the resolved agent identity.",
      inputSchema: {
        profile: z.string().describe("A short name for this profile (e.g. 'analyst', 'etl')."),
        api_key: z.string().describe("The sk_agent_… key to store under this profile."),
        base_url: z.string().optional().describe("Override the control-plane base URL (defaults to the standard host)."),
        make_default: z.boolean().optional().describe("Make this the default profile."),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        if (args.profile === ENV_PROFILE) {
          return json({ error: "reserved_name", reason: `"${ENV_PROFILE}" is reserved for WADDLING_API_KEY` }, true);
        }
        persistProfile(args.profile, args.api_key, { baseUrl: args.base_url, makeDefault: args.make_default });
        // Validate + capture the agent identity behind the key.
        const who = await whoamiFor(client, args.profile);
        if (who.agentName || who.agentId) {
          persistProfile(args.profile, args.api_key, {
            baseUrl: args.base_url,
            agentName: who.agentName,
            makeDefault: args.make_default,
          });
        }
        return json({
          ok: true,
          profile: args.profile,
          agent_id: who.agentId,
          agent_name: who.agentName,
          note: who.agentId
            ? "Key validated and stored."
            : "Stored, but the key could not be validated (whoami failed) — check it is a live sk_agent_ key.",
        });
      } catch (err) {
        return json({ error: "add_failed", reason: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  // ── waddling_profile_remove ────────────────────────────────────────────────
  server.registerTool(
    "waddling_profile_remove",
    {
      description:
        "Delete a stored profile AND revoke its key server-side (best-effort). If revocation needs a " +
        "human (owner-only), the profile is still removed locally and you'll be told to revoke it in the " +
        "dashboard. Cannot remove the env-supplied profile.",
      inputSchema: {
        profile: z.string().describe("Name of the profile to remove."),
      },
    },
    async (args): Promise<CallToolResult> => {
      if (args.profile === ENV_PROFILE) {
        return json({ error: "reserved_profile", reason: "the env profile is supplied via WADDLING_API_KEY and cannot be removed" }, true);
      }
      // Resolve the agent id BEFORE deleting locally, so we can revoke server-side.
      const who = resolveProfile(args.profile) ? await whoamiFor(client, args.profile) : {};
      let revoked = false;
      let revokeNote: string | undefined;
      if (who.agentId) {
        try {
          await client.cp(`/api/cp/agents/${encodeURIComponent(who.agentId)}`, { method: "DELETE", profile: args.profile });
          revoked = true;
        } catch (err) {
          revokeNote =
            err instanceof ControlPlaneError && err.status === 403
              ? "Server-side revoke needs an org owner — revoke this key in the dashboard (Agents → this agent → Delete)."
              : `Server-side revoke failed: ${err instanceof ControlPlaneError ? err.reason : String(err)}`;
        }
      }
      const removed = removeProfile(args.profile);
      if (!removed) return json({ error: "no_such_profile", profile: args.profile }, true);
      return json({ ok: true, profile: args.profile, revoked, agent_id: who.agentId, note: revokeNote });
    },
  );
}
