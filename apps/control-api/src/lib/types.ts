/**
 * Shared control-plane contracts.
 *
 * The original (apps/waddling/src/lib/types.ts) was a thin re-export of the
 * `@waddling/control-schema` workspace package. This standalone Workers app does
 * not have that package in node_modules and the tsconfig defines no path alias,
 * so re-export is impossible — the full type body is inlined here verbatim from
 * `packages/control-schema/src/types.ts`. Keep the two in sync until the bulk
 * port settles which is authoritative.
 */

// ── Session / Connect ──────────────────────────────────────────────────────────
export interface SessionGrant {
  tables: {
    schema: string;
    table: string;
    verbs: ('read' | 'write')[];
    columns?: string[];
    rowLimit?: number;
  }[];
}

// A workspace HANDLE — what connect returns in the Cloudflare data-plane model. The
// agent does NOT attach the lake itself anymore: its durable workspace DuckDB (a
// WorkspaceSandbox container DO) ATTACHes quack→gateway→birdshot and runs the agent's
// SQL. So connect returns NO attachSql / sessionJwt / endpoint — the session JWT and
// workspace key live ONLY in the data plane (the DO holds them). The agent queries via
// waddling_query (→ control-api /:id/query → data plane /query {workspaceId,agentId}).
export interface ConnectResult {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  ttlSeconds: number;
  granted: SessionGrant;
}

// ── Saved views (queries pinned from a notebook cell) ──────────────────────────
export interface SavedView {
  id: string;
  name: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
}

// ── ACL ────────────────────────────────────────────────────────────────────────
export interface AclRuleInput {
  datalakeId: string;
  agentId?: string;
  schema: string;
  table: string;
  columns?: string[];
  verb: 'read' | 'write';
  effect?: 'allow' | 'deny';
  rowLimit?: number;
  ttlSeconds?: number;
  window?: { start: string; end: string };
  notBefore?: string;
  expiresAt?: string;
}

// ── Audit ──────────────────────────────────────────────────────────────────────
export interface AuditQuery {
  orgId?: string;
  agentId?: string;
  since?: string;
  decision?: 'allow' | 'deny';
  limit?: number;
}

// ── Plans ──────────────────────────────────────────────────────────────────────
export interface Plan {
  name: 'free' | 'pro' | 'enterprise';
  priceId: string;
  entitlements: {
    endpoints: number;
    agents: number;
    dynamicAcl: boolean;
    adminMcp: boolean;
    auditRetentionDays: number;
  };
}

// ── Birdshot policy compiler output ───────────────────────────────────────────
export interface BirdshotSnapshot {
  roleGrants: { role: string; tableRef: string; action: 'read' | 'write' }[];
  userRoles: { userId: string; role: string }[];
  // Column allow-lists + UTC time-of-day windows, pushed into birdshot via
  // birdshot_add_grant_constraint (Phase 2). Parallel to roleGrants (NOT folded
  // onto them). Carries ONLY columns + window — NOT rowLimit (row caps dropped),
  // NOT notBefore/expiresAt (those stay compile-time + JWT exp). Omit/empty = no
  // constraint for that grant. `tableRef` is 'schema.table'; birdshot lowercases.
  roleConstraints?: {
    role: string;
    tableRef: string;
    columns?: string[];
    window?: { start: string; end: string };
  }[];
}

// ── MCP tool result types (§4a — External MCP) ────────────────────────────────

export interface DatalakeSummary {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  schemas?: string[];
}

// ── Endpoint create (bring-your-own storage; managed catalog) ──────────────────
// The customer's object-store (S3/R2/MinIO) for the lake's data files. `provider`
// 'config' uses the static keyId/secret; 'credential_chain' uses the gateway's
// ambient instance role (no creds stored). Credentials are encrypted at rest
// (migration 005); never round-tripped back to the browser.
export interface DatalakeStorageInput {
  /** DATA_PATH: 's3://bucket/prefix/' (object store) or a local dir (demo). */
  dataPath: string;
  provider: 'config' | 'credential_chain';
  keyId?: string;
  secret?: string;
  sessionToken?: string;
  region?: string;
  /** S3-compatible endpoint host (R2/MinIO). Omit for AWS S3. */
  endpoint?: string;
  urlStyle?: 'path' | 'vhost';
  useSsl?: boolean;
}

export interface CreateDatalakeInput {
  name: string;
  slug: string;
  region?: string;
  encrypted?: boolean;
  /** Fully managed: waddling provisions an isolated Postgres catalog + an encrypted
   *  object-store bucket. When true, `storage`/`catalogDsn` are not required. */
  managed?: boolean;
  /** Bring-your-own object storage for the lake's data files (omit when managed). */
  storage?: DatalakeStorageInput;
  /** Bring-your-own postgres catalog DSN. Omit ⇒ waddling provisions the catalog. */
  catalogDsn?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TableInfo {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  rowEstimate?: number;
}

export interface DescribeResult {
  datalakeId: string;
  tables: TableInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  snapshotVersion?: string;
}

export interface AuthorizationDenial {
  error: 'authorization_denied';
  table?: string;
  reason: string;
}

export interface ExplainResult {
  allowed: boolean;
  decision: 'allow' | 'deny';
  reason?: string;
  rowEstimate?: number;
  tableGrants?: { schema: string; table: string; verbs: ('read' | 'write')[] }[];
}

export interface WhoamiResult {
  agentId: string;
  orgId: string;
  name: string;
  grants: SessionGrant;
  remainingTtlSeconds?: number;
  rateLimitHeadroom?: number;
}

export interface TimeTravelResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  version?: string;
  timestamp?: string;
}

export interface InstallExtensionResult {
  sql: string;
  note: string;
}

// ── Agent identity (AAP — Agent Auth Protocol) ─────────────────────────────────
// 'autonomous' = agent holds its own API key (one-key-per-agent path; the strong
// cardinality signal for tracing). 'delegated' = acts on behalf of a human resolved
// via the OAuth/AAP flow. See waddling-context/agent-auth.md.
export type AgentMode = 'delegated' | 'autonomous';

/** Resolved AAP identity for a single agent (control-plane internal). */
export interface AgentIdentity {
  id: string;
  name: string;
  mode: AgentMode;
  status: 'active' | 'suspended' | 'revoked';
  /** Delegating human (auth.user.id): the API-key owner for autonomous agents. */
  onBehalfOf?: string;
}

// ── MCP tool result types (§4b — Internal MCP) ────────────────────────────────

export interface AgentSummary {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  defaultRole: string;
  mode: AgentMode;
  status: 'active' | 'suspended' | 'revoked';
  lastSeenAt?: string;
  apiKeyId?: string;
  /** Display name/email of the user who owns the agent's API key (if any). */
  owner?: string;
}

export interface SessionSummary {
  id: string;
  orgId: string;
  agentId: string;
  datalakeId: string;
  sid: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
  grantedRoles: string[];
  startedAt: string;
  expiresAt: string;
}

export interface GrantResult {
  ruleId: string;
  compiledGrants: BirdshotSnapshot;
}

export interface RevokeResult {
  success: boolean;
  affectedSessions: number;
}

export interface AuditEventRow {
  id: number;
  orgId: string;
  ts: string;
  source: string;
  event: string;
  agentId?: string;
  sessionId?: string;
  datalakeId?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
  query?: string;
  actor?: string;
}

export interface UsageRollup {
  orgId: string;
  agentId?: string;
  period: string;
  queries: number;
  rowsScanned: number;
  bytesScanned: number;
  activeSessions: number;
  estimatedCost?: number;
}

// The gateway is a dynamic, scale-to-zero POOL of replica containers (apps/dataplane
// GatewayPoolDO). A datalake's gateway only surfaces as RUNTIME STATE, derived live
// without waking a sleeping pool.
export type GatewayRuntimeState =
  | 'running'
  | 'asleep'
  | 'provisioning'
  | 'error'
  | 'unconfigured';

export interface DatalakeRuntime {
  state: GatewayRuntimeState;
  replicas: number;
}

/** The object GET /api/cp/datalakes/:id returns as `datalake`. */
export interface DatalakeDetail {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  dataPath: string;
  region: string;
  runtime?: DatalakeRuntime;
}

export interface DatalakeStatus {
  datalakeId: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  runtime?: DatalakeRuntime;
}

export interface ProvisionResult {
  datalakeId: string;
  status: 'provisioning' | 'running';
}

// ── Device-code onboarding (FUNNEL / Stream B — migrations-002-device-link) ────
// Agent-driven flow: the External MCP server (ONBOARDING mode) starts a link,
// shows the human a code + URL, then polls until a signed-in human claims it.

/** Response of POST /api/cp/device-link — what the agent shows the human. */
export interface DeviceLinkInit {
  /** 8-char human-friendly claim code, e.g. 'K7P2-9QXM'. */
  code: string;
  /** Absolute URL the human opens to claim (prefilled with the code). */
  verifyUrl: string;
  /** Opaque token the agent presents to GET /api/cp/device-link/poll. */
  pollToken: string;
  /** ISO timestamp; link is dead after this (15m). */
  expiresAt: string;
}

/**
 * Response of GET /api/cp/device-link/poll?token=…
 * `apiKey` is present EXACTLY ONCE, on the first poll after a claim, then NULLed
 * server-side. Subsequent polls return { status:'claimed' } with no key.
 */
export interface DeviceLinkPoll {
  status: 'pending' | 'claimed' | 'expired';
  /** sk_agent_… — delivered once on first claimed poll, then never again. */
  apiKey?: string;
  /** Present once alongside apiKey so the agent can persist context. */
  orgId?: string;
  agentId?: string;
}

/** Body of POST /api/cp/device-link/claim (session-authenticated). */
export interface DeviceLinkClaimInput {
  code: string;
  orgId?: string;
  agentName?: string;
}

/** Response of POST /api/cp/device-link/claim. */
export interface DeviceLinkClaimResult {
  status: 'claimed';
  agentId: string;
  agentName: string;
  orgId: string;
}
