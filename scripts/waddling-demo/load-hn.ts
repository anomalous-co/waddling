/**
 * load-hn.ts — Dump the last 24h of top Hacker News stories into the demo lake.
 *
 * Fetches the HN front-page ranking (Firebase API), keeps stories posted in the
 * last 24h, and writes them to lake.hn.top_stories in the DuckLake.
 *
 * Catalog (one of):
 *   DUCKLAKE_CATALOG_DSN   Postgres catalog (libpq DSN) — supports LIVE writes
 *                          while the gateway is running (no downtime).
 *   DUCKLAKE_CATALOG_FILE  local DuckDB-file catalog — single-writer, so the
 *                          gateway must be stopped first.
 *
 * Run (from repo root):
 *   DUCKLAKE_CATALOG_DSN='dbname=ducklake host=127.0.0.1 port=5432 user=waddling password=waddling' \
 *   DUCKLAKE_DATA_PATH=.../files/  npx tsx scripts/waddling-demo/load-hn.ts
 */
import { DuckDBInstance } from '@duckdb/node-api';

const CATALOG_FILE = process.env.DUCKLAKE_CATALOG_FILE;
const CATALOG_DSN = process.env.DUCKLAKE_CATALOG_DSN;
const DATA_PATH = process.env.DUCKLAKE_DATA_PATH;
const TOP_N = Number(process.env.HN_TOP_N ?? '200'); // how many ranked ids to scan
const WINDOW_SECONDS = 24 * 60 * 60;

if ((!CATALOG_FILE && !CATALOG_DSN) || !DATA_PATH) {
  console.error('[hn] set DUCKLAKE_CATALOG_DSN (or DUCKLAKE_CATALOG_FILE) and DUCKLAKE_DATA_PATH');
  process.exit(1);
}
const CATALOG_TARGET = CATALOG_DSN ? `ducklake:postgres:${CATALOG_DSN}` : `ducklake:${CATALOG_FILE}`;

const API = 'https://hacker-news.firebaseio.com/v0';

interface HnItem {
  id: number;
  type?: string;
  title?: string;
  by?: string;
  score?: number;
  descendants?: number;
  url?: string;
  time?: number; // unix seconds
}

/** Fetch JSON with a small retry. */
async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as T;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  return null;
}

/** Map items in pools of `size` to bound concurrency against the HN API. */
async function pooledMap<I, O>(items: I[], size: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

function q(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

async function main(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - WINDOW_SECONDS;

  console.log(`[hn] fetching top ${TOP_N} ranked story ids…`);
  const ids = (await getJson<number[]>(`${API}/topstories.json`)) ?? [];
  const scan = ids.slice(0, TOP_N);
  console.log(`[hn] fetched ${ids.length} ids; scanning first ${scan.length}`);

  const items = await pooledMap(scan, 20, (id) => getJson<HnItem>(`${API}/item/${id}.json`));
  const stories = items
    .filter((it): it is HnItem => !!it && it.type === 'story' && typeof it.time === 'number')
    .filter((it) => it.time! >= cutoff)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  console.log(`[hn] ${stories.length} stories posted in the last 24h`);
  if (stories.length === 0) {
    console.log('[hn] nothing to load; exiting.');
    return;
  }

  const duck = await DuckDBInstance.create(':memory:');
  const conn = await duck.connect();
  try {
    await conn.run('INSTALL ducklake');
    await conn.run('LOAD ducklake');
    if (CATALOG_DSN) await conn.run('INSTALL postgres');
    await conn.run(
      `ATTACH '${CATALOG_TARGET}' AS lake (DATA_PATH '${DATA_PATH}', CREATE_IF_NOT_EXISTS true)`,
    );
    await conn.run('CREATE SCHEMA IF NOT EXISTS lake.hn');
    await conn.run(`
      CREATE TABLE IF NOT EXISTS lake.hn.top_stories (
        id          BIGINT NOT NULL,
        title       VARCHAR,
        author      VARCHAR,
        score       INTEGER,
        comments    INTEGER,
        url         VARCHAR,
        posted_at   TIMESTAMPTZ,
        fetched_at  TIMESTAMPTZ
      )
    `);
    // Full refresh: this table holds "the last 24h top stories" as of now.
    await conn.run('DELETE FROM lake.hn.top_stories');

    const values = stories
      .map((s) => {
        const title = s.title ? q(s.title) : 'NULL';
        const author = s.by ? q(s.by) : 'NULL';
        const url = s.url ? q(s.url) : 'NULL';
        const score = Number.isFinite(s.score) ? s.score : 0;
        const comments = Number.isFinite(s.descendants) ? s.descendants : 0;
        return `(${s.id}, ${title}, ${author}, ${score}, ${comments}, ${url}, to_timestamp(${s.time}), now())`;
      })
      .join(',\n');
    await conn.run(
      `INSERT INTO lake.hn.top_stories (id, title, author, score, comments, url, posted_at, fetched_at)
       VALUES ${values}`,
    );

    const reader = await conn.runAndReadAll(
      `SELECT count(*) AS n, max(score) AS top_score FROM lake.hn.top_stories`,
    );
    const row = reader.getRowObjects()[0];
    console.log(`[hn] loaded ${row?.n} rows into lake.hn.top_stories (top score ${row?.top_score})`);
  } finally {
    conn.closeSync();
  }
}

main().catch((err) => {
  console.error('[hn] fatal:', err);
  process.exit(1);
});
