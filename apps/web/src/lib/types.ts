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
