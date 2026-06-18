#!/usr/bin/env npx tsx
/**
 * waddling-duck-client — Creates an in-memory DuckDB, acquires a session JWT
 * from the waddling MCP server, ATTACHes the gateway via quack, and runs SQL.
 *
 * Usage:
 *   npx tsx scripts/duckdb-client.ts "FROM lake.sales.orders LIMIT 5"
 *   npx tsx scripts/duckdb-client.ts --etlbot "INSERT INTO lake.sales.events ..."
 *
 *   WADDLING_API_KEY=sk_agent_analyst_demo  npx tsx scripts/duckdb-client.ts "SELECT ..."
 *
 * Or use programmatically:
 *   import { createWaddlingDuck } from './scripts/duckdb-client';
 *   const duck = await createWaddlingDuck({ apiKey: 'sk_agent_...' });
 *   const result = await duck.query('FROM lake.sales.orders LIMIT 5');
 *   await duck.close();
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// ── Config ────────────────────────────────────────────────────────────────────

export interface WaddlingDuckConfig {
  /** Agent API key (sk_agent_…). Defaults to process.env.WADDLING_API_KEY. */
  apiKey?: string;
  /** MCP server URL. Defaults to http://localhost:8810. */
  mcpUrl?: string;
  /** Endpoint ID. Defaults to the demo prod-lake. */
  endpointId?: string;
  /** Gateway host. Defaults to localhost. */
  gatewayHost?: string;
  /** Gateway quack port. Defaults to 9500. */
  gatewayPort?: number;
}

// ── MCP client (JSON-RPC over streamable HTTP) ────────────────────────────────

interface McpToolResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface McpResponse {
  result?: { content?: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean };
  error?: { code: number; message: string };
}

function parseSse(body: string): McpResponse {
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error("no data event in SSE response");
}

async function mcpCall(
  mcpUrl: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const res = await fetch(`${mcpUrl}/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: 1,
    }),
  });
  const text = await res.text();
  const response = parseSse(text);
  const sc = response.result?.structuredContent as Record<string, unknown> | undefined;
  return { structuredContent: sc, isError: response.result?.isError };
}

// ── Session JWT acquisition ───────────────────────────────────────────────────

export interface AcquiredSession {
  sessionId: string;
  jwt: string;
  endpointId: string;
  gatewayHost: string;
  gatewayPort: number;
  granted: unknown;
  ttlSeconds: number;
  expiresAt: number; // epoch ms
}

/** Fetch a fresh session JWT from the MCP server. */
export async function acquireSession(config: WaddlingDuckConfig): Promise<AcquiredSession> {
  const apiKey = config.apiKey ?? process.env.WADDLING_API_KEY;
  if (!apiKey) throw new Error("WADDLING_API_KEY is required");

  const mcpUrl = config.mcpUrl ?? "http://localhost:8810";
  const endpointId = config.endpointId ?? "a4c3cb44-640c-44b7-a8da-62795496c922";

  const result = await mcpCall(mcpUrl, apiKey, "waddling_connect", { endpoint_id: endpointId });

  if (result.isError) {
    throw new Error(`Failed to acquire session: ${JSON.stringify(result.structuredContent)}`);
  }

  const sc = result.structuredContent!;
  const jwt = sc.session_jwt as string;
  const sessionId = sc.session_id as string;
  const ttlSeconds = (sc.ttl_seconds as number) ?? 900;
  const host = config.gatewayHost ?? (sc.endpoint as { host: string })?.host ?? "localhost";
  const port = config.gatewayPort ?? (sc.endpoint as { port: number })?.port ?? 9500;

  return {
    sessionId,
    jwt,
    endpointId,
    gatewayHost: host,
    gatewayPort: port,
    granted: sc.granted,
    ttlSeconds,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

// ── DuckDB + quack ATTACH ─────────────────────────────────────────────────────

export interface DuckQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) return String(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

export class WaddlingDuck {
  private connection: DuckDBConnection | null = null;
  private session: AcquiredSession;
  private config: WaddlingDuckConfig;
  private attached = false;

  private constructor(session: AcquiredSession, config: WaddlingDuckConfig) {
    this.session = session;
    this.config = config;
  }

  /**
   * Create a new WaddlingDuck: boots an in-memory DuckDB, loads quack/httpfs,
   * acquires a fresh session JWT, and ATTACHes the gateway.
   */
  static async create(config: WaddlingDuckConfig = {}): Promise<WaddlingDuck> {
    const session = await acquireSession(config);
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();

    // Load extensions
    await connection.run("INSTALL quack; LOAD quack;");
    await connection.run("INSTALL httpfs; LOAD httpfs;");

    const quackUri = `quack:${session.gatewayHost}:${session.gatewayPort}`;

    // Authenticate via CREATE SECRET (quack ATTACH doesn't accept inline TOKEN)
    await connection.run(
      `CREATE SECRET (TYPE quack, TOKEN '${session.jwt.replace(/'/g, "''")}', SCOPE '${quackUri}');`,
    );

    // ATTACH the gateway
    await connection.run(`ATTACH '${quackUri}' AS lake (disable_ssl true);`);

    const duck = new WaddlingDuck(session, config);
    duck.connection = connection;
    duck.attached = true;
    return duck;
  }

  /** Check if the session is still valid. */
  get sessionValid(): boolean {
    return Date.now() < this.session.expiresAt;
  }

  /** Remaining session TTL in seconds. */
  get sessionTtl(): number {
    return Math.max(0, Math.round((this.session.expiresAt - Date.now()) / 1000));
  }

  /** The active grants for this session. */
  get granted(): unknown {
    return this.session.granted;
  }

  /**
   * Run a query against the attached gateway.
   * SQL is sent verbatim to the server via lake.query() to avoid catalog
   * alias shadowing (client ATTACH alias 'lake' = server's default catalog).
   * Use full server-side paths: `FROM lake.sales.orders LIMIT 5`.
   */
  async query(sql: string): Promise<DuckQueryResult> {
    if (!this.connection || !this.attached) {
      throw new Error("Not connected. Call WaddlingDuck.create() first.");
    }
    if (!this.sessionValid) {
      throw new Error("Session expired. Create a new WaddlingDuck instance.");
    }

    // Escape single quotes in SQL for the lake.query() wrapper
    const escaped = sql.replace(/'/g, "''");

    const reader = await this.connection.runAndReadAll(
      `FROM lake.query('${escaped}');`,
    );

    const columns = reader.columnNames();
    const objs = reader.getRowObjects() as Record<string, unknown>[];
    const rows = objs.map((o) =>
      columns.map((c) => normalize(o[c])),
    );

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * Run arbitrary SQL on the local DuckDB (not through the gateway).
   * Useful for local operations or for queries that don't need the gateway.
   */
  async runLocal(sql: string): Promise<void> {
    if (!this.connection) throw new Error("Not connected.");
    await this.connection.run(sql);
  }

  /** Release the connection (in-memory DuckDB cleanup on process exit is automatic). */
  close(): void {
    this.connection = null;
    this.attached = false;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`waddling-duck-client — query the waddling lake via a local in-memory DuckDB

Usage:
  npx tsx scripts/duckdb-client.ts [--analyst|--etlbot] "<SQL>"

Options:
  --analyst    Use analyst API key (default)
  --etlbot     Use etl-bot API key
  --key <key>  Explicit API key

Environment:
  WADDLING_API_KEY    Agent API key (sk_agent_…)
  WADDLING_MCP_URL    MCP server URL (default: http://localhost:8810)
  WADDLING_ENDPOINT   Endpoint ID (default: demo prod-lake)

Examples:
  npx tsx scripts/duckdb-client.ts "FROM lake.sales.orders LIMIT 5"
  npx tsx scripts/duckdb-client.ts --etlbot "SELECT * FROM lake.sales.events LIMIT 3"
  npx tsx scripts/duckdb-client.ts \\
    "SELECT c.name, COUNT(*) as orders \\
     FROM lake.sales.customers c JOIN lake.sales.orders o \\
     ON c.customer_id = o.customer_id \\
     GROUP BY c.name ORDER BY orders DESC LIMIT 5"
`);
    process.exit(0);
  }

  // Resolve API key
  let apiKey = process.env.WADDLING_API_KEY;
  let sql = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--analyst") {
      apiKey = apiKey ?? "sk_agent_analyst_demo";
    } else if (args[i] === "--etlbot") {
      apiKey = "sk_agent_etlbot_demo";
    } else if (args[i] === "--key" && i + 1 < args.length) {
      apiKey = args[++i];
    } else {
      sql = args.slice(i).join(" ");
      break;
    }
  }

  if (!sql) {
    console.error("Error: no SQL provided");
    process.exit(1);
  }

  console.error(`==> connecting to waddling gateway...`);
  const duck = await WaddlingDuck.create({
    apiKey,
    mcpUrl: process.env.WADDLING_MCP_URL,
    endpointId: process.env.WADDLING_ENDPOINT,
  });

  console.error(`==> session: ${duck.session.sessionId.slice(0, 8)}… (${duck.sessionTtl}s TTL)`);
  console.error(`==> running query...`);

  try {
    const result = await duck.query(sql);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await duck.close();
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
