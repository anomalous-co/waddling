// Read-only prod schema probe for the Phase 3 deploy. Prints presence of the
// tables/columns compileEndpointPolicy depends on. No writes. Delete after use.
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
try {
  const tables = await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='waddling' AND table_name IN ('acl_rule','acl_policy','delegation','agent')`,
  );
  const cols = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='waddling' AND table_name='acl_rule'
        AND column_name IN ('subject_kind','user_id','capability')`,
  );
  const agentCols = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='waddling' AND table_name='agent' AND column_name='owner_user_id'`,
  );
  console.log('TABLES:', tables.map((r) => r.table_name).sort().join(',') || '(none)');
  console.log('acl_rule cols:', cols.map((r) => r.column_name).sort().join(',') || '(none)');
  console.log('agent.owner_user_id:', agentCols.length ? 'present' : 'MISSING');
} finally {
  await pool.end();
}
