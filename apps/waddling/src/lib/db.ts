/**
 * Control-plane Postgres pool (W1).
 *
 * Single shared `pg.Pool` for the waddling + auth schemas. Better Auth uses its
 * own Pool (see auth.ts) against the same database; this pool is for our custom
 * `waddling.*` tables and for reading the Better-Auth-owned `jwks`/`subscription`
 * rows directly (signing session JWTs, plan lookups).
 *
 * Lazily constructed so module import never opens a socket at build time.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { getDatabaseUrl } from './env';

let _pool: Pool | undefined;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: getDatabaseUrl(), max: 10 });
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
