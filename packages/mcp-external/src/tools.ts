// External MCP data-tool registry — a thin, governed client of the control plane.
//
// Every tool takes an optional `profile` to pick which stored bearer-token
// identity it acts as (see credentials.ts / profiles.ts); omitting it uses the
// default profile. Descriptions are written FOR AGENTS: when to use the tool and
// what they get back. Every error maps to a structured, actionable payload.
//
// The 15-minute session lakeToken is invisible here: waddling_query auto-heals an
// expired session by transparently re-connecting (same endpoint + profile) and
// retrying once, so an agent's working session never "goes cold" from its view.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ConnectResult,
  DatalakeSummary,
  DescribeResult,
  ExplainResult,
  InstallExtensionResult,
  QueryResult,
  TimeTravelResult,
  WhoamiResult,
} from "@waddling/control-schema";
import { ControlPlaneError, type WaddlingClient } from "./client";
import { notLinked, type LinkState } from "./onboarding";
import { resolveProfile } from "./credentials";
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
 * A cold/expired session — the signal to transparently re-connect and retry. These
 * are the codes the sessions query/etl route returns when the workspace needs
 * (re)configuring, the session's lakeToken JWT was rejected (the 15-minute expiry),
 * or the session row is no longer active/found. All are healed by re-connecting.
 */
function isSessionCold(err: unknown): boolean {
  if (!(err instanceof ControlPlaneError)) return false;
  return (
    err.code === "needs_configure" ||
    err.code === "needs_connect" ||
    err.code === "session_not_active" ||
    err.code === "session_not_found" ||
    err.code === "session_expired"
  );
}

/**
 * Workspace handle resolved at connect, cached per session so waddling_query has
 * the agent + endpoint + profile context to auto-reconnect. NO key material is
 * cached — the session JWT + workspace key live ONLY in the data plane.
 */
interface SessionCacheEntry {
  endpointId: string;
  workspaceId: string;
  agentId: string;
  profile?: string;
}

export function registerTools(
  server: McpServer,
  client: WaddlingClient,
  opts: { state: LinkState; telemetry: Telemetry },
): void {
  const { state, telemetry } = opts;
  // sessionId → resolved workspace handle (populated by waddling_connect).
  const sessions = new Map<string, SessionCacheEntry>();
  // `${profile}|${endpointId}` → the freshest live sessionId (for auto-reconnect).
  const liveByEndpoint = new Map<string, string>();
  const liveKey = (profile: string | undefined, endpointId: string) => `${profile ?? ""}|${endpointId}`;

  /** Gate a data tool: is the requested profile (or default) linked? */
  const linked = (profile?: string): boolean =>
    resolveProfile(profile) !== null || (state.creds !== null && (!profile || state.creds.profile === profile));

  // Agents never reach the data plane directly; the control plane forwards. Queries
  // go through POST /api/cp/sessions/<id>/query, which forwards to the workspace DO's
  // /query — where the agent's locked DuckDB runs the SQL against the birdshot-gated
  // quack ATTACH (the single path to the lake).
  const queryPath = (sessionId: string): string => `/api/cp/sessions/${encodeURIComponent(sessionId)}/query`;

  /** Open (or re-open) a session for an endpoint under a profile; caches the handle. */
  async function connect(endpointId: string, profile?: string): Promise<ConnectResult> {
    const result = await client.cp<ConnectResult>("/api/cp/sessions", {
      method: "POST",
      body: { endpointId },
      profile,
    });
    sessions.set(result.sessionId, { endpointId, workspaceId: result.workspaceId, agentId: result.agentId, profile });
    liveByEndpoint.set(liveKey(profile, endpointId), result.sessionId);
    return result;
  }

  /**
   * POST to a session-scoped endpoint with transparent auto-reconnect: prefer the
   * freshest live session id for the endpoint, and if the call reports a cold
   * session (expired 15m JWT, needs_configure, dead row), re-connect once and retry.
   * This is what makes the 15-minute session boundary invisible to the agent.
   */
  async function sessionPost<T>(
    passedId: string,
    action: (sessionId: string) => string,
    body: unknown,
    profile?: string,
  ): Promise<T> {
    const meta = sessions.get(passedId);
    let useId = passedId;
    if (meta) {
      const live = liveByEndpoint.get(liveKey(meta.profile, meta.endpointId));
      if (live) useId = live;
    }
    try {
      return await client.cp<T>(action(useId), { method: "POST", body, profile });
    } catch (err) {
      if (isSessionCold(err) && meta) {
        const fresh = await connect(meta.endpointId, meta.profile ?? profile);
        return await client.cp<T>(action(fresh.sessionId), { method: "POST", body, profile });
      }
      throw err;
    }
  }

  // ── 1. waddling_list_datalakes ───────────────────────────────────────────────
  server.registerTool(
    "waddling_list_datalakes",
    {
      description:
        "List the governed data lakes this profile's key can access. Call this FIRST to discover what " +
        "you can connect to. Returns [{ id, name, slug, status, schemas }]. Use a `id` with " +
        "waddling_describe or waddling_connect. Pass `profile` to act as a specific bearer identity.",
      inputSchema: {
        profile: z.string().optional().describe("Bearer profile to use (default: the default profile)."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked(args.profile)) return notLinked();
      try {
        const r = await client.cp<{ datalakes: DatalakeSummary[] }>("/api/cp/endpoints", { profile: args.profile });
        return ok(r.datalakes ?? r);
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
        "Discover the catalog for a data lake, SCOPED to what this profile may see — ungranted " +
        "schemas/tables/columns are filtered out (no leak). Returns tables with columns, types, and row " +
        "estimates. Use before querying to learn exact table/column names. Optionally narrow with `schema` " +
        "and/or `table`.",
      inputSchema: {
        datalake_id: z.string().describe("Data lake id from waddling_list_datalakes."),
        schema: z.string().optional().describe("Restrict to one schema."),
        table: z.string().optional().describe("Restrict to one table."),
        profile: z.string().optional().describe("Bearer profile to use."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked(args.profile)) return notLinked();
      try {
        const qs = new URLSearchParams();
        if (args.schema) qs.set("schema", args.schema);
        if (args.table) qs.set("table", args.table);
        const suffix = qs.toString() ? `?${qs}` : "";
        const result = await client.cp<DescribeResult>(
          `/api/cp/endpoints/${encodeURIComponent(args.datalake_id)}/describe${suffix}`,
          { profile: args.profile },
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
        "Open a governed session on a data lake. Returns { session_id, workspace_id, agent_id, " +
        "ttl_seconds, granted }. This provisions your DURABLE, encrypted, private workspace and attaches " +
        "the governed lake server-side — you do NOT run any ATTACH yourself. Just call waddling_query with " +
        "the returned session_id. `granted` tells you which tables/verbs/row-limits you have. You do NOT " +
        "need to reconnect when a session expires — waddling_query auto-refreshes it for you.",
      inputSchema: {
        datalake_id: z.string().describe("Data lake id from waddling_list_datalakes."),
        profile: z.string().optional().describe("Bearer profile to connect as."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked(args.profile)) return notLinked();
      try {
        const result = await connect(args.datalake_id, args.profile);
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
        "Run a governed read/write in your workspace for an open session. Returns { columns, rows, " +
        "row_count, truncated, snapshot_version }. Query the attached lake by its catalog alias `lake`, " +
        "qualified as `lake.<schema>.<table>` (e.g. `SELECT * FROM lake.sales.orders LIMIT 5`). Column " +
        "projection, row limits, and time windows are enforced server-side by birdshot: columns you lack " +
        "are stripped, results are capped. On a denial you get { error:'authorization_denied', reason } — " +
        "read `reason` and adjust. If your session has expired this tool RE-CONNECTS automatically and " +
        "retries — you never need to call waddling_connect again for the same lake.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        sql: z.string().describe("A single SQL statement; reference the lake as lake.<schema>.<table>."),
        profile: z.string().optional().describe("Bearer profile (defaults to the session's profile)."),
      },
    },
    async (args): Promise<ToolOutput> => {
      const meta = sessions.get(args.session_id);
      const profile = args.profile ?? meta?.profile;
      if (!linked(profile)) return notLinked();
      const startedAt = Date.now();
      try {
        const result = await sessionPost<QueryResult>(args.session_id, queryPath, { sql: args.sql }, profile);
        telemetry.setOnce("first_query");
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
        if (err instanceof ControlPlaneError && err.code === "authorization_denied") {
          const body = (err.body ?? {}) as { table?: string };
          telemetry.capture("denial_hit", { table: body.table, reason_kind: "authorization_denied" });
        }
        return fail(err);
      }
    },
  );

  // ── 5. waddling_etl ──────────────────────────────────────────────────────────
  server.registerTool(
    "waddling_etl",
    {
      description:
        "Load external data into the lake with a governed CTAS/INSERT over read_json/read_csv/read_parquet " +
        "URLs. Runs on the gateway with egress AFTER birdshot authorizes the statement (needs copy_from / " +
        "read_source grants for the source host, and write/create on the target). Use this instead of " +
        "waddling_query for any statement that reads an external URL. Auto-reconnects an expired session.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        sql: z.string().describe("A single CTAS/INSERT statement reading an external URL."),
        profile: z.string().optional().describe("Bearer profile (defaults to the session's profile)."),
      },
    },
    async (args): Promise<ToolOutput> => {
      const meta = sessions.get(args.session_id);
      const profile = args.profile ?? meta?.profile;
      if (!linked(profile)) return notLinked();
      try {
        const etlPath = (id: string) => `/api/cp/sessions/${encodeURIComponent(id)}/etl`;
        return ok(await sessionPost<QueryResult>(args.session_id, etlPath, { sql: args.sql }, profile));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 6. waddling_explain ──────────────────────────────────────────────────────
  server.registerTool(
    "waddling_explain",
    {
      description:
        "DRY-RUN a query: get the access decision + would-be row estimate WITHOUT executing or auditing " +
        "it as a real query. Use this to check whether you're allowed BEFORE acting, instead of triggering " +
        "a denial. Returns { allowed, decision, reason?, row_estimate?, table_grants? }.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        sql: z.string().describe("The SQL you intend to run."),
        profile: z.string().optional().describe("Bearer profile (defaults to the session's profile)."),
      },
    },
    async (args): Promise<ToolOutput> => {
      const meta = sessions.get(args.session_id);
      const profile = args.profile ?? meta?.profile;
      if (!linked(profile)) return notLinked();
      try {
        const result = await sessionPost<ExplainResult>(
          args.session_id,
          (id) => `${queryPath(id)}/explain`,
          { sql: args.sql },
          profile,
        );
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
        "Orient yourself: returns this profile's agent identity, org, and active access as the LITERAL " +
        "GRANT/DENY SQL governing your key — `grants.statements` for the session/datalake in scope, plus " +
        "`grantsByDatalake[]` so a bare call still shows exactly what you can do (no trial-and-error " +
        "denials). Pass `session_id` for live session TTL, or omit for standing identity + grants. Pass " +
        "`profile` to inspect a specific bearer identity.",
      inputSchema: {
        session_id: z.string().optional().describe("Optional open session to report live TTL for."),
        profile: z.string().optional().describe("Bearer profile to inspect (default: the default profile)."),
      },
    },
    async (args): Promise<ToolOutput> => {
      if (!linked(args.profile)) return notLinked();
      try {
        const suffix = args.session_id ? `?session_id=${encodeURIComponent(args.session_id)}` : "";
        const result = await client.cp<WhoamiResult>(`/api/cp/whoami${suffix}`, { profile: args.profile });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 8. waddling_time_travel ──────────────────────────────────────────────────
  server.registerTool(
    "waddling_time_travel",
    {
      description:
        "Read a table at a historical DuckLake snapshot — AT (VERSION => …) or AT (TIMESTAMP => …). Provide " +
        "exactly one of `at_version` or `at_timestamp`. Subject to the same column/row grants as a normal " +
        "read. Returns { columns, rows, row_count, version?, timestamp? }.",
      inputSchema: {
        session_id: z.string().describe("session_id from waddling_connect."),
        table: z.string().describe("schema.table to read."),
        at_version: z.number().int().optional().describe("Snapshot version number."),
        at_timestamp: z.string().optional().describe("ISO timestamp to read as-of."),
        profile: z.string().optional().describe("Bearer profile (defaults to the session's profile)."),
      },
    },
    async (args): Promise<ToolOutput> => {
      const meta = sessions.get(args.session_id);
      const profile = args.profile ?? meta?.profile;
      if (!linked(profile)) return notLinked();
      try {
        if (args.at_version === undefined && !args.at_timestamp) {
          return fail(new Error("provide exactly one of at_version or at_timestamp"));
        }
        const result = await sessionPost<TimeTravelResult>(
          args.session_id,
          (id) => `${queryPath(id)}/time-travel`,
          { table: args.table, atVersion: args.at_version, atTimestamp: args.at_timestamp },
          profile,
        );
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── 9. waddling_install_extension ────────────────────────────────────────────
  server.registerTool(
    "waddling_install_extension",
    {
      description:
        "Get the one-liner to INSTALL + LOAD the birdshot extension in a LOCAL DuckDB you run yourself (for " +
        "the self-hosted / edge case — most agents never need this; the gateway runs birdshot server-side " +
        "and you only ATTACH). Returns { sql, note } with a platform-matched note.",
      inputSchema: {},
    },
    async (): Promise<ToolOutput> => {
      const result: InstallExtensionResult = {
        sql: "SET allow_unsigned_extensions = true;\nINSTALL birdshot FROM 'https://ext.getwaddling.com';\nLOAD birdshot;",
        note:
          "birdshot is a custom (unsigned) extension; allow_unsigned_extensions must be set. httpfs " +
          "auto-loads for the HTTPS repo. Binaries are published for linux_amd64, linux_arm64, osx_arm64, " +
          "osx_amd64, windows_amd64 under DuckDB engine v1.5.3. You usually do NOT need this — the waddling " +
          "gateway runs birdshot for you; just call waddling_connect and waddling_query.",
      };
      return ok(result);
    },
  );
}
