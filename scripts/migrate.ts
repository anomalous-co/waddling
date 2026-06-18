/**
 * Combined migration runner — the single "make the control DB current" command.
 *
 *   pnpm db:migrate                 (uses $DATABASE_URL from the shell / .env)
 *   DATABASE_URL=… tsx scripts/migrate.ts
 *
 * Runs BOTH halves, in order, idempotently:
 *   1. waddling control schema — schema.sql + every migrations-NNN-*.sql.
 *   2. Better Auth — getMigrations() (diff-aware): creates/updates the auth tables
 *      INCLUDING the OAuth provider tables (oauthApplication / oauthAccessToken /
 *      oauthConsent) added by the mcp plugin. Without this the OAuth/delegated MCP
 *      endpoints 500 on a missing table.
 *
 * Used standalone (ops/CI) and by the dev bring-up (run-local.sh) before the app.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'packages', 'control-schema');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL is required');
    process.exit(1);
  }

  // ── 1. waddling control schema (base + ordered, idempotent migrations) ──
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(readFileSync(join(SCHEMA_DIR, 'schema.sql'), 'utf8'));
    console.log('[migrate] schema.sql applied');
    const migrations = readdirSync(SCHEMA_DIR)
      .filter((f) => /^migrations-\d+.*\.sql$/.test(f))
      .sort();
    for (const f of migrations) {
      await pool.query(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
      console.log(`[migrate] ${f} applied`);
    }
  } finally {
    await pool.end();
  }

  // ── 2. Better Auth migrations (creates the OAuth/mcp tables) ──
  // SKIP_ENV_VALIDATION lets lib/auth construct without real Stripe creds; set
  // BEFORE the dynamic import (lib/auth builds its Stripe client at module load).
  process.env.SKIP_ENV_VALIDATION ??= '1';
  const { runMigrations } = await import('../apps/waddling/src/lib/auth');
  await runMigrations();
  console.log('[migrate] better-auth getMigrations applied (incl. oauth tables)');
}

main().catch((e) => {
  console.error('[migrate] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
