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
 * The registered surface is deliberately the personal-data-store core: memory
 * (waddling_remember / waddling_recall) + the lake data path (list, describe,
 * connect, query, etl, whoami). The multi-agent coordination verbs and the
 * human-approval access flow have live backends but are unregistered — see
 * UNREGISTERED_TOOL_HANDLERS at the bottom. `explain` / `time_travel` are
 * omitted until their backend routes exist (they would 404).
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
      // What the workspace sandbox permits, so an agent knows its filesystem/egress bounds
      // up front instead of discovering them through denials. The gateway jails DuckDB file
      // access to this directory and blocks network egress; durable state is the `main` schema.
      workspace: {
        local_dir: '/tmp/workspace',
        local_files: 'allowed within /tmp/workspace only — you may COPY … TO and read_csv/read_parquet/read_json/read_blob files under this dir',
        durable: 'Tables you CREATE in the `main` schema persist across scale-to-zero (saved to encrypted object storage). Loose files under /tmp/workspace are scratch and are NOT persisted — materialize anything you need to keep as a `main` table.',
        network: 'blocked — no http/https/s3 access from the workspace; reads outside /tmp/workspace are denied',
      },
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

// waddling_recall — one search over BOTH memory surfaces: the agent's private
// notes (agent_memory, via /mine) and the org's shared observation corpus (BM25,
// via /recall). Both ride trusted /ctrl/qb-* gateway routes, so recall works on a
// fresh org with zero setup. /mine has no content filter server-side; it is
// substring-filtered here.
const recallMemory: McpTool['handler'] = async (args, ctx) => {
  try {
    const q = str(args.query);
    if (!q) return failErr(new Error('query is required'));
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 100) : 20;

    const [mineRes, corpusRes] = await Promise.all([
      ctx.loopback('/api/cp/quackboard/mine', { method: 'POST', body: { limit: 500 } }),
      ctx.loopback('/api/cp/quackboard/recall', { method: 'POST', body: { query: q, limit } }),
    ]);

    const rowsOf = (r: LoopbackResult): unknown[] => {
      if (!r.ok || !r.data || typeof r.data !== 'object') return [];
      const rows = (r.data as { rows?: unknown }).rows;
      return Array.isArray(rows) ? rows : [];
    };
    const needle = q.toLowerCase();
    const privateNotes = rowsOf(mineRes)
      .filter((row) => JSON.stringify(row).toLowerCase().includes(needle))
      .slice(0, limit);

    // A completely fresh memory lake may still be provisioning its gateway on the
    // very first call — surface that as a retryable state, not a hard error.
    if (!mineRes.ok && !corpusRes.ok) return failFrom(mineRes);

    return ok({
      query: q,
      private_notes: privateNotes,
      shared_observations: corpusRes.ok ? corpusRes.data : { rows: [] },
      note:
        privateNotes.length === 0 && !rowsOf(corpusRes).length
          ? 'Nothing remembered yet matches this — as you work, save durable facts with waddling_remember.'
          : undefined,
    });
  } catch (e) {
    return failErr(e);
  }
};

const datalakeIdProp = {
  datalake_id: { type: 'string', description: 'Datalake id from waddling_list_datalakes.' },
  endpoint_id: { type: 'string', description: 'Deprecated alias for datalake_id.' },
};

// ── the registry ─────────────────────────────────────────────────────────────
// Deliberately small: the personal-data-store surface is remember/recall +
// the lake data path. The multi-agent coordination tools (qb_join/observe/
// subscribe/inbox/query), the human-approval access flow (request_access/
// await_access), and install_extension have live handlers above/below but are
// UNREGISTERED — re-add them for the multi-agent tier, don't delete them.
export const TOOLS: McpTool[] = [
  {
    name: 'waddling_remember',
    description:
      "Save something durable to your user's personal data store — a fact you learned, how a table " +
      'is shaped, what you loaded and why, a decision made. It persists across sessions and ' +
      'restarts; call it whenever you learn something worth keeping. Notes are private to YOU ' +
      '(per-agent, server-enforced). Optionally set `key` to group related notes (e.g. one key per ' +
      'project or table). Returns { ok }.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The note to remember.' },
        key: { type: 'string', description: 'Optional key to group/lookup related notes.' },
      },
      required: ['content'],
    },
    handler: qbPost('remember'),
  },
  {
    name: 'waddling_recall',
    description:
      'Search your memory BEFORE starting work. Returns { private_notes, shared_observations }: ' +
      'your own waddling_remember notes plus what any of your other sessions/agents recorded in ' +
      "this org's shared corpus (full-text ranked). Pass a search term; optionally `limit`.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term.' },
        limit: { type: 'number', description: 'Max results per bucket (default 20, max 100).' },
      },
      required: ['query'],
    },
    handler: recallMemory,
  },
  {
    name: 'waddling_list_datalakes',
    description:
      'List the governed datalakes this caller can access. Call this to discover what you can ' +
      'connect to. Returns [{id, name, slug, status}]. Use a datalake `id` with waddling_describe ' +
      'or waddling_connect.',
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
      'ttl_seconds, granted, workspace }. This provisions your durable, encrypted, private workspace and ' +
      'attaches the governed lake server-side — you do NOT run any ATTACH yourself. Then call ' +
      'waddling_query with the returned session_id. `granted` tells you which tables/verbs you have; ' +
      '`workspace` tells you your filesystem sandbox: you may read/write local files ONLY under ' +
      '/tmp/workspace (COPY … TO, read_csv/read_parquet/read_json/read_blob), network egress ' +
      '(http/https/s3) is blocked, and only tables in the `main` schema persist across scale-to-zero. ' +
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
      'your session went cold — call waddling_connect again, then retry. Local filesystem: you may read ' +
      'and write files under /tmp/workspace only (e.g. `COPY (…) TO \'/tmp/workspace/out.csv\'`, ' +
      '`read_csv(\'/tmp/workspace/in.parquet\')`); paths outside it and all network access (http/https/s3) ' +
      'are blocked by configuration. Persist anything durable as a table in the `main` schema — loose ' +
      'files in /tmp/workspace are scratch and vanish on scale-to-zero.',
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
      'remaining TTL, or omit for your standing identity.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Optional open session to report live grants + TTL for.' } },
    },
    handler: whoami,
  },
  // ── quackboard: per-org agent coordination board ──────────────────────
  {
    name: 'waddling_board_note',
    description:
      'Post a shared, topic-scoped note to the org quackboard — visible to all agents. ' +
      'Use `topic` as a channel name to group related notes (e.g. "architecture", "decisions", ' +
      '"findings"). Every agent can recall these by topic later with waddling_recall. Returns ' +
      '{ ok, notified } where `notified` is the count of other agents whose subscriptions matched ' +
      '(pub/sub fan-out). Use to share discoveries, decisions, and durable context across agents.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The note text to share.' },
        topic: { type: 'string', description: 'Topic/channel name to group related notes (e.g. "architecture").' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Optional reference links or ids.' },
      },
      required: ['content'],
    },
    handler: qbPost('observe'),
  },
  {
    name: 'waddling_board_query',
    description:
      'Run a governed SQL query over the org quackboard shared tables (observations, notifications, ' +
      'subscriptions, messages, boundaries, objectives, claims). Birdshot enforces your per-agent ACL. ' +
      'Use to explore the board programmatically. Returns { columns, rows, rowCount }. DO NOT query ' +
      'agent_memory — it is private and unreachable through this path (denied by ACL by design).',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SQL statement against the quackboard shared tables.' },
      },
      required: ['sql'],
    },
    handler: qbPost('query'),
  },
  {
    name: 'waddling_board_subscribe',
    description:
      'Subscribe to a pub/sub pattern on the org quackboard. When any agent posts a waddling_board_note ' +
      'whose content matches your pattern (case-insensitive substring), a notification is fanned to ' +
      'your inbox. Optionally scope to a `topic`. Returns { ok }. Use waddling_board_inbox to read.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern to match (case-insensitive substring ILIKE).' },
        topic: { type: 'string', description: 'Optional topic to scope the subscription to.' },
      },
      required: ['pattern'],
    },
    handler: qbPost('subscribe'),
  },
  {
    name: 'waddling_board_join',
    description:
      'Ensure the org quackboard is booted with the latest birdshot ACL snapshot and return the ' +
      'shared-table protocol. Idempotent — call it at the start of a session to confirm the board is ' +
      'ready. Returns { org_id, agent_id, shared_tables, protocol }.',
    inputSchema: { type: 'object', properties: {} },
    handler: qbPost('join'),
  },
  {
    name: 'waddling_board_inbox',
    description:
      'Read your quackboard notification inbox — the per-agent inbox populated by pub/sub fan-out ' +
      'when another agent posts an observation matching your subscriptions. Returns { columns, rows, ' +
      'rowCount } with id, sub_id, snippet, ts, and is_read fields. Optionally set `limit` (default 20).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max notifications to return (default 20, max 100).' },
      },
    },
    handler: qbPost('inbox'),
  },
  {
    name: 'waddling_board_graph',
    description:
      'Retrieve context from the quackboard KNOWLEDGE GRAPH, scoped to what YOU may see: all shared ' +
      'observations plus your OWN private memories (never another agent\'s memory). With a `query`, ' +
      'returns the semantically nearest nodes (via a self-hosted Qwen3 embedding + cosine search) — ' +
      'use this for "what do we already know about X?" recall that spans observations and your notes. ' +
      'Without a query, returns your allowed subgraph. Returns { nodes, edges }; each node has ' +
      '{ node_kind (observation|memory), node_id, label, topic, ts, sim? }. Newly-written items are ' +
      'embedded asynchronously (a nightly pass), so the freshest notes may not appear immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query to find relevant nodes by meaning. Omit to list your allowed subgraph.' },
        limit: { type: 'number', description: 'Max nodes to return (default 100, max 200).' },
      },
    },
    handler: qbPost('graph-query'),
  },
  {
    name: 'waddling_board_link',
    description:
      'Declare a relationship edge in the quackboard context graph between two nodes — an observation ' +
      'or your own memory. Use to assert that two pieces of context are related (e.g. a finding that ' +
      'supports a decision). These agent-declared edges are preserved across the nightly semantic ' +
      'recompute. Identify nodes by { kind: observation|memory, id } (ids come from waddling_board_graph ' +
      'or waddling_board_query). Returns { ok }.',
    inputSchema: {
      type: 'object',
      properties: {
        srcKind: { type: 'string', enum: ['observation', 'memory'], description: 'Source node kind.' },
        srcId: { type: 'number', description: 'Source node id.' },
        dstKind: { type: 'string', enum: ['observation', 'memory'], description: 'Destination node kind.' },
        dstId: { type: 'number', description: 'Destination node id.' },
        weight: { type: 'number', description: 'Optional edge weight/strength (default 1.0).' },
      },
      required: ['srcKind', 'srcId', 'dstKind', 'dstId'],
    },
    handler: qbPost('link'),
  },
];

// Unregistered handlers kept for the multi-agent tier: requestAccess, awaitAccess,
// installExtension, and the qb coordination verbs (via qbPost: join/observe/
// subscribe/inbox/query/mine/recall). Referencing them here keeps them compiled
// and lint-clean until they are re-registered.
export const UNREGISTERED_TOOL_HANDLERS: Record<string, McpTool['handler']> = {
  waddling_request_access: requestAccess,
  waddling_await_access: awaitAccess,
  waddling_install_extension: installExtension,
};

export const TOOLS_BY_NAME: Map<string, McpTool> = new Map(TOOLS.map((t) => [t.name, t]));
