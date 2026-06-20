#!/usr/bin/env node
/**
 * waddling Internal MCP Server — W4
 * Admin plane: ops agents manage/monitor agents, sessions, ACLs, audit, usage, endpoints.
 * Thin REST client of /api/cp/* — no business logic here; control plane owns policy.
 *
 * Env:
 *   WADDLING_URL          Base URL of the control plane (e.g. https://app.getwaddling.com)
 *   WADDLING_ADMIN_TOKEN  Bearer token for admin access
 *
 * Run modes:
 *   stdio (default)         — compatible with Claude Desktop / npx usage
 *   --http [--port <n>]     — StreamableHTTP on port (default 8820)
 *
 * Assumed REST contract (W1 must implement these):
 *   GET  /api/cp/agents?org_id=&status=               → AgentSummary[]
 *   GET  /api/cp/sessions?org_id=&agent_id=&status=   → SessionSummary[]
 *   POST /api/cp/acl                                   → GrantResult  (body: AclRuleInput camelCase)
 *   DELETE /api/cp/acl/:rule_id                        → { success: boolean }
 *   POST /api/cp/agents/:agent_id/revoke               → RevokeResult (body: { reason, expiresSeconds? })
 *   POST /api/cp/sessions/:session_id/kill             → { success: boolean } (body: { reason })
 *   GET  /api/cp/audit?org_id=&agent_id=&since=&decision=&limit=  → AuditEventRow[]
 *   GET  /api/cp/usage?org_id=&agent_id=&period=       → UsageRollup[]
 *   GET  /api/cp/endpoints?endpoint_id=                → EndpointStatus[]
 *   POST /api/cp/endpoints                             → ProvisionResult (body: { orgId, name, dataPath?, region? })
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer } from 'node:http';
import { createTelemetry } from './telemetry';
import type {
  AgentSummary,
  SessionSummary,
  GrantResult,
  RevokeResult,
  AuditEventRow,
  UsageRollup,
  EndpointStatus,
  ProvisionResult,
  AclRuleInput,
} from '@waddling/control-schema';

// ── Config ─────────────────────────────────────────────────────────────────────

const WADDLING_URL = (process.env['WADDLING_URL'] ?? 'https://app.getwaddling.com').replace(/\/$/, '');
const WADDLING_ADMIN_TOKEN = process.env['WADDLING_ADMIN_TOKEN'] ?? '';

// Telemetry (FUNNEL / Stream B): admin-side funnel events. Flushed on exit.
const telemetry = createTelemetry();

// ── Shared fetch helper ────────────────────────────────────────────────────────

interface ApiError {
  error: string;
  detail?: string;
  hint?: string;
}

type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

async function cpFetch<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<FetchResult<T>> {
  const url = `${WADDLING_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${WADDLING_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        error: 'network_error',
        detail: err instanceof Error ? err.message : String(err),
        hint: `Check that WADDLING_URL (${WADDLING_URL}) is reachable and WADDLING_ADMIN_TOKEN is set.`,
      },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = { error: 'invalid_response', detail: `HTTP ${response.status} — non-JSON body` };
  }

  if (!response.ok) {
    const e = payload as Partial<ApiError>;
    return {
      ok: false,
      error: {
        error: e.error ?? `http_${response.status}`,
        detail: e.detail ?? `Upstream returned ${response.status}`,
        hint: e.hint,
      },
    };
  }

  return { ok: true, data: payload as T };
}

/** Serialize a fetch result into an MCP tool return envelope */
function toToolResult(result: FetchResult<unknown>) {
  if (!result.ok) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.error, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
  };
}

/** Build a GET query string from an object, omitting undefined values */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

// ── MCP Server setup ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'waddling-admin',
  version: '0.1.0',
});

// ── Tool: waddling_admin_list_agents ──────────────────────────────────────────

server.registerTool(
  'waddling_admin_list_agents',
  {
    description:
      'List all agents (machine principals) in an org. Returns last-seen, default role, API-key status, and suspension state. First call when auditing who has access.',
    inputSchema: {
      org_id: z.string().optional().describe('Filter by organization ID (omit for all orgs you can see)'),
      status: z
        .enum(['active', 'suspended', 'revoked'])
        .optional()
        .describe('Filter by agent status'),
    },
  },
  async (args) => {
    const result = await cpFetch<AgentSummary[]>(
      'GET',
      `/api/cp/agents${qs({ org_id: args.org_id, status: args.status })}`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_list_sessions ────────────────────────────────────────

server.registerTool(
  'waddling_admin_list_sessions',
  {
    description:
      'List live and recent agent sessions (ATTACH sessions — not human browser sessions). Shows sid, endpoint, granted roles, started/expires timestamps. Use to monitor active connections.',
    inputSchema: {
      org_id: z.string().optional().describe('Filter by organization ID'),
      agent_id: z.string().optional().describe('Filter by agent ID'),
      status: z
        .enum(['active', 'expired', 'revoked', 'killed'])
        .optional()
        .describe('Filter by session status (omit for all)'),
    },
  },
  async (args) => {
    const result = await cpFetch<SessionSummary[]>(
      'GET',
      `/api/cp/sessions${qs({ org_id: args.org_id, agent_id: args.agent_id, status: args.status })}`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_grant ────────────────────────────────────────────────

server.registerTool(
  'waddling_admin_grant',
  {
    description:
      'Create an ACL rule granting (or denying) an agent access to a table/columns. Immediately triggers policy recompile and birdshot snapshot push to the gateway — takes effect on the next query. Returns the new rule ID and compiled birdshot grants for verification.',
    inputSchema: {
      endpoint_id: z.string().describe('Target endpoint (DuckLake gateway) ID'),
      agent_id: z.string().optional().describe('Agent to grant access to (omit = org-wide rule)'),
      schema: z.string().describe('Schema name (use * for wildcard)'),
      table: z.string().describe('Table name (use * for wildcard)'),
      columns: z
        .array(z.string())
        .optional()
        .describe('Allow-listed columns (omit = all columns)'),
      verb: z.enum(['read', 'write']).describe('Access verb'),
      effect: z.enum(['allow', 'deny']).optional().describe('Rule effect (default: allow)'),
      row_limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum rows the agent may retrieve per query'),
      ttl_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Rule auto-expires after this many seconds'),
      window_start: z
        .string()
        .optional()
        .describe('Time-of-day window open (UTC HH:MM, e.g. "09:00")'),
      window_end: z
        .string()
        .optional()
        .describe('Time-of-day window close (UTC HH:MM, e.g. "17:00")'),
      not_before: z.string().optional().describe('Absolute activation timestamp (ISO 8601)'),
      expires_at: z.string().optional().describe('Absolute expiry timestamp (ISO 8601)'),
    },
  },
  async (args) => {
    // Translate snake_case tool params → camelCase AclRuleInput for W1 REST API
    const body: AclRuleInput = {
      endpointId: args.endpoint_id,
      agentId: args.agent_id,
      schema: args.schema,
      table: args.table,
      columns: args.columns,
      verb: args.verb,
      effect: args.effect,
      rowLimit: args.row_limit,
      ttlSeconds: args.ttl_seconds,
      window:
        args.window_start !== undefined && args.window_end !== undefined
          ? { start: args.window_start, end: args.window_end }
          : undefined,
      notBefore: args.not_before,
      expiresAt: args.expires_at,
    };
    const result = await cpFetch<GrantResult>('POST', '/api/cp/acl', body);
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_revoke_rule ──────────────────────────────────────────

server.registerTool(
  'waddling_admin_revoke_rule',
  {
    description:
      'Delete a specific ACL rule by ID and trigger policy recompile. The agent loses this grant on its next query. Use waddling_admin_revoke_agent for an immediate kill across all sessions.',
    inputSchema: {
      rule_id: z.string().describe('ACL rule ID to delete (from waddling_admin_grant or audit log)'),
    },
  },
  async (args) => {
    const result = await cpFetch<{ success: boolean }>(
      'DELETE',
      `/api/cp/acl/${encodeURIComponent(args.rule_id)}`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_revoke_agent ─────────────────────────────────────────

server.registerTool(
  'waddling_admin_revoke_agent',
  {
    description:
      'INSTANT kill switch — calls birdshot_revoke across ALL live sessions for this agent; the next query from any session is denied immediately (in-process denylist, no round-trip). Also marks the agent revoked in the control plane. Use for security incidents or offboarding.',
    inputSchema: {
      agent_id: z.string().describe('Agent ID to revoke immediately'),
      reason: z
        .string()
        .describe('Reason for revocation — recorded in audit log and returned to the agent'),
      expires_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'If set, the revocation auto-expires after this many seconds (temporary suspension). Omit for permanent revocation.',
        ),
    },
  },
  async (args) => {
    const result = await cpFetch<RevokeResult>(
      'POST',
      `/api/cp/agents/${encodeURIComponent(args.agent_id)}/revoke`,
      { reason: args.reason, expiresSeconds: args.expires_seconds },
    );
    if (result.ok) {
      // agent_id is an opaque id (no PII); reason text is NOT captured.
      telemetry.capture('agent_revoked', {
        temporary: args.expires_seconds !== undefined,
      });
    }
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_kill_session ─────────────────────────────────────────

server.registerTool(
  'waddling_admin_kill_session',
  {
    description:
      'Revoke a single agent session: JWT jti is added to the denylist and the session is marked killed. Other sessions for the same agent are unaffected. Use for surgical containment when one session is suspect.',
    inputSchema: {
      session_id: z
        .string()
        .describe('Agent session ID to kill (from waddling_admin_list_sessions)'),
      reason: z.string().describe('Reason for killing this session — recorded in audit log'),
    },
  },
  async (args) => {
    const result = await cpFetch<{ success: boolean }>(
      'POST',
      `/api/cp/sessions/${encodeURIComponent(args.session_id)}/kill`,
      { reason: args.reason },
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_audit ────────────────────────────────────────────────

server.registerTool(
  'waddling_admin_audit',
  {
    description:
      'Query the audit_event log: auth, authorize, query, grant, revoke, kill, attach events from both the gateway and control plane. Use since + agent_id to reconstruct what a specific agent did; use decision=deny to investigate access failures.',
    inputSchema: {
      org_id: z.string().optional().describe('Filter to a specific organization'),
      agent_id: z.string().optional().describe('Filter to a specific agent'),
      since: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp — return events at or after this time'),
      decision: z
        .enum(['allow', 'deny'])
        .optional()
        .describe('Filter by access decision (omit for all events)'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of events to return (default: 100)'),
    },
  },
  async (args) => {
    const result = await cpFetch<AuditEventRow[]>(
      'GET',
      `/api/cp/audit${qs({
        org_id: args.org_id,
        agent_id: args.agent_id,
        since: args.since,
        decision: args.decision,
        limit: args.limit,
      })}`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_usage ────────────────────────────────────────────────

server.registerTool(
  'waddling_admin_usage',
  {
    description:
      'Usage rollups: query counts, rows/bytes scanned, active sessions, estimated cost vs plan entitlements. Use to check billing posture, find heavy agents, or validate SLO adherence.',
    inputSchema: {
      org_id: z.string().optional().describe('Filter to a specific organization'),
      agent_id: z.string().optional().describe('Filter to a specific agent'),
      period: z
        .string()
        .optional()
        .describe(
          'Billing period in YYYY-MM format (e.g. "2025-06"); defaults to current month',
        ),
    },
  },
  async (args) => {
    const result = await cpFetch<UsageRollup[]>(
      'GET',
      `/api/cp/usage${qs({ org_id: args.org_id, agent_id: args.agent_id, period: args.period })}`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_endpoint_status ──────────────────────────────────────

server.registerTool(
  'waddling_admin_endpoint_status',
  {
    description:
      'Gateway health for one or all endpoints: running/stopped/error, birdshot_status() (auth mode, policy size, session count, audit ring depth), and DuckLake snapshot lag. First call when investigating gateway issues.',
    inputSchema: {
      endpoint_id: z
        .string()
        .optional()
        .describe(
          'Specific endpoint ID to inspect (omit for all endpoints you can see)',
        ),
    },
  },
  async (args) => {
    const result = await cpFetch<EndpointStatus[]>(
      'GET',
      `/api/cp/endpoints${qs({ endpoint_id: args.endpoint_id })}`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_provision_endpoint ───────────────────────────────────

server.registerTool(
  'waddling_admin_provision_endpoint',
  {
    description:
      'Provision a new DuckLake gateway endpoint for an org (enterprise feature). Spins up a dedicated quack_serve process with birdshot loaded, wires up R2/S3 data path, and returns provisioning status. Pro plan supports up to 5 endpoints; enterprise is unlimited.',
    inputSchema: {
      org_id: z.string().describe('Organization ID that will own this endpoint'),
      name: z
        .string()
        .describe('Human-readable endpoint name (e.g. "prod-lake", "analytics")'),
      data_path: z
        .string()
        .optional()
        .describe(
          'S3/R2 path for DuckLake data (e.g. "s3://org-acme/lake/"). Defaults to org-scoped bucket.',
        ),
      region: z
        .string()
        .optional()
        .describe('Cloud region for the gateway (default: "auto")'),
    },
  },
  async (args) => {
    const result = await cpFetch<ProvisionResult>('POST', '/api/cp/endpoints', {
      orgId: args.org_id,
      name: args.name,
      dataPath: args.data_path,
      region: args.region,
    });
    return toToolResult(result);
  },
);

// ── Gateway lifecycle + workspace recovery tools (Steps 1–5 of the lifecycle plan) ──
// These map 1:1 to the control-api recovery endpoints. They are the ops levers for a
// gateway whose cached birdshot snapshot went stale (direct DB edits, missed pushes) or
// whose workspace DuckDB got locked (lock_configuration) — the two cases a normal
// reconnect can't fix. All are org-scoped by the control plane (resolveCaller) and
// audited there; this server holds no policy logic.

// ── Tool: waddling_admin_refresh_policy (Step 1) ───────────────────────────────

server.registerTool(
  'waddling_admin_refresh_policy',
  {
    description:
      'On-demand recovery: recompile the FULL endpoint policy from waddling.acl_rule and push it to the gateway. The lever for a gateway whose cached birdshot snapshot went stale — e.g. after a DIRECT database edit to acl_rule bypassed the recompile+push, or a missed push. Surfaces push failures (502) instead of swallowing them. Returns the pushed snapshot (grants, userRoles, constraints, activeAgents).',
    inputSchema: {
      endpoint_id: z.string().describe('Datalake/endpoint ID to refresh the policy for'),
    },
  },
  async (args) => {
    const result = await cpFetch<unknown>(
      'POST',
      `/api/cp/datalakes/${encodeURIComponent(args.endpoint_id)}/refresh-policy`,
      {},
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_list_workspaces ──────────────────────────────────────

server.registerTool(
  'waddling_admin_list_workspaces',
  {
    description:
      'List the org\'s workspaces (per-(workspace, agent) durable DuckDB files) with live-session counts and the datalake each belongs to. Use before destroy/reconfigure to find the (workspaceId, agentId) pair to recover.',
    inputSchema: {},
  },
  async () => {
    const result = await cpFetch<unknown>('GET', '/api/cp/workspaces');
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_destroy_workspace (Step 2) ───────────────────────────

server.registerTool(
  'waddling_admin_destroy_workspace',
  {
    description:
      'Tear down a workspace container + its session. With purge=true (recommended for recovery), also deletes the R2 workspace object so the next connect bootstraps a FRESH DuckDB — the recovery lever for the "lock_configuration has been locked" deadlock that blocks reconnect. Also kills any active agent_session rows on the pair. Lighter alternative: waddling_admin_reconfigure_workspace (keeps the file).',
    inputSchema: {
      workspace_id: z.string().describe('Workspace ID (from waddling_admin_list_workspaces)'),
      agent_id: z.string().describe('Agent ID that owns this workspace slot'),
      purge: z
        .boolean()
        .optional()
        .describe(
          'Also delete the R2 workspace object so the next connect starts fresh (default false). Set true to recover from a locked/corrupt DuckDB file.',
        ),
      reason: z.string().optional().describe('Reason recorded in the audit log'),
    },
  },
  async (args) => {
    const result = await cpFetch<unknown>(
      'POST',
      `/api/cp/workspaces/${encodeURIComponent(args.workspace_id)}/agents/${encodeURIComponent(args.agent_id)}/destroy`,
      { purge: args.purge ?? false, reason: args.reason },
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_reconfigure_workspace (Step 2 + 7) ───────────────────

server.registerTool(
  'waddling_admin_reconfigure_workspace',
  {
    description:
      'Re-ATTACH the lake into a SURVIVING workspace container WITHOUT destroying it. Re-pushes the birdshot snapshot (so the gateway is armed) + re-inits the workspace sidecar with lockConfiguration:false, bypassing the "Cannot change configuration option lock_configuration" error a plain reconnect hits. Use this when you want to keep the workspace file/state; use destroy+purge when the DuckDB file itself is corrupt.',
    inputSchema: {
      workspace_id: z.string().describe('Workspace ID (from waddling_admin_list_workspaces)'),
      agent_id: z.string().describe('Agent ID that owns this workspace slot'),
    },
  },
  async (args) => {
    const result = await cpFetch<unknown>(
      'POST',
      `/api/cp/workspaces/${encodeURIComponent(args.workspace_id)}/agents/${encodeURIComponent(args.agent_id)}/reconfigure`,
      {},
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_list_replicas ────────────────────────────────────────

server.registerTool(
  'waddling_admin_list_replicas',
  {
    description:
      'Per-replica pool status for a datalake gateway: each replica\'s index, appliedVersion vs the current snapshot version, lastActiveAt, in-flight query count, and warm flag. Does NOT wake any container. Use before/after gateway_replica or reset_pool ops to see what state the pool is in.',
    inputSchema: {
      endpoint_id: z.string().describe('Datalake/endpoint ID'),
    },
  },
  async (args) => {
    const result = await cpFetch<unknown>(
      'GET',
      `/api/cp/datalakes/${encodeURIComponent(args.endpoint_id)}/replicas`,
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_gateway_replica (Step 3) ─────────────────────────────

server.registerTool(
  'waddling_admin_gateway_replica',
  {
    description:
      'Per-replica gateway lifecycle op. wake = force-boot + arm replica n with the current snapshot (creates the slot if missing). sleep = stop the container but keep the slot (next access cold-boots + re-arms). destroy = destroy the container AND remove the slot (scale down; use to force a replica onto a new image — the re-spawn boots fresh). rearm = force re-apply the DIRECTOR\'s cached snapshot to replica n (does NOT re-fetch from the control plane). These bypass the load-based autoscaler — explicit admin actions.',
    inputSchema: {
      endpoint_id: z.string().describe('Datalake/endpoint ID'),
      replica: z.number().int().min(0).describe('Replica index (0-based, from waddling_admin_list_replicas)'),
      op: z
        .enum(['wake', 'sleep', 'destroy', 'rearm'])
        .describe('Lifecycle operation to perform on this replica'),
    },
  },
  async (args) => {
    const result = await cpFetch<unknown>(
      'POST',
      `/api/cp/datalakes/${encodeURIComponent(args.endpoint_id)}/replicas/${args.replica}/${args.op}`,
      {},
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_reset_pool (Step 4) ──────────────────────────────────

server.registerTool(
  'waddling_admin_reset_pool',
  {
    description:
      'Pool-director reset. reset = drop the cached snapshot + zero the version → the gateway FAIL-CLOSES (refuses queries) until the next push; use when the cached snapshot itself is suspect (a bad compile got pushed) to force a clean re-push from the control plane. clear = keep the cached snapshot but mark every replica stale → the next pick re-applies the SAME snapshot; lighter, use when the policy is fine but you distrust that replicas have it loaded. Both leave warm containers running (no compute teardown — use gateway_replica destroy for that).',
    inputSchema: {
      endpoint_id: z.string().describe('Datalake/endpoint ID'),
      op: z
        .enum(['reset', 'clear'])
        .describe('reset = fail-closed until next push; clear = re-apply same snapshot on next pick'),
    },
  },
  async (args) => {
    const path = args.op === 'reset' ? 'reset-pool' : 'clear-snapshot';
    const result = await cpFetch<unknown>(
      'POST',
      `/api/cp/datalakes/${encodeURIComponent(args.endpoint_id)}/${path}`,
      {},
    );
    return toToolResult(result);
  },
);

// ── Tool: waddling_admin_reapply_snapshot (Step 5) ────────────────────────────

server.registerTool(
  'waddling_admin_reapply_snapshot',
  {
    description:
      'Birdshot-only reset+recommit: ask replica n\'s CONTAINER to re-run its own last-cached birdshot snapshot (reset → set → commit) with NO control-plane round trip. Recovers a hot replica whose in-memory birdshot policy got corrupted while the container stayed up. Distinct from gateway_replica rearm (re-pushes the DIRECTOR\'s snapshot) and refresh_policy (recompiles from acl_rule). Use this when you trust the last push was correct and only the in-memory state is suspect. Returns 409 (no_cached_snapshot) if the container has never received a snapshot — push one first. force=false skips the re-apply when birdshot already reports a loaded policy.',
    inputSchema: {
      endpoint_id: z.string().describe('Datalake/endpoint ID'),
      replica: z.number().int().min(0).describe('Replica index (0-based)'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Re-apply even if birdshot_status reports a loaded policy (default true). Set false to skip when already loaded.',
        ),
    },
  },
  async (args) => {
    const forceParam = args.force === false ? '?force=false' : '';
    const result = await cpFetch<unknown>(
      'POST',
      `/api/cp/datalakes/${encodeURIComponent(args.endpoint_id)}/replicas/${args.replica}/reapply${forceParam}`,
      {},
    );
    return toToolResult(result);
  },
);

// ── Transport selection and startup ──────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useHttp = args.includes('--http');

  // Flush telemetry before exit.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void telemetry.shutdown().finally(() => process.exit(0));
    });
  }

  if (!WADDLING_ADMIN_TOKEN) {
    process.stderr.write(
      '[waddling-admin] WARNING: WADDLING_ADMIN_TOKEN is not set. All requests will be unauthenticated and will likely fail.\n',
    );
  }

  if (useHttp) {
    // Streamable HTTP mode — stateless; a fresh transport per request
    const portFlag = args.indexOf('--port');
    const port = portFlag !== -1 && args[portFlag + 1] ? parseInt(args[portFlag + 1]!, 10) : 8820;

    const httpServer = createServer(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      res.on('close', () => {
        transport.close().catch(() => undefined);
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error', detail: String(err) }));
        }
      }
    });

    httpServer.listen(port, () => {
      process.stderr.write(`[waddling-admin] HTTP transport listening on port ${port}\n`);
    });
  } else {
    // Stdio mode (default) — used by Claude Desktop / npx
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[waddling-admin] stdio transport connected\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[waddling-admin] Fatal: ${String(err)}\n`);
  process.exit(1);
});
