// Apply migration 018 (usage_event idempotency_key + partial-unique index) to the
// target DB. Idempotent — safe to re-run. Run with the control DB connection string:
//   DATABASE_URL=postgres://… node scripts/_migrate_018_usage_idempotency.mjs
// Delete after use (mirrors scripts/_migrate_017_credit_buckets.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = join(HERE, '..', 'packages', 'control-schema', 'migrations-018-usage-idempotency.sql');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(readFileSync(SQL, 'utf8'));
  console.log('[migrate] 018 usage idempotency applied (column + partial-unique index)');

  // Confirm the column + index exist; report how many legacy rows carry NULL keys.
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='waddling' AND table_name='usage_event' AND column_name='idempotency_key'`,
  );
  const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='usage_event_idem_uq'`);
  const cnt = await pool.query(
    `SELECT count(*) FILTER (WHERE idempotency_key IS NULL) AS legacy_null,
            count(*)                                       AS total
       FROM waddling.usage_event`,
  );
  const r = cnt.rows[0];
  console.log(
    `[migrate] column=${col.rowCount ? 'yes' : 'NO'} index=${idx.rowCount ? 'yes' : 'NO'} ` +
      `usage_event rows: ${r.total} (legacy NULL key: ${r.legacy_null})`,
  );
} finally {
  await pool.end();
}
