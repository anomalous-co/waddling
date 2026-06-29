// Apply the Phase-1/3 SQL migrations to prod (idempotent/guarded). No Better Auth
// half — prod auth is already live. Delete after use.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'packages', 'control-schema');
const FILES = [
  'migrations-010-user-grants-delegation.sql',
  'migrations-011-quackboard.sql',
  'migrations-012-acl-policy.sql',
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  for (const f of FILES) {
    await pool.query(readFileSync(join(DIR, f), 'utf8'));
    console.log(`[migrate] ${f} applied`);
  }
} finally {
  await pool.end();
}
