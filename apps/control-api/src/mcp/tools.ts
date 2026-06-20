/**
 * In-worker MCP tool registry — the day-0, zero-install tool surface served at
 * `/mcp` on the control-api Worker. Mirrors packages/mcp-external/src/tools.ts,
 * but instead of a network REST client each tool is a LOOPBACK call into this same
 * Worker's `/api/cp/*` routes (ToolCtx.loopback), forwarding the caller's inbound
 * `Authorization` header. The existing route handlers re-`resolveCaller` and enforce
 * exactly as for an external caller — so there is no duplicated authz here.
 *
 * Drift note: these descriptors are kept parallel to the npm package's tools.ts
 * (the local/Claude-Desktop surface). A follow-up may extract a shared module; for
 * now the two are mirrored deliberately (control-api does not import workspace
 * packages — see lib/types.ts header).
 *
 * Only tools with a live control-api backend are registered: list, describe,
 * connect, query, whoami, install_extension. `explain` / `time_travel` are omitted
 * until their backend routes exist (they would 404).
 */

/** JSON Schema for a tool's arguments (object schema only — all tools take flat args). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** MCP tool-call result (content blocks + optional structured payload). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Result of a loopback call into an in-process `/api/cp/*` route. */
export interface LoopbackResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface ToolCtx {
  /** Dispatch into this Worker's own routes carrying the caller's Authorization. */
  loopback: (path: string, init?: { method?: string; body?: unknown }) => Promise<LoopbackResult>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

// ── result helpers ───────────────────────────────────────────────────────────

function ok(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const structured =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** Map a non-2xx loopback body to a structured, actionable tool error. Authorization
 *  denials ({ error:'authorization_denied', table, reason }) pass through verbatim so
 *  the agent can self-correct without a human round-trip. */
function failFrom(r: LoopbackResult): ToolResult {
  const body =
    r.data && typeof r.data === 'object'
      ? (r.data as Record<string, unknown>)
      : { error: `http_${r.status}`, reason: String(r.data ?? r.status) };
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    isError: true,
    structuredContent: body,
  };
}

function failErr(err: unknown): ToolResult {
  const reason = err instanceof Error ? err.message : String(err);
  const body = { error: 'tool_error', reason };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true, structuredContent: body };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// ── tool descriptors ─────────────────────────────────────────────────────────

const listDatalakes: McpTool['handler'] = async (_args, ctx) => {
  try {
    const r = await ctx.loopback('/api/cp/datalakes');
    return r.ok ? ok(r.data) : failFrom(r);
  } catch (e) {
    return failErr(e);
  }
};

const describe: McpTool['handler'] = async (args, ctx) => {
  try {
    const id = str(args.datalake_id) ?? str(args.endpoint_id);
    if (!id) return failErr(new Error('datalake_id is required'));
    const qs = new URLSearchParams();
    if (str(args.schema)) qs.set('schema', str(args.schema)!);
    if (str(args.table)) qs.set('table', str(args.table)!);
    const suffix = qs.toString() ? `?${qs}` : '';
    const r = await ctx.loopback(`/api/cp/datalakes/${encodeURIComponent(id)}/describe${suffix}`);
    return r.ok ? ok(r.data) : failFrom(r);
  } catch (e) {
    return failErr(e);
  }
};

const connect: McpTool['handler'] = async (args, ctx) => {
  try {
    const id = str(args.datalake_id) ?? str(args.endpoint_id);
    if (!id) return failErr(new Error('datalake_id is required'));
    const r = await ctx.loopback('/api/cp/sessions', { method: 'POST', body: { datalakeId: id } });
    if (!r.ok) return failFrom(r);
    const d = r.data as { sessionId: string; workspaceId: string; agentId: string; ttlSeconds: number; granted: unknown };
    return ok({
      session_id: d.sessionId,
      workspace_id: d.workspaceId,
      agent_id: d.agentId,
      ttl_seconds: d.ttlSeconds,
      granted: d.granted,
    });
  } catch (e) {
    return failErr(e);
  }
};

const runQuery: McpTool['handler'] = async (args, ctx) => {
  try {
    const sessionId = str(args.session_id);
    const sql = str(args.sql);
    if (!sessionId) return failErr(new Error('session_id is required'));
    if (!sql) return failErr(new Error('sql is required'));
    const r = await ctx.loopback(`/api/cp/sessions/${encodeURIComponent(sessionId)}/query`, {
      method: 'POST',
      body: { sql },
    });
    if (!r.ok) return failFrom(r);
    const d = r.data as {
      columns: string[];
      rows: unknown[][];
      rowCount: number;
      truncated: boolean;
      snapshotVersion?: string;
    };
    return ok({
      columns: d.columns,
      rows: d.rows,
      row_count: d.rowCount,
      truncated: d.truncated,
      snapshot_version: d.snapshotVersion,
    });
  } catch (e) {
    return failErr(e);
  }
};

const whoami: McpTool['handler'] = async (args, ctx) => {
  try {
    const sessionId = str(args.session_id);
    const suffix = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    const r = await ctx.loopback(`/api/cp/whoami${suffix}`);
    return r.ok ? ok(r.data) : failFrom(r);
  } catch (e) {
    return failErr(e);
  }
};

const installExtension: McpTool['handler'] = async () =>
  ok({
    sql: "SET allow_unsigned_extensions = true;\nINSTALL birdshot FROM 'https://ext.getwaddling.com';\nLOAD birdshot;",
    note:
      'birdshot is a custom (unsigned) extension; allow_unsigned_extensions must be set. httpfs ' +
      'auto-loads for the HTTPS repo. Binaries are published for linux_amd64, linux_arm64, ' +
      'osx_arm64, osx_amd64, windows_amd64 under DuckDB engine v1.5.3. You usually do NOT need ' +
      'this — the waddling gateway runs birdshot for you; just connect with waddling_connect.',
  });

// ── quackboard: the per-org agent coordination board ───────────────────────────
// Each loops back to /api/cp/quackboard/*; the route binds agent_role from the caller's
// identity. No session_id — the agent's key IS the identity, resolved per call.

const qbPost = (path: string): McpTool['handler'] => async (args, ctx) => {
  try {
    const r = await ctx.loopback(`/api/cp/quackboard/${path}`, { method: 'POST', body: args });
    return r.ok ? ok(r.data) : failFrom(r);
  } catch (e) {
    return failErr(e);
  }
};

const datalakeIdProp = {
  datalake_id: { type: 'string', description: 'Datalake id from waddling_list_datalakes.' },
  endpoint_id: { type: 'string', description: 'Deprecated alias for datalake_id.' },
};

export const TOOLS: McpTool[] = [
  {
    name: 'waddling_list_datalakes',
    description:
      'List the governed datalakes (analytics lakehouses) this caller can access. Call this FIRST ' +
      'to discover what you can connect to. Returns [{id, name, slug, status}]. Use a datalake `id` ' +
      'with waddling_describe or waddling_connect.',
    inputSchema: { type: 'object', properties: {} },
    handler: listDatalakes,
  },
  // Alias: live agent configs may still call the old name — keep it working.
  {
    name: 'waddling_list_endpoints',
    description: 'Deprecated alias for waddling_list_datalakes.',
    inputSchema: { type: 'object', properties: {} },
    handler: listDatalakes,
  },
  {
    name: 'waddling_describe',
    description:
      'Discover the catalog for a datalake, SCOPED to what this agent may see — ungranted ' +
      'schemas/tables/columns are filtered out (no leak). Returns tables with columns, types, and ' +
      'row estimates. Use before querying to learn exact names. Optionally narrow with `schema` / `table`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...datalakeIdProp,
        schema: { type: 'string', description: 'Restrict to one schema.' },
        table: { type: 'string', description: 'Restrict to one table.' },
      },
    },
    handler: describe,
  },
  {
    name: 'waddling_connect',
    description:
      'Open a governed session on a datalake. Returns { session_id, workspace_id, agent_id, ' +
      'ttl_seconds, granted }. This provisions your durable, encrypted, private workspace and ' +
      'attaches the governed lake server-side — you do NOT run any ATTACH yourself. Then call ' +
      'waddling_query with the returned session_id. `granted` tells you which tables/verbs you have. ' +
      'Sessions are short-lived (~15m); if a later query returns { error:\'needs_configure\' }, call ' +
      'waddling_connect again to refresh.',
    inputSchema: { type: 'object', properties: { ...datalakeIdProp } },
    handler: connect,
  },
  {
    name: 'waddling_query',
    description:
      'Run a governed read/write in your workspace for an open session. Returns { columns, rows, ' +
      'row_count, truncated, snapshot_version }. Reference the attached lake by its alias `lake`, ' +
      'qualified as `lake.<schema>.<table>` (e.g. `SELECT * FROM lake.sales.orders LIMIT 5`). Column ' +
      'projection and row limits are enforced server-side by birdshot. On a denial you get ' +
      "{ error:'authorization_denied', reason } — read `reason` and adjust. If { error:'needs_configure' }, " +
      'your session went cold — call waddling_connect again, then retry.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session_id from waddling_connect.' },
        sql: { type: 'string', description: 'A single SQL statement; reference the lake as lake.<schema>.<table>.' },
      },
      required: ['session_id', 'sql'],
    },
    handler: runQuery,
  },
  {
    name: 'waddling_whoami',
    description:
      'Orient yourself: returns your agent identity, org, active grants (tables/verbs), and remaining ' +
      'session TTL. Call any time to understand exactly what you can do — no trial-and-error denials. ' +
      'Pass `session_id` for live grants + TTL, or omit for your standing identity.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Optional open session to report live grants + TTL for.' } },
    },
    handler: whoami,
  },
  {
    name: 'waddling_install_extension',
    description:
      'Get the one-liner to INSTALL + LOAD the birdshot extension in a LOCAL DuckDB you run yourself ' +
      '(self-hosted / edge case — most agents never need this; the gateway runs birdshot server-side). ' +
      'Returns { sql, note }.',
    inputSchema: { type: 'object', properties: {} },
    handler: installExtension,
  },
  // ── quackboard: shared per-org agent memory + coordination ──────────────────
  {
    name: 'waddling_qb_join',
    description:
      'Join your org\'s quackboard — a shared, governed coordination board for agents. Call this ' +
      'FIRST. Boots the board and returns { org_id, agent_id, shared_tables, protocol }. After ' +
      'joining: qb_observe findings, qb_recall to search, qb_subscribe + qb_inbox for pub/sub, ' +
      'qb_remember/qb_mine for PRIVATE notes only you can read, qb_query for raw SQL.',
    inputSchema: { type: 'object', properties: {} },
    handler: qbPost('join'),
  },
  {
    name: 'waddling_qb_observe',
    description:
      'Record a finding to the shared board (visible to every agent in your org). Your identity is ' +
      'stamped automatically. Fans a notification to any agent whose subscription matches. Returns ' +
      '{ ok, notified }.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The finding / observation text.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Optional reference strings (files, urls, ids).' },
        topic: { type: 'string', description: 'Optional topic tag.' },
      },
      required: ['content'],
    },
    handler: qbPost('observe'),
  },
  {
    name: 'waddling_qb_recall',
    description:
      'Search the shared observations (substring match), newest first. Returns { columns, rows }. Use ' +
      'this to see what other agents have found before you start work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term.' },
        limit: { type: 'number', description: 'Max rows (default 20, max 100).' },
      },
      required: ['query'],
    },
    handler: qbPost('recall'),
  },
  {
    name: 'waddling_qb_remember',
    description:
      'Save a PRIVATE note that only YOU can read back (per-agent memory — other agents cannot see it, ' +
      'not even via raw qb_query). Optionally key it. Returns { ok }.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Optional key to group/lookup the note.' },
        content: { type: 'string', description: 'The private note.' },
      },
      required: ['content'],
    },
    handler: qbPost('remember'),
  },
  {
    name: 'waddling_qb_mine',
    description:
      'Read back YOUR private notes (qb_remember), newest first. Optionally filter by `key`. Returns ' +
      '{ rows }. Scoped to your identity server-side — never returns another agent\'s memory.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Optional key filter.' },
        limit: { type: 'number', description: 'Max rows (default 50, max 500).' },
      },
    },
    handler: qbPost('mine'),
  },
  {
    name: 'waddling_qb_subscribe',
    description:
      'Subscribe to a pattern: when another agent observes content matching it, a notification lands in ' +
      'your qb_inbox. Returns { ok }.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring to watch for in new observations.' },
        topic: { type: 'string', description: 'Optional topic tag.' },
      },
      required: ['pattern'],
    },
    handler: qbPost('subscribe'),
  },
  {
    name: 'waddling_qb_inbox',
    description:
      'Your pub/sub notifications (from qb_subscribe matches), newest first. Returns { columns, rows }.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows (default 20, max 100).' } },
    },
    handler: qbPost('inbox'),
  },
  {
    name: 'waddling_qb_query',
    description:
      'Run raw governed SQL over the shared board tables (observations, notifications, subscriptions, ' +
      'messages, boundaries, objectives, claims). birdshot enforces access — a reference to another ' +
      'agent\'s private memory is denied. Returns { columns, rows }. Escape hatch for power use; prefer ' +
      'the verb tools above.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single SQL statement over the shared tables.' } },
      required: ['sql'],
    },
    handler: qbPost('query'),
  },
];

export const TOOLS_BY_NAME: Map<string, McpTool> = new Map(TOOLS.map((t) => [t.name, t]));
