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
  /** UI origin (no trailing slash) for building operator-facing deep links. */
  appUrl: string;
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

/** The catalog capabilities a delegation/acl_rule can carry (matches the control plane). */
const CATALOG_CAPS = ['read', 'write', 'create', 'drop', 'alter', 'detach'];

/** utf8-safe base64url. Inverse of the frontend's decodeProposal (lib/access-diff.ts). */
function b64urlEncode(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Resolve the calling agent's id via /api/cp/whoami (api-key agents resolve to self). */
async function resolveAgentId(ctx: ToolCtx): Promise<string | undefined> {
  const r = await ctx.loopback('/api/cp/whoami');
  if (!r.ok || !r.data || typeof r.data !== 'object') return undefined;
  const id = (r.data as { agentId?: unknown }).agentId;
  return typeof id === 'string' ? id : undefined;
}

/** A single requested catalog grant flattened to one (schema, table, capability). */
interface GrantTarget { datalakeId: string; schema: string; table: string; cap: string }

/**
 * Parse the shared `{ datalake_id, grants:[{schema,table,caps}] }` arg shape into flat
 * (schema, table, capability) targets. Returns an error string on invalid input.
 */
function parseGrantTargets(args: Record<string, unknown>): GrantTarget[] | string {
  const datalakeId = str(args.datalake_id) ?? str(args.endpoint_id);
  if (!datalakeId) return 'datalake_id is required';
  const grantsInput = Array.isArray(args.grants) ? args.grants : undefined;
  if (!grantsInput || grantsInput.length === 0) {
    return 'grants is required: a non-empty array of { schema, table, caps }';
  }
  const targets: GrantTarget[] = [];
  for (const g of grantsInput) {
    const gg = (g ?? {}) as Record<string, unknown>;
    const schema = str(gg.schema) ?? '*';
    const table = str(gg.table) ?? '*';
    const caps = Array.isArray(gg.caps) ? gg.caps : [];
    for (const c of caps) {
      if (typeof c === 'string' && CATALOG_CAPS.includes(c)) targets.push({ datalakeId, schema, table, cap: c });
    }
  }
  if (targets.length === 0) return `each grant needs at least one catalog capability (${CATALOG_CAPS.join(', ')})`;
  return targets;
}

/** A grant rule as returned by GET /api/cp/acl. */
interface AclRow { datalakeId: string; capability: string; schemaName: string; tableName: string; effect: string }

/** Does any allow rule COVER this (schema, table, capability) target? (wildcards widen.) */
function targetCovered(rules: AclRow[], t: GrantTarget): boolean {
  return rules.some(
    (r) =>
      r.effect === 'allow' &&
      r.datalakeId === t.datalakeId &&
      r.capability === t.cap &&
      (r.schemaName === '*' || r.schemaName === t.schema) &&
      (r.tableName === '*' || r.tableName === t.table),
  );
}

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

const runEtl: McpTool['handler'] = async (args, ctx) => {
  try {
    const sessionId = str(args.session_id);
    const sql = str(args.sql);
    if (!sessionId) return failErr(new Error('session_id is required'));
    if (!sql) return failErr(new Error('sql is required'));
    const r = await ctx.loopback(`/api/cp/sessions/${encodeURIComponent(sessionId)}/etl`, {
      method: 'POST',
      body: { sql },
    });
    if (!r.ok) return failFrom(r);
    const d = r.data as { ok: boolean; phase: string; authorizeDecision: string };
    return ok({ ok: d.ok, phase: d.phase, authorize_decision: d.authorizeDecision });
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

// ── request access: surface a human-approval deep link to expand this agent ─────
// No DB write — stateless. The tool returns a URL that opens the agent's Access editor
// with the requested grants overlaid as a pending diff; a human operator clicks Save to
// approve. The agent waits by polling waddling_whoami until the new grants appear.
const requestAccess: McpTool['handler'] = async (args, ctx) => {
  try {
    const datalakeId = str(args.datalake_id) ?? str(args.endpoint_id);
    if (!datalakeId) return failErr(new Error('datalake_id is required'));

    const grantsInput = Array.isArray(args.grants) ? args.grants : undefined;
    if (!grantsInput || grantsInput.length === 0) {
      return failErr(new Error('grants is required: a non-empty array of { schema, table, caps }'));
    }
    const grants = grantsInput
      .map((g) => {
        const gg = (g ?? {}) as Record<string, unknown>;
        const capsRaw = Array.isArray(gg.caps) ? gg.caps : [];
        return {
          datalakeId,
          schema: str(gg.schema) ?? '*',
          table: str(gg.table) ?? '*',
          caps: capsRaw.filter((c): c is string => typeof c === 'string' && CATALOG_CAPS.includes(c)),
        };
      })
      .filter((g) => g.caps.length > 0);
    if (grants.length === 0) {
      return failErr(new Error(`each grant needs at least one catalog capability (${CATALOG_CAPS.join(', ')})`));
    }

    // The agent being expanded: an explicit agent_id, else the calling agent itself.
    const agentId = str(args.agent_id) ?? (await resolveAgentId(ctx));
    if (!agentId) {
      return failErr(new Error('could not resolve an agent to expand — pass agent_id explicitly'));
    }

    const propose = b64urlEncode({ grants, policies: [] });
    const url = `${ctx.appUrl}/agents/${encodeURIComponent(agentId)}?section=access&propose=${propose}`;
    return ok({
      url,
      agent_id: agentId,
      requested: grants.map((g) => ({ schema: g.schema, table: g.table, caps: g.caps })),
      wait_for: {
        tool: 'waddling_await_access',
        args: { datalake_id: datalakeId, grants: grants.map((g) => ({ schema: g.schema, table: g.table, caps: g.caps })), timeout_seconds: 20 },
        note: 'blocks up to ~20s per call and returns { granted }; call it again until granted, and give up after ~10 minutes total.',
      },
      message:
        'Access is NOT granted yet — this call only creates an approval link; it does not change ' +
        'access. Do this:\n' +
        '1. Show `url` to a human operator (an org owner or admin) and ask them to open it and click ' +
        'Save — it opens the agent’s Access editor with the requested grants highlighted as a pending ' +
        'change.\n' +
        '2. Wait for approval by calling waddling_await_access (the `wait_for` block has the exact ' +
        'args): it blocks ~20s server-side and returns { granted }. Call it again while granted=false.\n' +
        '3. Once granted=true, retry the work that was blocked. If still not granted after ~10 minutes, ' +
        'stop, tell the user the request is still pending, and let them approve via the link and ask you ' +
        'to retry. Do not loop indefinitely.',
    });
  } catch (e) {
    return failErr(e);
  }
};

// ── await access: bounded server-side wait for an approval to land ──────────────
// Blocks up to ~timeout_seconds (clamped ≤25s so a single call stays workerd-safe),
// polling the agent's grants until every requested (schema,table,cap) is covered. The
// agent loops this for longer total waits — the loop + clamp express the timeout.
const awaitAccess: McpTool['handler'] = async (args, ctx) => {
  try {
    const parsed = parseGrantTargets(args);
    if (typeof parsed === 'string') return failErr(new Error(parsed));
    const targets = parsed;
    const datalakeId = targets[0].datalakeId;

    const agentId = str(args.agent_id) ?? (await resolveAgentId(ctx));
    if (!agentId) return failErr(new Error('could not resolve an agent — pass agent_id explicitly'));

    const wantSecs = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 20;
    const budgetMs = Math.min(Math.max(wantSecs, 1), 25) * 1000;
    const POLL_MS = 2500;
    const started = Date.now();

    const check = async (): Promise<GrantTarget[]> => {
      const r = await ctx.loopback(
        `/api/cp/acl?agentId=${encodeURIComponent(agentId)}&datalakeId=${encodeURIComponent(datalakeId)}`,
      );
      if (r.status === 403) {
        throw new Error(
          'waddling_await_access needs an agent API key (sk_…) — a delegated OAuth session cannot read ' +
            'agent grants. Confirm approval with waddling_whoami (pass your session_id) instead.',
        );
      }
      if (!r.ok) throw new Error(`could not read grants: http_${r.status}`);
      const rules = ((r.data as { rules?: AclRow[] }).rules ?? []) as AclRow[];
      return targets.filter((t) => !targetCovered(rules, t));
    };

    let missing = await check();
    while (missing.length > 0 && Date.now() - started < budgetMs) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      missing = await check();
    }

    const requested = targets.map((t) => ({ schema: t.schema, table: t.table, capability: t.cap }));
    if (missing.length === 0) {
      return ok({ granted: true, agent_id: agentId, requested, message: 'Access granted — retry the work that was blocked.' });
    }
    return ok({
      granted: false,
      agent_id: agentId,
      waited_seconds: Math.round((Date.now() - started) / 1000),
      still_missing: missing.map((t) => ({ schema: t.schema, table: t.table, capability: t.cap })),
      message:
        'Not granted within this wait window. If a human has not approved the request yet, call ' +
        'waddling_await_access again to keep waiting; after ~10 minutes total, stop and tell the user ' +
        'it is still pending.',
    });
  } catch (e) {
    return failErr(e);
  }
};

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
    name: 'waddling_etl',
    description:
      'Run a GOVERNED data-load (ETL) for an open session: a single CREATE TABLE … AS SELECT … or ' +
      'INSERT … that ingests from an external source (e.g. read_json/read_csv/read_parquet over https) ' +
      'INTO the lake. Use this — not waddling_query — when the statement writes to the lake or reads ' +
      'from a URL: it executes on the gateway (which has egress) after birdshot authorizes the exact ' +
      'statement. You need the `create` (or `write`) capability on the target schema AND a source ' +
      'policy allowing the URL host. Reference the lake target by bare `<schema>.<table>` (e.g. ' +
      '`CREATE TABLE staging.hn AS SELECT * FROM read_json(\'https://host/path\')`). Denials return ' +
      "{ error:'authorization_denied', reason } from the parse literal, before any fetch. Returns " +
      '{ ok, phase, authorize_decision }; query the loaded table afterward with waddling_query.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session_id from waddling_connect.' },
        sql: { type: 'string', description: 'A single governed load statement (CTAS/INSERT) ingesting into the lake.' },
      },
      required: ['session_id', 'sql'],
    },
    handler: runEtl,
  },
  {
    name: 'waddling_whoami',
    description:
      'Orient yourself: returns your agent identity, org, and your active access as the LITERAL ' +
      'GRANT/DENY SQL governing your key — `grants.statements` for the session/datalake in scope, and ' +
      '`grantsByDatalake[]` (the same grant SQL in every datalake you can reach) so a bare call still ' +
      'shows exactly what you can do — no trial-and-error denials. Pass `session_id` for live grants + ' +
      'remaining TTL, or omit for your standing identity. Also the way to confirm a ' +
      'waddling_request_access approval: poll this until the requested grants appear in the statements.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Optional open session to report live grants + TTL for.' } },
    },
    handler: whoami,
  },
  {
    name: 'waddling_request_access',
    description:
      'Request EXPANDED access for this agent when a query was denied or you need a table/capability ' +
      'you lack. Returns { url, wait_for, message }: `url` is a link a human operator (org owner/admin) ' +
      'opens to review the requested grants as a pending change in the agent’s Access editor and ' +
      'approve by clicking Save. This does NOT grant access by itself, and there is no push ' +
      'notification — you must WAIT for approval: show the url to the user, then call ' +
      'waddling_await_access (the `wait_for` block has the exact args) in a loop until it returns ' +
      'granted=true, giving up after ~10 minutes (then tell the user it is still pending). For agents ' +
      'authenticated with an agent API key (sk_…); delegated OAuth sessions have no standing agent.',
    inputSchema: {
      type: 'object',
      properties: {
        ...datalakeIdProp,
        grants: {
          type: 'array',
          description:
            'The catalog access to request, one entry per table or schema. Use table:"*" for a whole ' +
            'schema, or schema:"*" too for the entire lake.',
          items: {
            type: 'object',
            properties: {
              schema: { type: 'string', description: 'Schema name, or "*" for all schemas.' },
              table: { type: 'string', description: 'Table name, or "*" for all tables in the schema.' },
              caps: {
                type: 'array',
                description: 'Catalog capabilities: read, write, create, drop, alter, detach.',
                items: { type: 'string' },
              },
            },
            required: ['caps'],
          },
        },
        agent_id: { type: 'string', description: 'Agent to expand (defaults to the calling agent).' },
      },
      required: ['grants'],
    },
    handler: requestAccess,
  },
  {
    name: 'waddling_await_access',
    description:
      'Wait for a pending waddling_request_access approval to land. Pass the SAME { datalake_id, grants } ' +
      'you requested; this BLOCKS up to ~timeout_seconds (≤25s) server-side, polling your grants, and ' +
      'returns { granted } as soon as every requested table/capability is covered (or after the wait ' +
      'window). Call it again while granted=false to keep waiting; give up after ~10 minutes total. Use ' +
      'this instead of hand-rolling a poll loop over waddling_whoami.',
    inputSchema: {
      type: 'object',
      properties: {
        ...datalakeIdProp,
        grants: {
          type: 'array',
          description: 'The same grants passed to waddling_request_access, one entry per table or schema.',
          items: {
            type: 'object',
            properties: {
              schema: { type: 'string', description: 'Schema name, or "*" for all schemas.' },
              table: { type: 'string', description: 'Table name, or "*" for all tables in the schema.' },
              caps: {
                type: 'array',
                description: 'Catalog capabilities: read, write, create, drop, alter, detach.',
                items: { type: 'string' },
              },
            },
            required: ['caps'],
          },
        },
        timeout_seconds: { type: 'number', description: 'Max seconds to block this call (default 20, capped at 25).' },
        agent_id: { type: 'string', description: 'Agent to check (defaults to the calling agent).' },
      },
      required: ['grants'],
    },
    handler: awaitAccess,
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
