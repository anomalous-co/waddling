// Apply migration 015 (prepaid credit ledger) to prod + backfill existing orgs with the
// starter grant, idempotently. Mirrors lib/credits: amounts are µUSD (1e-6 USD); the
// starter grant is $5.00 = 5_000_000 µUSD (keep in sync with STARTER_GRANT_USD).
// Idempotent — safe to re-run. Delete after use.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', 'packages', 'control-schema', 'migrations-015-credit-ledger.sql');
const STARTER_MICRO = 5_000_000; // $5.00 — must match lib/credits.STARTER_GRANT_USD

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  // 1. DDL.
  await pool.query(readFileSync(SCHEMA, 'utf8'));
  console.log('[migrate] 014 schema applied');

  // 2. Backfill a starter grant for every existing org (idempotent on starter:<orgId>).
  const granted = await pool.query(
    `INSERT INTO waddling.credit_ledger
       (org_id, amount_micro, entry_type, reason, ref_kind, idempotency_key, created_by)
     SELECT o.id, $1, 'grant', 'starter_grant', 'manual', 'starter:' || o.id, 'backfill'
       FROM "organization" o
     ON CONFLICT (org_id, idempotency_key) DO NOTHING
     RETURNING org_id`,
    [STARTER_MICRO],
  );
  console.log(`[migrate] starter grant inserted for ${granted.rowCount} new org(s)`);

  // 3. Recompute cached balances authoritatively from the ledger (handles any debits too).
  await pool.query(
    `INSERT INTO waddling.credit_balance (org_id, balance_micro, updated_at)
     SELECT org_id, COALESCE(SUM(amount_micro), 0), now()
       FROM waddling.credit_ledger GROUP BY org_id
     ON CONFLICT (org_id)
       DO UPDATE SET balance_micro = EXCLUDED.balance_micro, updated_at = now()`,
  );
  // 4. Fill balance_after on backfilled grants (single-entry orgs → equals the grant).
  await pool.query(
    `UPDATE waddling.credit_ledger l
        SET balance_after = b.balance_micro
       FROM waddling.credit_balance b
      WHERE l.org_id = b.org_id AND l.reason = 'starter_grant' AND l.balance_after IS NULL`,
  );
  console.log('[migrate] balances recomputed from ledger');
} finally {
  await pool.end();
}
