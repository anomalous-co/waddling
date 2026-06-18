/**
 * Control-plane Postgres access (ported from apps/waddling/src/lib/db.ts).
 *
 * PER-REQUEST pool, NOT a module-cached one. Hyperdrive already pools/multiplexes
 * connections server-side, so the Worker's job is just to open a cheap connection for the
 * request and close it — caching a pg.Pool across requests both defeats Hyperdrive and is
 * unsafe on workerd: a connection opened in request A's I/O context hangs when reused by
 * request B, and the runtime cancels the hung request as an opaque 1101. (This was the
 * intermittent ~40% failure on every /api/cp/* route.)
 *
 * The connection string arrives per-request from the Hyperdrive binding. A Hono middleware
 * wraps each request in runInDbScope; query/queryOne/withTransaction read the request's own
 * pool from AsyncLocalStorage, so their signatures are unchanged for existing importers.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

interface DbSlot {
  connectionString: string;
  pool?: Pool;
}
const dbScope = new AsyncLocalStorage<DbSlot>();

/**
 * Run `next` inside a per-request DB scope. The pool is created lazily (only if the request
 * actually runs a query) and closed after the response via waitUntil. Wrap every request.
 */
export async function runInDbScope(
  executionCtx: { waitUntil(p: Promise<unknown>): void } | undefined,
  connectionString: string,
  next: () => Promise<void>,
): Promise<void> {
  const slot: DbSlot = { connectionString };
  await dbScope.run(slot, next);
  if (slot.pool) {
    const closing = slot.pool.end().catch(() => {});
    if (executionCtx) executionCtx.waitUntil(closing);
    else await closing;
  }
}

function getPool(): Pool {
  const slot = dbScope.getStore();
  if (!slot) {
    throw new Error(
      'db scope not active — runInDbScope(env.HYPERDRIVE.connectionString) must wrap the request',
    );
  }
  if (!slot.pool) {
    // Fresh per-request pool. Hyperdrive multiplexes server-side, so a small client cap is
    // plenty; the connection opens lazily on first query and closes after the request.
    slot.pool = new Pool({ connectionString: slot.connectionString, max: 5 });
  }
  return slot.pool;
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
