// Scoped access-request tools for @waddling/mcp.
//
// The durable answer to "I need access I don't have": the agent describes the
// grants it wants, gets a deep-link a human opens to review + approve in the
// dashboard (the requested grants land pre-filled as pending), then polls until
// the grants are live on its key. Because the key is durable, the granted access
// persists — no ephemeral, re-issued-every-15-min token.
//
// Contract mirrors the control plane: the `?propose=` payload is base64url of
// { grants:[{datalakeId,schema,table,caps}], policies:[] }; the dashboard decodes
// it into the Access editor. Coverage is checked against GET /api/cp/acl.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ControlPlaneError, type WaddlingClient } from "./client";

/** Coarse catalog capabilities an access request may ask for. */
const CATALOG_CAPS = ["read", "write", "create", "drop", "alter", "detach"] as const;
type CatalogCap = (typeof CATALOG_CAPS)[number];

/** cap → the granular privileges the dashboard authors for it (mirrors capability-control presets). */
const CAP_PRIVILEGES: Record<CatalogCap, string[]> = {
  read: ["SELECT"],
  write: ["INSERT", "UPDATE", "DELETE"],
  create: ["CREATE"],
  drop: ["DROP"],
  alter: ["ALTER"],
  detach: ["DETACH"],
};

function json(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value },
    ...(isError ? { isError: true } : {}),
  };
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** utf8-safe base64url. Inverse of the dashboard's proposal decoder. */
function b64urlEncode(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The app (UI) origin for a base URL — the deep link must open the dashboard, not the API host. */
function appOrigin(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.hostname.startsWith("api.")) u.hostname = "app." + u.hostname.slice(4);
    return u.origin;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

interface GrantGroup {
  datalakeId: string;
  schema: string;
  table: string;
  caps: CatalogCap[];
}

/** Parse the shared `{ datalake_id, grants:[{schema,table,caps}] }` arg shape. */
function parseGrants(datalakeId: string, grantsInput: unknown): GrantGroup[] | string {
  if (!Array.isArray(grantsInput) || grantsInput.length === 0) {
    return "grants is required: a non-empty array of { schema, table, caps }";
  }
  const groups: GrantGroup[] = [];
  for (const g of grantsInput) {
    const gg = (g ?? {}) as Record<string, unknown>;
    const capsRaw = Array.isArray(gg.caps) ? gg.caps : [];
    const caps = capsRaw.filter((c): c is CatalogCap => isString(c) && (CATALOG_CAPS as readonly string[]).includes(c));
    if (caps.length === 0) continue;
    groups.push({
      datalakeId,
      schema: isString(gg.schema) ? gg.schema : "*",
      table: isString(gg.table) ? gg.table : "*",
      caps,
    });
  }
  if (groups.length === 0) return `each grant needs at least one catalog capability (${CATALOG_CAPS.join(", ")})`;
  return groups;
}

/** A `parsed` ACL statement as returned inside GET /api/cp/acl → { statements }. */
interface ParsedObject {
  schema?: string;
  table?: string;
  allTables?: boolean;
  raw?: string;
}
interface AclStatement {
  parsed: {
    kind: string;
    effect: string;
    privileges: string[];
    object: ParsedObject | null;
  } | null;
}

/**
 * Does the granted statement set COVER this (schema, table) target for the given
 * privileges? Privileges are UNIONED across every matching allow statement — a
 * "write" grant may be authored as one row (INSERT,UPDATE,DELETE) or split across
 * rows, and either must satisfy coverage (otherwise await_access loops forever).
 */
function covered(statements: AclStatement[], schema: string, table: string, needPrivs: string[]): boolean {
  const got = new Set<string>();
  for (const s of statements) {
    const p = s.parsed;
    if (!p || p.kind !== "object" || p.effect !== "allow" || !p.object) continue;
    const o = p.object;
    if (o.schema === undefined) continue;
    const schemaOk = o.schema === "*" || o.schema === schema;
    const tableOk = o.allTables === true || o.table === "*" || o.table === table;
    if (!schemaOk || !tableOk) continue;
    for (const priv of p.privileges) got.add(priv);
  }
  return needPrivs.every((priv) => got.has(priv));
}

async function resolveAgentId(client: WaddlingClient, profile?: string): Promise<string | undefined> {
  try {
    const r = await client.cp<{ agentId?: string }>("/api/cp/whoami", { profile });
    return isString(r.agentId) ? r.agentId : undefined;
  } catch {
    return undefined;
  }
}

export function registerAccessTools(server: McpServer, client: WaddlingClient): void {
  // ── waddling_request_access ────────────────────────────────────────────────
  server.registerTool(
    "waddling_request_access",
    {
      description:
        "Request DURABLE access to tables you don't yet have. This does NOT grant anything — it returns " +
        "a `url` a human operator (org owner/admin) opens to review the requested grants (pre-filled as " +
        "pending in the Access editor) and click Save. Then call waddling_await_access to wait for approval. " +
        "Once approved the access is permanent on your key (no 15-minute expiry). Provide `datalake_id` and " +
        "`grants` as [{ schema, table, caps }] where caps ∈ read|write|create|drop|alter|detach; use '*' for " +
        "all schemas/tables. Pass `profile` to request for a specific bearer profile (else the default).",
      inputSchema: {
        datalake_id: z.string().describe("The datalake id (from waddling_list_datalakes)."),
        grants: z
          .array(
            z.object({
              schema: z.string().optional().describe("Schema name, or '*' for all (default '*')."),
              table: z.string().optional().describe("Table name, or '*' for all in the schema (default '*')."),
              caps: z.array(z.enum(CATALOG_CAPS)).describe("Capabilities to request on this target."),
            }),
          )
          .describe("The grants to request."),
        profile: z.string().optional().describe("Bearer profile to request access for (default: the default profile)."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const groups = parseGrants(args.datalake_id, args.grants);
      if (typeof groups === "string") return json({ error: "invalid_request", reason: groups }, true);

      const agentId = await resolveAgentId(client, args.profile);
      if (!agentId) {
        return json(
          { error: "not_linked", reason: "could not resolve your agent identity — is this profile linked? Run waddling_signup." },
          true,
        );
      }

      const propose = b64urlEncode({ grants: groups, policies: [] });
      const base = appOrigin(client.baseUrl(args.profile));
      const url = `${base}/agents/${encodeURIComponent(agentId)}?section=access&propose=${propose}`;
      const requested = groups.map((g) => ({ schema: g.schema, table: g.table, caps: g.caps }));
      return json({
        url,
        agent_id: agentId,
        requested,
        wait_for: {
          tool: "waddling_await_access",
          args: { datalake_id: args.datalake_id, grants: requested, profile: args.profile, timeout_seconds: 20 },
        },
        message:
          "Access is NOT granted yet — this only creates an approval link.\n" +
          "1. Show `url` to a human owner/admin and ask them to open it and click Save (the requested grants " +
          "are pre-highlighted as pending).\n" +
          "2. Wait by calling waddling_await_access with the `wait_for.args` — it blocks ~20s and returns " +
          "{ granted }. Call it again while granted=false.\n" +
          "3. Once granted=true, retry the blocked work. If still pending after ~10 minutes, stop and tell the user.",
      });
    },
  );

  // ── waddling_await_access ──────────────────────────────────────────────────
  server.registerTool(
    "waddling_await_access",
    {
      description:
        "Wait (bounded, ~20s per call) for a human to approve a waddling_request_access request, by polling " +
        "your key's grants until every requested (schema, table, capability) is covered. Returns { granted }. " +
        "Call it again while granted=false; give up after ~10 minutes total. Pass the same datalake_id/grants " +
        "(and profile) you requested.",
      inputSchema: {
        datalake_id: z.string().describe("The datalake id from the request."),
        grants: z
          .array(
            z.object({
              schema: z.string().optional(),
              table: z.string().optional(),
              caps: z.array(z.enum(CATALOG_CAPS)),
            }),
          )
          .describe("The same grants passed to waddling_request_access."),
        profile: z.string().optional().describe("The profile the request was made for."),
        timeout_seconds: z.number().optional().describe("Max seconds to block this call (clamped to 25)."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const groups = parseGrants(args.datalake_id, args.grants);
      if (typeof groups === "string") return json({ error: "invalid_request", reason: groups }, true);

      const agentId = await resolveAgentId(client, args.profile);
      if (!agentId) return json({ error: "not_linked", reason: "could not resolve your agent identity for this profile." }, true);

      // Flatten to (schema, table, privilege-set) targets to check.
      const targets = groups.flatMap((g) =>
        g.caps.map((cap) => ({ schema: g.schema, table: g.table, cap, privs: CAP_PRIVILEGES[cap] })),
      );

      const budgetMs = Math.min(Math.max(args.timeout_seconds ?? 20, 1), 25) * 1000;
      const POLL_MS = 2500;
      const started = Date.now();

      const missingTargets = async (): Promise<typeof targets> => {
        const dl = encodeURIComponent(args.datalake_id);
        const r = await client.cp<{ statements: AclStatement[] }>(
          `/api/cp/acl?datalakeId=${dl}&agentId=${encodeURIComponent(agentId)}`,
          { profile: args.profile },
        );
        const statements = r.statements ?? [];
        return targets.filter((t) => !covered(statements, t.schema, t.table, t.privs));
      };

      try {
        let missing = await missingTargets();
        while (missing.length > 0 && Date.now() - started < budgetMs) {
          await new Promise((res) => setTimeout(res, POLL_MS));
          missing = await missingTargets();
        }
        const requested = targets.map((t) => ({ schema: t.schema, table: t.table, capability: t.cap }));
        if (missing.length === 0) {
          return json({ granted: true, agent_id: agentId, requested, message: "Access granted — retry the blocked work." });
        }
        return json({
          granted: false,
          agent_id: agentId,
          waited_seconds: Math.round((Date.now() - started) / 1000),
          still_missing: missing.map((t) => ({ schema: t.schema, table: t.table, capability: t.cap })),
          message:
            "Not granted within this window. If no one has approved yet, call waddling_await_access again; " +
            "after ~10 minutes total, stop and tell the user it is still pending.",
        });
      } catch (err) {
        const reason = err instanceof ControlPlaneError ? err.reason : err instanceof Error ? err.message : String(err);
        return json({ error: "await_failed", reason }, true);
      }
    },
  );
}
