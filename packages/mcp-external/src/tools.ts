// External MCP tool registry (W3) — the 8 §4a tools, exactly as named.
//
// Each tool is a thin client of the control-plane REST API (WaddlingClient) or
// the gateway /gw/query proxy (waddling_query). Descriptions are written FOR
// AGENTS: when to use the tool and what they get back. Every error is mapped to
// a structured, actionable payload so the agent can self-correct.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectResult,
  DescribeResult,
  EndpointSummary,
  ExplainResult,
  InstallExtensionResult,
  QueryResult,
  TimeTravelResult,
  WhoamiResult,
} from "@waddling/control-schema";
import { ControlPlaneError, type WaddlingClient } from "./client";
import { notLinked, type LinkState } from "./onboarding";
import type { Telemetry } from "./telemetry";

type ToolOutput = CallToolResult;

/** Wrap a JSON value as MCP text content. */
function ok(value: unknown): ToolOutput {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], structuredContent: asRecord(value) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : value === undefined
      ? undefined
      : { value };
}

/**
 * Map any thrown error to a structured, actionable tool error. Authorization
 * denials are surfaced verbatim ({ error:'authorization_denied', table, reason })
 * so the agent can adjust its query without a human round-trip.
 */
function fail(err: unknown): ToolOutput {
  if (err instanceof ControlPlaneError) {
    const body =
      err.code === "authorization_denied"
        ? err.body
        : { error: err.code, status: err.status, reason: err.reason };
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      isError: true,
      structuredContent: body as Record<string, unknown>,
    };
  }
  const reason = err instanceof Error ? err.message : String(err);
  const body = { error: "tool_error", reason };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true, structuredContent: body };
}

/**
 * Workspace handle resolved at connect, cached per session so waddling_query /
 * waddling_explain have the agent + endpoint context without re-connecting. NO key
 * material is cached — the session JWT + workspace key live ONLY in the data plane.
 */
interface SessionCacheEntry {
  endpointId: string;
  workspaceId: string;
  agentId: string;
}

export function registerTools(
  server: McpServer,
  client: WaddlingClient,
  opts: { state: LinkState; telemetry: Telemetry },
): void {
  const { state, telemetry } = opts;
  // session_id → resolved workspace handle (populated by waddling_connect).
  const sessions = new Map<string, SessionCacheEntry>();

  /** Gate a data tool: until the device is linked, return structured not_linked. */
  const linked = (): boolean => state.creds !== null;

  // Agents never reach the data plane directly; the control plane forwards. Queries
  // go through POST /api/cp/sessions/<id>/query, which forwards to the workspace DO's
  // /query — where the agent's locked DuckDB runs the SQL against the birdshot-gated
  // quack ATTACH (the single path to the lake).
  const queryPath = (sessionId: string): string => `/api/cp/sessions/${encodeURIComponent(sessionId)}/query`;

  // ── 1. waddling_list_endpoints ───────────────────────────────────────────────
  server.registerTool(
    "waddling_list_endpoints",
    {
      description:
        "List the analytics endpoints (governed lakehouses) this API key can access. " +
        "Call this FIRST to discover what you can connect to. Returns " +
        "[{id, name, slug, status, schemas}]. Use an endpoint `id` with waddling_describe or waddling_connect.",
      inputSchema: {},
    },
    async (): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        const endpoints = await client.cp<EndpointSummary[]>("/api/cp/endpoints");
        return ok(endpoints);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 2. waddling_describe ─────────────────────────────────────────────────────
  server.registerTool(
    "waddling_describe",
    {
      description:
        "Discover the catalog for an endpoint, SCOPED to what this agent may see — " +
        "ungranted schemas/tables/columns are filtered out (no leak). Returns tables with " +
        "columns, types, and row estimates. Use before querying to learn exact table/column names. " +
        "Optionally narrow with `schema` and/or `table`.",
      inputSchema: {
        endpoint_id: z.string().describe("Endpoint id from waddling_list_endpoints."),
        schema: z.string().optional().describe("Restrict to one schema."),
        table: z.string().optional().describe("Restrict to one table."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        const qs = new URLSearchParams();
        if (args.schema) qs.set("schema", args.schema);
        if (args.table) qs.set("table", args.table);
        const suffix = qs.toString() ? `?${qs}` : "";
        const result = await client.cp<DescribeResult>(
          `/api/cp/endpoints/${encodeURIComponent(args.endpoint_id)}/describe${suffix}`,
        );
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 3. waddling_connect ──────────────────────────────────────────────────────
  server.registerTool(
    "waddling_connect",
    {
      description:
        "Open a governed session on an endpoint. Returns { session_id, workspace_id, agent_id, " +
        "ttl_seconds, granted }. This provisions your DURABLE, encrypted, private workspace and " +
        "attaches the governed lake to it server-side — you do NOT run any ATTACH yourself. Just " +
        "call waddling_query with the returned session_id. `granted` tells you which tables/verbs/" +
        "row-limits you have. Sessions are short-lived (default 15m); if a later query returns " +
        "{ error:'needs_configure' }, call waddling_connect again to refresh and retry.",
      inputSchema: {
        endpoint_id: z.string().describe("Endpoint id from waddling_list_endpoints."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        const result = await client.cp<ConnectResult>("/api/cp/sessions", {
          method: "POST",
          body: { endpointId: args.endpoint_id },
        });
        sessions.set(result.sessionId, {
          endpointId: args.endpoint_id,
          workspaceId: result.workspaceId,
          agentId: result.agentId,
        });
        return ok({
          session_id: result.sessionId,
          workspace_id: result.workspaceId,
          agent_id: result.agentId,
          ttl_seconds: result.ttlSeconds,
          granted: result.granted,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 4. waddling_query ────────────────────────────────────────────────────────
  server.registerTool(
    "waddling_query",
    {
      description:
        "Run a governed read/write in your workspace for an open session. Returns " +
        "{ columns, rows, row_count, truncated, snapshot_version }. Query the attached lake by its " +
        "catalog alias `lake`, qualified as `lake.<schema>.<table>` (e.g. " +
        "`SELECT * FROM lake.sales.orders LIMIT 5`). Column projection, row limits, and time windows " +
        "are enforced server-side by birdshot: columns you lack are stripped, results are capped. " +
        "On a denial you get { error:'authorization_denied', reason } — read `reason` and adjust " +
        "(e.g. drop a forbidden column, qualify a table). If you get { error:'needs_configure' }, your " +
        "session went cold — call waddling_connect again, then retry. Single SELECT/WITH for read grants.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        sql: z.string().describe("A single SQL statement; reference the lake as lake.<schema>.<table>."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      const startedAt = Date.now();
      try {
        // The control plane resolves the session → (workspace, agent) and forwards to
        // the workspace DO's /query; no key material is passed from here.
        const result = await client.cp<QueryResult>(queryPath(args.session_id), {
          method: "POST",
          body: { sql: args.sql },
        });
        // Telemetry: duration + row_count ONLY — never the SQL text.
        telemetry.setOnce("first_query"); // $set_once on person, fires once
        telemetry.capture("query_executed", {
          duration_ms: Date.now() - startedAt,
          row_count: result.rowCount,
          truncated: result.truncated,
        });
        return ok({
          columns: result.columns,
          rows: result.rows,
          row_count: result.rowCount,
          truncated: result.truncated,
          snapshot_version: result.snapshotVersion,
        });
      } catch (err) {
        // Surface denials to the funnel (table + reason kind, never SQL).
        if (err instanceof ControlPlaneError && err.code === "authorization_denied") {
          const body = (err.body ?? {}) as { table?: string };
          telemetry.capture("denial_hit", {
            table: body.table,
            reason_kind: "authorization_denied",
          });
        }
        return fail(err);
      }
    },
  );

  // ── 5. waddling_explain ──────────────────────────────────────────────────────
  server.registerTool(
    "waddling_explain",
    {
      description:
        "DRY-RUN a query: get the access decision + would-be row estimate WITHOUT executing or " +
        "auditing it as a real query. Use this to check whether you're allowed BEFORE acting, " +
        "instead of triggering a denial. Returns { allowed, decision, reason?, row_estimate?, table_grants? }.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        sql: z.string().describe("The SQL you intend to run."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        const result = await client.cp<ExplainResult>(`${queryPath(args.session_id)}/explain`, {
          method: "POST",
          body: { sql: args.sql },
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 6. waddling_time_travel ──────────────────────────────────────────────────
  server.registerTool(
    "waddling_time_travel",
    {
      description:
        "Read a table at a historical DuckLake snapshot — AT (VERSION => …) or AT (TIMESTAMP => …). " +
        "Provide exactly one of `at_version` or `at_timestamp`. Subject to the same column/row grants " +
        "as a normal read. Returns { columns, rows, row_count, version?, timestamp? }.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        table: z.string().describe("schema.table to read."),
        at_version: z.number().int().optional().describe("Snapshot version number."),
        at_timestamp: z.string().optional().describe("ISO timestamp to read as-of."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        if (args.at_version === undefined && !args.at_timestamp) {
          return fail(new Error("provide exactly one of at_version or at_timestamp"));
        }
        const result = await client.cp<TimeTravelResult>(`${queryPath(args.session_id)}/time-travel`, {
          method: "POST",
          body: { table: args.table, atVersion: args.at_version, atTimestamp: args.at_timestamp },
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 7. waddling_whoami ───────────────────────────────────────────────────────
  server.registerTool(
    "waddling_whoami",
    {
      description:
        "Orient yourself: returns your agent identity, org, active grants (tables/verbs/row-limits), " +
        "remaining session TTL, and rate-limit headroom. Call this any time to understand exactly what " +
        "you can do — no trial-and-error denials needed. Pass `session_id` for live session TTL, or omit " +
        "for your standing identity + default grants.",
      inputSchema: {
        session_id: z.string().optional().describe("Optional open session to report live TTL for."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        const suffix = args.session_id ? `?session_id=${encodeURIComponent(args.session_id)}` : "";
        const result = await client.cp<WhoamiResult>(`/api/cp/whoami${suffix}`);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 8. waddling_install_extension ────────────────────────────────────────────
  server.registerTool(
    "waddling_install_extension",
    {
      description:
        "Get the one-liner to INSTALL + LOAD the birdshot extension in a LOCAL DuckDB you run yourself " +
        "(for the self-hosted / edge case — most agents never need this; the gateway runs birdshot " +
        "server-side and you only ATTACH). Returns { sql, note } with a platform-matched note.",
      inputSchema: {},
    },
    async (): Promise<ToolOutput> => {
      if (!linked()) return notLinked();
      try {
        // Static, no control-plane round-trip needed (matches §7a + §4a).
        const result: InstallExtensionResult = {
          sql: "SET allow_unsigned_extensions = true;\nINSTALL birdshot FROM 'https://ext.getwaddling.com';\nLOAD birdshot;",
          note:
            "birdshot is a custom (unsigned) extension; allow_unsigned_extensions must be set. " +
            "httpfs auto-loads for the HTTPS repo. Binaries are published for linux_amd64, linux_arm64, " +
            "osx_arm64, osx_amd64, windows_amd64 under DuckDB engine v1.5.3. You usually do NOT need this — " +
            "the waddling gateway runs birdshot for you; just run the `attach_sql` from waddling_connect.",
        };
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

}
