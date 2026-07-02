import { FIXTURE_LAKE_DETAILS } from '@/lab/fixtures/datalake-catalog';
import type { CatalogColumn, CatalogSchema } from '@/lab/fixtures/datalake-catalog';

/**
 * Typed result shapes for the mock query endpoint.
 * Both are returned as HTTP 200; the client discriminates on `'error' in data`.
 */
export interface QuerySuccess {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  elapsedMs: number;
}

export interface QueryDenial {
  error: 'access denied';
  table: string;
  reason: string;
}

// Tables matching these patterns demo birdshot denial (even if they appeared in catalog).
const DENY_PATTERNS = [/_pii$/, /^secrets$/, /^payments$/];

function isDenied(tableName: string): boolean {
  return DENY_PATTERNS.some((p) => p.test(tableName));
}

// Find the first table reference in SQL: FROM schema.table or FROM table.
function parseTableRef(sql: string): { schema: string | null; table: string } | null {
  const qualified = sql.match(/\bFROM\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/i);
  if (qualified) return { schema: qualified[1], table: qualified[2] };
  const bare = sql.match(/\bFROM\s+([a-z_][a-z0-9_]*)/i);
  if (bare) return { schema: null, table: bare[1] };
  return null;
}

function findCatalogTable(
  catalog: CatalogSchema[],
  schema: string | null,
  table: string,
): { schema: string; columns?: CatalogColumn[]; columnCount: number } | null {
  for (const s of catalog) {
    if (schema !== null && s.schema !== schema) continue;
    const t = s.tables.find((tbl) => tbl.table === table);
    if (t) return { schema: s.schema, columns: t.columns, columnCount: t.columnCount };
  }
  return null;
}

// Generate a deterministic cell value from column type + row/col index.
// No Math.random() — seeded purely from (r, c, col.name, col.type).
function fakeCell(col: CatalogColumn, r: number, c: number): string | number | null {
  const type = col.type.toUpperCase();

  if (type === 'UUID') {
    const n = String(r * 13 + c + 1).padStart(12, '0');
    return `00000000-0000-4000-a${c.toString(16).padStart(3, '0')}-${n}`;
  }
  if (type.startsWith('TIMESTAMP')) {
    const month = String((r % 12) + 1).padStart(2, '0');
    const day = String(((r * 3 + c) % 28) + 1).padStart(2, '0');
    const hour = String((r * 7 + c * 3) % 24).padStart(2, '0');
    const min = String((c * 5) % 60).padStart(2, '0');
    return `2025-${month}-${day}T${hour}:${min}:00Z`;
  }
  if (type === 'BOOLEAN') {
    // Render as string to match (string | number | null)[][] contract.
    return (r + c) % 2 === 0 ? 'true' : 'false';
  }
  if (type === 'INTEGER' || type === 'BIGINT') {
    return (r + 1) * 100 + c + 1;
  }
  if (
    type.startsWith('DECIMAL') ||
    type.startsWith('NUMERIC') ||
    type === 'DOUBLE' ||
    type === 'FLOAT'
  ) {
    return Number(((r + 1) * 9.99 + c * 0.01).toFixed(4));
  }
  if (type === 'JSON') {
    return `{"idx":${r},"col":"${col.name}"}`;
  }

  // VARCHAR / TEXT: use a named value list per column, or fall back to colname-N.
  const LISTS: Record<string, string[]> = {
    event_type: ['page_view', 'click', 'scroll', 'form_submit', 'conversion', 'session_start', 'purchase', 'add_to_cart'],
    device: ['desktop', 'mobile', 'tablet'],
    browser: ['Chrome', 'Firefox', 'Safari', 'Edge'],
    os: ['macOS', 'Windows', 'Linux', 'iOS', 'Android'],
    country: ['US', 'GB', 'DE', 'FR', 'JP', 'CA', 'AU', 'BR'],
    page: ['/home', '/pricing', '/docs', '/signup', '/dashboard', '/agents', '/data', '/settings'],
    channel: ['organic', 'paid', 'email', 'referral', 'direct'],
    currency: ['USD', 'EUR', 'GBP'],
    asset_type: ['banner', 'video', 'sponsored', 'native'],
    element_type: ['button', 'link', 'image', 'input'],
  };
  const list = LISTS[col.name];
  if (list) return list[r % list.length];
  return `${col.name}-${r + 1}`;
}

/**
 * POST /api/cp/datalakes/:id/query
 * Mock query handler. Returns QuerySuccess with deterministic fake rows, or
 * QueryDenial (HTTP 200) when the referenced table is not in the lake's catalog
 * or matches a policy-denied name pattern (birdshot demo).
 * Guards against serving when the real control-api is configured.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) return new Response(null, { status: 404 });

  const { id } = await params;
  const lake = FIXTURE_LAKE_DETAILS[id];
  if (!lake) {
    return Response.json({ error: `Lake '${id}' not found` }, { status: 404 });
  }

  const body = (await request.json()) as { sql?: unknown };
  const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
  if (!sql) {
    return Response.json({ error: 'Missing sql' }, { status: 400 });
  }

  const ref = parseTableRef(sql);
  if (!ref) {
    return Response.json({ error: 'Could not parse a table reference from SQL' }, { status: 400 });
  }

  const refLabel = ref.schema ? `${ref.schema}.${ref.table}` : ref.table;

  // Birdshot denial: policy-blocked table name pattern.
  if (isDenied(ref.table)) {
    const denial: QueryDenial = {
      error: 'access denied',
      table: refLabel,
      reason: `no birdshot grant for '${refLabel}' on this agent/endpoint`,
    };
    return Response.json(denial);
  }

  // Birdshot denial: table not found in catalog → deny by default (no grant exists).
  const found = findCatalogTable(lake.catalog, ref.schema, ref.table);
  if (!found) {
    const denial: QueryDenial = {
      error: 'access denied',
      table: refLabel,
      reason: `table '${refLabel}' not found in this lake's catalog — birdshot denies by default`,
    };
    return Response.json(denial);
  }

  // Success path: build deterministic rows from catalog columns (cap at 6).
  const cols = (found.columns ?? []).slice(0, 6);
  const columns = cols.map((c) => c.name);
  const ROW_COUNT = 10;
  const rows: (string | number | null)[][] = Array.from({ length: ROW_COUNT }, (_, r) =>
    cols.map((col, c) => fakeCell(col, r, c)),
  );

  const result: QuerySuccess = {
    columns,
    rows,
    rowCount: ROW_COUNT,
    elapsedMs: 47 + found.columnCount * 3,
  };
  return Response.json(result);
}
