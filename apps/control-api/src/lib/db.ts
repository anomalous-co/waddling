/**
 * Control-plane Postgres access — module-level singleton pool.
 *
 * On Node/Cloud Run: call initPool(connectionString) at startup before serving.
 * On CF workerd: the `*` middleware calls initPool(env.HYPERDRIVE.connectionString)
 * on the first request; subsequent requests reuse the same pool (idempotent).
 *
 * runInDbScope is kept for backward compat (scheduled handler still calls it) but
 * is now a thin passthrough: it bootstraps the pool via initPool and calls next()
 * directly rather than creating a per-request pool. The pool lives for the process
 * lifetime — no per-request teardown needed.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

let _pool: Pool | undefined;

/** Initialize the module-level pool. Idempotent — first call wins. */
export function initPool(connectionString: string): void {
  if (!_pool && connectionString) {
    _pool = new Pool({ connectionString, max: 10 });
  }
}

function getPool(): Pool {
  if (!_pool) {
    throw new Error(
      'DB pool not initialized — call initPool(connectionString) before queries',
    );
  }
  return _pool;
}

/** Passthrough for backward compat. Boots the pool if not yet initialized. */
export async function runInDbScope(
  _executionCtx: unknown,
  connectionString: string,
  next: () => Promise<void>,
): Promise<void> {
  initPool(connectionString);
  await next();
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const r = await query<T>(text, params);
  return r.rows[0] ?? null;
}

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
