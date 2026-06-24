// Apply migration 017 (credit-balance tier/topup buckets) to the target DB. Idempotent —
// safe to re-run. Run with the control DB connection string:
//   DATABASE_URL=postgres://… node scripts/_migrate_017_credit_buckets.mjs
// Delete after use (mirrors scripts/_migrate_015_credits.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = join(HERE, '..', 'packages', 'control-schema', 'migrations-017-credit-buckets.sql');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(readFileSync(SQL, 'utf8'));
  console.log('[migrate] 017 credit buckets applied (columns added + balance backfilled to topup)');

  const r = await pool.query(
    `SELECT count(*)                          AS orgs,
            coalesce(sum(tier_balance_micro),0)  AS tier_micro,
            coalesce(sum(topup_balance_micro),0) AS topup_micro
       FROM waddling.credit_balance`,
  );
  const row = r.rows[0];
  console.log(
    `[migrate] ${row.orgs} balance row(s): tier=${row.tier_micro}µUSD topup=${row.topup_micro}µUSD`,
  );
} finally {
  await pool.end();
}
