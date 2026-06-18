/**
 * Control-plane Postgres pool (ported from apps/waddling/src/lib/db.ts).
 *
 * Single shared `pg.Pool` for the waddling + auth schemas. Better Auth uses its
 * own Pool (see auth.ts) against the same database; this pool is for our custom
 * `waddling.*` tables and for reading the Better-Auth-owned `jwks`/`subscription`
 * rows directly.
 *
 * Workers difference vs the original: on workerd there is NO `process.env` and no
 * module-load-time env, so the pool cannot read a connection string at import.
 * Instead the connection string arrives per-request from the Hyperdrive binding
 * (`env.HYPERDRIVE.connectionString`). A Hono middleware calls `initDbPool(...)`
 * once before any handler; `query`/`queryOne`/`withTransaction` then read the
 * already-initialized module-level pool. Their signatures are unchanged from the
 * original so existing importers port over verbatim.
 *
 * `max:5` (vs the original's 10): Hyperdrive sits between the Worker and Postgres
 * and pools server-side, and Better Auth opens a second Pool of its own against
 * the same binding — keeping each isolate's two pools at 5 leaves headroom.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

let _pool: Pool | undefined;

/**
 * Idempotent per-isolate pool initializer. The first call wins; subsequent calls
 * (every request after the isolate warms) are no-ops. The connection string comes
 * from the Hyperdrive binding — there is no ambient env to fall back on here.
 */
export function initDbPool(connectionString: string): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString, max: 5 });
  }
  return _pool;
}

function getPool(): Pool {
  if (!_pool) {
    throw new Error(
      'db pool not initialized — initDbPool(env.HYPERDRIVE.connectionString) must run before queries',
    );
  }
  return _pool;
}

/** Typed query helper. Use parameterized `$1,$2,…` — never string-concat SQL. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/** First row or null. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const r = await query<T>(text, params);
  return r.rows[0] ?? null;
}

/** Run a function inside a transaction (BEGIN/COMMIT/ROLLBACK). */
export async function withTransaction<T>(
  fn: (q: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<QueryResult<R>>) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params = []) =>
      client.query(text, params as unknown[]),
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
