// Client-safe mirrors of the shapes returned by the API routes. Defined here
// (rather than imported from @pglite-sandbox/db) so client bundles never pull
// in the Node-only pglite/duckdb packages.

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

export interface TodoStats {
  total: number;
  done_count: number;
}

export interface AnalyticsResult {
  peer_connected: boolean;
  local: TodoStats;
  peer: TodoStats | null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface InstanceInfo {
  instance: string;
  port: string;
  quackPort: string;
  peerQuackPort: string;
}

export interface NotebookCell {
  id: string;
  title?: string;
  sql: string;
}

export interface Notebook {
  id: string;
  name: string;
  cells: NotebookCell[];
  created_at: string;
  updated_at: string;
}

export interface NotebookSummary {
  id: string;
  name: string;
  updated_at: string;
}

export interface SavedView {
  id: string;
  name: string;
  sql: string;
  created_at: string;
}

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface SchemaTable {
  scope: "local" | "peer";
  qualifiedName: string;
  table: string;
  columns: SchemaColumn[];
}

export interface DialectFunction {
  name: string;
  type: string;
  returnType?: string;
  signature: string;
  description?: string;
}

export interface DialectKeyword {
  name: string;
  category: string;
}

export interface Dialect {
  keywords: DialectKeyword[];
  functions: DialectFunction[];
}

// ── Per-agent grants / ACL ───────────────────────────────────────────────
// The control plane authors access as literal GRANT/DENY SQL. Two surfaces:
//  - GET /api/cp/agents/:id/grants → the key's verbatim statements (display).
//  - GET/POST/DELETE /api/cp/acl   → the editable, id-bearing rule set.

/** Verbatim statements the agent key resolves to (incl. role-inherited). */
export interface AgentGrants {
  statements: string[];
}

export type AclPrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "CREATE"
  | "DROP"
  | "ALTER"
  | "USAGE"
  | "EXECUTE";

export type AclEffect = "allow" | "deny";

/** One editable ACL rule. `id` is required for DELETE; `statement` (if the
 * backend renders it) is preferred verbatim, else the row is synthesized. */
export interface AclRule {
  id: string;
  datalakeId?: string;
  agentId?: string;
  privilege: AclPrivilege;
  columns?: string[] | null;
  schema: string;
  table: string;
  effect: AclEffect;
  statement?: string;
}

/** POST /api/cp/acl body. `table: "*"` = all tables in the schema. */
export interface CreateAclInput {
  datalakeId: string;
  agentId: string;
  privilege: AclPrivilege;
  columns?: string[];
  schema: string;
  table: string;
  effect: AclEffect;
}
