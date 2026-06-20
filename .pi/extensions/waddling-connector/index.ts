/**
 * waddling-connector — pi extension that connects to the waddling MCP server
 * and exposes governed DuckDB query tools directly inside pi.
 *
 * Configure:
 *   export WADDLING_API_KEY=sk_agent_analyst_demo
 *   export WADDLING_MCP_URL=http://localhost:8810    # override for local dev
 *
 * Defaults to the deployed control plane (https://app.getwaddling.com).
 * Set WADDLING_MCP_URL to point at a local MCP server for development.
 *
 * The connector registers all 10 waddling MCP tools as pi tools.
 * Sessions (waddling_connect → waddling_query) are tracked automatically.
 *
 * Usage from pi:
 *   "list my waddling endpoints"  → waddling_list_endpoints
 *   "connect to prod-lake"        → waddling_connect
 *   "query orders"                → waddling_query SELECT * FROM ...
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Config ────────────────────────────────────────────────────────────────────

const MCP_URL = process.env.WADDLING_MCP_URL ?? "https://app.getwaddling.com";
const API_KEY = process.env.WADDLING_API_KEY;

// ── MCP client (JSON-RPC over streamable HTTP) ────────────────────────────────

interface McpResponse {
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function extractStructured(response: McpResponse): unknown {
  const sc = response.result?.structuredContent;
  return sc ?? undefined;
}

function extractText(response: McpResponse): string {
  const texts = response.result?.content?.filter((c) => c.type === "text").map((c) => c.text) ?? [];
  return texts.join("\n");
}

/** Parse a streamable HTTP response (`event: message\ndata: ...`) */
function parseSse(body: string): McpResponse {
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error("no data event in SSE response");
}

async function mcpCall(toolName: string, args: Record<string, unknown> = {}): Promise<McpResponse> {
  if (!API_KEY) {
    throw new Error("WADDLING_API_KEY not set — export WADDLING_API_KEY=sk_agent_...");
  }
  const res = await fetch(`${MCP_URL}/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: 1,
    }),
  });
  const text = await res.text();
  return parseSse(text);
}

/** Wrap an MCP call into the pi ToolResult shape. */
async function wrapMcpTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
}> {
  const response = await mcpCall(toolName, params);
  const text = extractText(response);
  const sc = response.result?.structuredContent as Record<string, unknown> | undefined;
  if (response.result?.isError) {
    return {
      content: [{ type: "text", text }],
      details: sc ?? { error: "mcp_error" },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
    details: sc ?? {},
  };
}

// ── Session tracker (module-level — persists across turns in the same session) ─

interface ActiveSession {
  sessionId: string;
  endpointId: string;
  granted?: unknown;
  ttlSeconds?: number;
  createdAt: number;
}

let activeSession: ActiveSession | null = null;

function sessionExpired(): boolean {
  if (!activeSession) return true;
  const elapsed = (Date.now() - activeSession.createdAt) / 1000;
  return elapsed > (activeSession.ttlSeconds ?? 900);
}

// ── Register all waddling MCP tools ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!API_KEY) {
    // Warn but don't fail — tools will throw with a clear message when called.
    console.error("[waddling-connector] WADDLING_API_KEY not set");
  }

  // ── waddling_list_endpoints ───────────────────────────────────────────
  pi.registerTool({
    name: "waddling_list_endpoints",
    label: "List Waddling Endpoints",
    description:
      "List the analytics endpoints (governed lakehouses) this API key can access. " +
      "Call this FIRST to discover what you can connect to. " +
      "Returns [{id, name, slug, status}]. Use an endpoint `id` with waddling_describe or waddling_connect.",
    parameters: Type.Object({}),
    async execute() {
      return wrapMcpTool("waddling_list_endpoints", {});
    },
  });

  // ── waddling_describe ─────────────────────────────────────────────────
  pi.registerTool({
    name: "waddling_describe",
    label: "Describe Waddling Catalog",
    description:
      "Discover the catalog for an endpoint, SCOPED to what this agent may see — " +
      "ungranted schemas/tables/columns are filtered out. Returns tables with columns, " +
      "types, and row estimates. Optionally narrow with `schema` and/or `table`.",
    parameters: Type.Object({
      endpoint_id: Type.String({ description: "Endpoint id from waddling_list_endpoints." }),
      schema: Type.Optional(Type.String({ description: "Restrict to one schema." })),
      table: Type.Optional(Type.String({ description: "Restrict to one table." })),
    }),
    async execute(_id, params) {
      return wrapMcpTool("waddling_describe", params as Record<string, unknown>);
    },
  });

  // ── waddling_connect ──────────────────────────────────────────────────
  pi.registerTool({
    name: "waddling_connect",
    label: "Connect to Waddling Lake",
    description:
      "Open a governed session on an endpoint. Returns { session_id, attach_sql, " +
      "session_jwt, endpoint, ttl_seconds, granted }. `attach_sql` is ready-to-paste SQL " +
      "(CREATE SECRET + ATTACH) — run it verbatim in your own DuckDB. Query via " +
      "`FROM lake.query('FROM lake.sales.orders LIMIT 5')`. " +
      "Or just use waddling_query with the returned session_id. " +
      "`granted` tells you which tables/verbs/row-limits you have. Sessions are short-lived (15m).",
    parameters: Type.Object({
      endpoint_id: Type.String({ description: "Endpoint id from waddling_list_endpoints." }),
    }),
    async execute(_id, params) {
      const result = await wrapMcpTool("waddling_connect", params as Record<string, unknown>);
      // Track session
      const sc = result.details as Record<string, unknown>;
      if (sc.session_id && !result.isError) {
        activeSession = {
          sessionId: sc.session_id as string,
          endpointId: (params as { endpoint_id: string }).endpoint_id,
          granted: sc.granted,
          ttlSeconds: sc.ttl_seconds as number | undefined,
          createdAt: Date.now(),
        };
      }
      return result;
    },
  });

  // ── waddling_query ────────────────────────────────────────────────────
  pi.registerTool({
    name: "waddling_query",
    label: "Query Waddling Lake",
    description:
      "Run a governed read/write through the gateway for an open session. Returns " +
      "{ columns, rows, row_count, truncated, snapshot_version }. Column projection, row limits, " +
      "and time windows are enforced server-side. On denial: { error:'authorization_denied', table, reason }. " +
      "Use session_id from waddling_connect, or omit to auto-use the most recent session.",
    parameters: Type.Object({
      sql: Type.String({ description: "A single SQL statement (SELECT/WITH for read grants)." }),
      session_id: Type.Optional(
        Type.String({
          description:
            "session_id from waddling_connect. If omitted, the most recent active session is used.",
        }),
      ),
    }),
    async execute(_id, params) {
      const sid = params.session_id || activeSession?.sessionId;
      if (!sid) {
        return {
          content: [
            {
              type: "text",
              text: "No active session. Run waddling_connect first to open a session.",
            },
          ],
          details: { error: "no_session" },
          isError: true,
        };
      }
      if (!params.session_id && sessionExpired()) {
        return {
          content: [
            {
              type: "text",
              text: "Active session has expired. Run waddling_connect to open a new session.",
            },
          ],
          details: { error: "session_expired", session: activeSession?.sessionId },
          isError: true,
        };
      }
      return wrapMcpTool("waddling_query", { session_id: sid, sql: params.sql });
    },
  });

  // ── waddling_explain ──────────────────────────────────────────────────
  pi.registerTool({
    name: "waddling_explain",
    label: "Explain Waddling Query",
    description:
      "DRY-RUN a query: get the access decision + would-be row estimate WITHOUT executing. " +
      "Returns { allowed, decision, reason?, row_estimate?, table_grants? }.",
    parameters: Type.Object({
      sql: Type.String({ description: "The SQL you intend to run." }),
      session_id: Type.Optional(
        Type.String({ description: "session_id from waddling_connect." }),
      ),
    }),
    async execute(_id, params) {
      const sid = params.session_id || activeSession?.sessionId;
      if (!sid) {
        return {
          content: [{ type: "text", text: "No active session. Run waddling_connect first." }],
          details: { error: "no_session" },
          isError: true,
        };
      }
      return wrapMcpTool("waddling_explain", { session_id: sid, sql: params.sql });
    },
  });

  // ── waddling_time_travel ──────────────────────────────────────────────
  pi.registerTool({
    name: "waddling_time_travel",
    label: "Waddling Time Travel",
    description:
      "Read a table at a historical DuckLake snapshot — AT (VERSION => …) or AT (TIMESTAMP => …). " +
      "Provide exactly one of `at_version` or `at_timestamp`.",
    parameters: Type.Object({
      table: Type.String({ description: "schema.table to read." }),
      session_id: Type.Optional(Type.String({ description: "session_id from waddling_connect." })),
      at_version: Type.Optional(
        Type.Number({ description: "Snapshot version number.", minimum: 0 }),
      ),
      at_timestamp: Type.Optional(Type.String({ description: "ISO timestamp to read as-of." })),
    }),
    async execute(_id, params) {
      const sid = params.session_id || activeSession?.sessionId;
      if (!sid) {
        return {
          content: [{ type: "text", text: "No active session. Run waddling_connect first." }],
          details: { error: "no_session" },
          isError: true,
        };
      }
      return wrapMcpTool("waddling_time_travel", {
        session_id: sid,
        table: params.table,
        at_version: params.at_version,
        at_timestamp: params.at_timestamp,
      });
    },
  });

  // ── waddling_whoami ───────────────────────────────────────────────────
  pi.registerTool({
    name: "waddling_whoami",
    label: "Waddling Whoami",
    description:
      "Orient yourself: returns your agent identity, org, active grants (tables/verbs/row-limits), " +
      "remaining session TTL, and rate-limit headroom.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Optional open session to report live TTL for." }),
      ),
    }),
    async execute(_id, params) {
      return wrapMcpTool("waddling_whoami", params as Record<string, unknown>);
    },
  });

  // ── waddling_install_extension ────────────────────────────────────────
  pi.registerTool({
    name: "waddling_install_extension",
    label: "Install Birdshot Extension",
    description:
      "Get the one-liner to INSTALL + LOAD the birdshot extension in a LOCAL DuckDB. " +
      "Most agents never need this — the gateway runs birdshot server-side.",
    parameters: Type.Object({}),
    async execute() {
      return wrapMcpTool("waddling_install_extension", {});
    },
  });

  // ── waddling_duck_query ──────────────────────────────────────────────
  // Fresh in-memory DuckDB + quack connection per call.
  // Caches the JWT briefly (2s) to avoid concurrent-connect races.
  let _cachedJwt = "";
  let _cachedJwtTs = 0;

  pi.registerTool({
    name: "waddling_duck_query",
    label: "Direct Duck Query",
    description:
      "Create a local in-memory DuckDB, connect to the waddling gateway via quack, " +
      "and run governed SQL. Bypasses the MCP gateway proxy — queries go directly " +
      "to the birdshot-gated DuckDB over the quack wire protocol. " +
      "Returns { columns, rows, row_count }. " +
      "Use full server-side paths: FROM lake.sales.orders LIMIT 5.",
    parameters: Type.Object({
      sql: Type.String({
        description:
          "SQL to run. Use full server-side paths: lake.sales.orders, lake.sales.customers, etc. " +
          "Examples: 'FROM lake.sales.orders LIMIT 5', " +
          "'SELECT status, COUNT(*) FROM lake.sales.orders GROUP BY status ORDER BY COUNT(*) DESC'",
      }),
    }),
    async execute(_id, params) {
      const { DuckDBInstance } = await import("@duckdb/node-api");
      if (!API_KEY) {
        return { content: [{ type: "text", text: "WADDLING_API_KEY not set" }], details: { error: "no_api_key" }, isError: true };
      }

      const quackUri = "quack:localhost:9500";

      // Reuse a recent JWT (<2s old) to avoid concurrent-connect 409 races
      let jwt: string;
      if (_cachedJwt && Date.now() - _cachedJwtTs < 2000) {
        jwt = _cachedJwt;
      } else {
        const connectResp = await mcpCall("waddling_connect", { endpoint_id: "a4c3cb44-640c-44b7-a8da-62795496c922" });
        const sc = connectResp.result?.structuredContent as Record<string, unknown> | undefined;
        if (connectResp.result?.isError || !sc) {
          return { content: [{ type: "text", text: "Failed to acquire session: " + JSON.stringify(sc) }], details: sc || {}, isError: true };
        }
        jwt = sc.session_jwt as string;
        _cachedJwt = jwt;
        _cachedJwtTs = Date.now();
      }

      // Boot DuckDB and query
      const instance = await DuckDBInstance.create(":memory:");
      const conn = await instance.connect();
      try {
        await conn.run("INSTALL quack; LOAD quack; INSTALL httpfs; LOAD httpfs;");
        await conn.run(`CREATE SECRET (TYPE quack, TOKEN '${jwt.replace(/'/g, "''")}', SCOPE '${quackUri}');`);
        await conn.run(`ATTACH '${quackUri}' AS remote (disable_ssl true);`);

        const reader = await conn.runAndReadAll(`FROM remote.query('${params.sql.replace(/'/g, "''")}');`);
        const columns = reader.columnNames();
        const rawRows = reader.getRowObjects() as Record<string, unknown>[];
        // Rebuild as plain objects, converting BigInts
        const rows = rawRows.map((r: Record<string, unknown>) => {
          const out: Record<string, unknown> = {};
          for (const c of columns) {
            const v = r[c];
            if (typeof v === "bigint") { out[c] = Number(v); }
            else if (v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) { out[c] = String(v); }
            else { out[c] = v; }
          }
          return out;
        });
        const text = JSON.stringify({ columns, rows, row_count: rows.length }, null, 2);

        return {
          content: [{ type: "text", text }],
          details: { columns, rows, rowCount: rows.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: msg.slice(0, 2000) }], details: { error: "query_failed", message: msg.slice(0, 500) }, isError: true };
      }
    },
  });

  // ── Session-aware auto-connect on session_start ────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (API_KEY) {
      ctx.ui.setStatus("waddling", `connected to ${MCP_URL}`);
    } else {
      ctx.ui.setStatus("waddling", "no API key");
    }
  });

  // ── /waddling-status command ───────────────────────────────────────────
  pi.registerCommand("waddling-status", {
    description: "Show waddling connector status",
    handler: async (_args, ctx) => {
      if (!API_KEY) {
        ctx.ui.notify("waddling: WADDLING_API_KEY not set", "warning");
        return;
      }
      if (activeSession && !sessionExpired()) {
        const remaining = Math.max(
          0,
          Math.round(
            (activeSession.ttlSeconds ?? 900) - (Date.now() - activeSession.createdAt) / 1000,
          ),
        );
        ctx.ui.notify(
          `waddling: active session ${activeSession.sessionId.slice(0, 8)}… on ${activeSession.endpointId.slice(0, 8)}… (${remaining}s remaining)`,
          "info",
        );
      } else if (activeSession) {
        ctx.ui.notify("waddling: session expired — run waddling_connect to renew", "warning");
      } else {
        ctx.ui.notify("waddling: connected but no active session", "info");
      }
    },
  });

  // ── /waddling-disconnect command ───────────────────────────────────────
  pi.registerCommand("waddling-disconnect", {
    description: "Clear the active waddling session",
    handler: async (_args, ctx) => {
      if (activeSession) {
        const sid = activeSession.sessionId.slice(0, 8);
        activeSession = null;
        ctx.ui.notify(`waddling: cleared session ${sid}…`, "info");
      } else {
        ctx.ui.notify("waddling: no active session to clear", "info");
      }
    },
  });
}
