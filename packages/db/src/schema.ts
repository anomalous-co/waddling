import { getStack } from "./stack.ts";

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface SchemaTable {
  /** "local" = this instance's tables, "peer" = reachable over quack. */
  scope: "local" | "peer";
  /** Fully-qualified name to insert, e.g. "main.todos" or "peer_db.main.todos". */
  qualifiedName: string;
  table: string;
  columns: SchemaColumn[];
}

type ColumnRow = Record<string, unknown>;

function collect(
  rows: ColumnRow[],
  scope: "local" | "peer",
  prefix: string,
  out: SchemaTable[],
): void {
  const byTable = new Map<string, SchemaColumn[]>();
  for (const row of rows) {
    const table = String(row.table_name);
    let cols = byTable.get(table);
    if (!cols) {
      cols = [];
      byTable.set(table, cols);
    }
    cols.push({ name: String(row.column_name), type: String(row.data_type) });
  }
  for (const [table, columns] of byTable) {
    out.push({ scope, qualifiedName: `${prefix}.${table}`, table, columns });
  }
}

/**
 * Introspect the tables/columns available to the SQL editor: this instance's
 * own DuckDB `main` schema, plus the PEER's exposed tables reached over quack.
 * Used to drive schema-aware autocomplete. Best-effort for the peer — if it's
 * offline we just return the local tables.
 */
export async function getSchema(): Promise<SchemaTable[]> {
  const stack = await getStack();
  const tables: SchemaTable[] = [];

  // Local: the views this instance exposes in DuckDB's in-memory `main` schema.
  const local = await stack.duck.runAndReadAll(
    `SELECT table_name, column_name, data_type
     FROM duckdb_columns()
     WHERE database_name = 'memory' AND schema_name = 'main'
     ORDER BY table_name, column_index`,
  );
  collect(local.getRowObjects(), "local", "main", tables);

  // Peer: introspect the remote catalog through the quack attachment. The peer's
  // private notebooks/views aren't attached on its side, so they never appear here.
  if (await stack.ensurePeer()) {
    try {
      const peer = await stack.duck.runAndReadAll(
        `SELECT table_name, column_name, data_type
         FROM peer_db.information_schema.columns
         WHERE table_schema = 'main'
         ORDER BY table_name, ordinal_position`,
      );
      collect(peer.getRowObjects(), "peer", "peer_db.main", tables);
    } catch {
      stack.resetPeer();
    }
  }

  return tables;
}
