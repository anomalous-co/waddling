import { getStack } from "./stack.ts";

/**
 * Normalize a DuckDB row tree to JSON-safe, human-readable values:
 * - BigInt (e.g. COUNT(*)) -> Number
 * - DuckDB value classes (TIMESTAMP/DATE/DECIMAL/…) override toString() with a
 *   readable form — use it instead of leaking their internal `{micros}` shape
 * - plain objects/arrays (e.g. JSON columns) recurse
 */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) {
      // a DuckDB value wrapper, not a plain object — render via its toString()
      return String(value);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
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

const STATS_SQL = (rel: string) =>
  `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE done) AS done_count FROM ${rel}`;

/** Preset cross-instance aggregate: local PGlite vs. the peer's PGlite over quack. */
export async function getAnalytics(): Promise<AnalyticsResult> {
  const stack = await getStack();
  const hasPeer = await stack.ensurePeer();

  const localReader = await stack.duck.runAndReadAll(STATS_SQL("main.todos"));
  const local = normalize(localReader.getRowObjects()[0]) as TodoStats;

  const out: AnalyticsResult = { peer_connected: hasPeer, local, peer: null };

  if (hasPeer) {
    try {
      const peerReader = await stack.duck.runAndReadAll(STATS_SQL("peer_db.main.todos"));
      out.peer = normalize(peerReader.getRowObjects()[0]) as TodoStats;
    } catch {
      // peer dropped mid-query — reset so the next call re-ATTACHes
      stack.resetPeer();
      out.peer_connected = false;
    }
  }

  return out;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * Run an ad-hoc analytics query against DuckDB. Both `main.todos` (local) and
 * `peer_db.main.todos` (peer, over quack) are queryable. Read-only is enforced
 * structurally (local_db is ATTACHed READ_ONLY) and we additionally reject any
 * statement that isn't a single SELECT / WITH.
 */
export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT / WITH queries are allowed");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed");
  }

  const stack = await getStack();
  await stack.ensurePeer(); // best-effort, so peer_db.* is reachable if up

  const reader = await stack.duck.runAndReadAll(trimmed);
  const rows = (normalize(reader.getRowObjects()) as Record<string, unknown>[]) ?? [];
  const columns = reader.columnNames();
  return { columns, rows };
}
