/**
 * Minimal, dependency-free MCP server over Streamable HTTP (stateless).
 *
 * Why hand-rolled: control-api has no @modelcontextprotocol/sdk dependency and uses
 * zod v4 (the SDK pins zod v3), and the existing npm-package transport is built on
 * node:http req/res — neither composes cleanly with a workerd fetch handler. For a
 * STATELESS server the surface is tiny: initialize, notifications/initialized, ping,
 * tools/list, tools/call. So we implement just those over a Web Request → Response,
 * with zero new deps and guaranteed workerd compatibility.
 *
 * Statelessness is correct here: the existing transport already ran with
 * sessionIdGenerator:undefined and never read its per-request session map — the real
 * data-session handle lives in the data plane, re-passed as `session_id` per query.
 *
 * Auth is handled by the CALLER (the /mcp route gates with resolveCaller before
 * dispatching). This module only forwards the caller's Authorization header into the
 * tool loopback.
 */
import { TOOLS, TOOLS_BY_NAME, type ToolCtx, type ToolResult } from './tools';

const SERVER_INFO = { name: 'waddling', version: '0.1.0' };
const LATEST_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INSTRUCTIONS =
  'waddling governs AI-agent access to analytics datalakes. Start with ' +
  'waddling_list_datalakes, then waddling_describe to learn the catalog you may see, ' +
  'waddling_connect to open a session, waddling_query to run governed SQL (reference the ' +
  'lake as lake.<schema>.<table>). To LOAD data into the lake from an external source ' +
  '(CTAS/INSERT over read_json/read_csv/read_parquet), use waddling_etl — it runs on the ' +
  'gateway with egress after birdshot authorizes the statement. Use waddling_whoami to check ' +
  "grants WITHOUT triggering a denial. Denials are structured { error, table, reason } — read `reason` and self-correct. " +
  'If you genuinely need access you lack, call waddling_request_access to get a human-approval ' +
  'link, give it to the user, then call waddling_await_access (it blocks ~20s and returns { granted }) ' +
  'in a loop until granted, up to ~10 min, before retrying.';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

function resultMsg(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function errorMsg(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Dispatch a single JSON-RPC request message. Returns null for notifications. */
async function dispatch(msg: JsonRpcRequest, ctx: ToolCtx): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case 'initialize': {
      const requested = (msg.params?.protocolVersion as string | undefined) ?? LATEST_PROTOCOL;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL;
      return resultMsg(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications get no response
    case 'ping':
      return resultMsg(id, {});
    case 'tools/list':
      return resultMsg(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const name = msg.params?.name as string | undefined;
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const tool = name ? TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return errorMsg(id, -32602, `unknown tool: ${name ?? '(none)'}`);
      let out: ToolResult;
      try {
        out = await tool.handler(args, ctx);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        out = { content: [{ type: 'text', text: JSON.stringify({ error: 'tool_error', reason }) }], isError: true };
      }
      return resultMsg(id, out);
    }
    default:
      if (isNotification) return null;
      return errorMsg(id, -32601, `method not found: ${msg.method ?? '(none)'}`);
  }
}

/**
 * Handle one Streamable-HTTP MCP request. POST carries JSON-RPC (single or batch);
 * we answer with application/json (no SSE — stateless). GET/DELETE have no streaming
 * surface here. The caller has already authenticated the request.
 */
export async function handleMcp(req: Request, ctx: ToolCtx): Promise<Response> {
  if (req.method === 'GET') {
    // No server-initiated SSE stream offered (stateless) — spec-compliant 405.
    return new Response(JSON.stringify({ error: 'method_not_allowed', reason: 'GET stream not offered' }), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST, DELETE' },
    });
  }
  if (req.method === 'DELETE') {
    // Stateless: no session to terminate.
    return new Response(null, { status: 204 });
  }
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }

  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcRequest[];
  const responses: JsonRpcResponse[] = [];
  for (const m of messages) {
    const r = await dispatch(m ?? {}, ctx);
    if (r) responses.push(r);
  }

  // All-notifications input → 202 Accepted, no body.
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(batch ? responses : responses[0]);
}
