/**
 * verify-lake.ts — prove a real (UI-created) endpoint's lake actually works.
 *
 * Loads the endpoint's stored, encrypted credentials through the real
 * getEndpointGatewayConfig accessor and does exactly what the gateway does:
 * CREATE SECRET + ATTACH the DuckLake on its DATA_PATH, then round-trips a table
 * (write → read) to prove the stored creds authorize the bucket.
 *
 * Run:
 *   DATABASE_URL=postgres://waddling:waddling@localhost:5470/waddling \
 *   BETTER_AUTH_SECRET=demo-better-auth-secret-change-in-prod \
 *   ENDPOINT_ID=<id> pnpm --filter @waddling/gateway exec tsx verify-lake.ts
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { query } from '../../apps/waddling/src/lib/db.ts';
import { getEndpointGatewayConfig } from '../../apps/waddling/src/lib/endpoint-secrets.ts';

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const endpointId = process.env.ENDPOINT_ID ?? process.argv[2];
if (!endpointId) {
  console.error('usage: ENDPOINT_ID=<id> tsx verify-lake.ts');
  process.exit(1);
}

async function main() {
  const meta = await query<{ name: string; slug: string; status: string }>(
    `SELECT name, slug, status FROM waddling.endpoint WHERE id = $1`,
    [endpointId],
  );
  if (!meta.rows[0]) {
    console.error(`endpoint ${endpointId} not found`);
    process.exit(1);
  }
  console.log(`\n[verify] endpoint "${meta.rows[0].name}" (${meta.rows[0].slug}) — ${meta.rows[0].status}\n`);

  const cfg = await getEndpointGatewayConfig(endpointId);
  if (!cfg) { console.error('no config'); process.exit(1); }
  console.log('[verify] resolved gateway config:');
  console.log(`  dataPath   : ${cfg.ducklakeDataPath}`);
  console.log(`  localData  : ${cfg.localData}`);
  console.log(`  catalog    : ${cfg.ducklakeCatalogFile || cfg.ducklakeCatalogDsn || '(none)'}`);
  if (cfg.s3) {
    console.log(`  s3.endpoint: ${cfg.s3.endpoint}`);
    console.log(`  s3.region  : ${cfg.s3.region}`);
    console.log(`  s3.urlStyle: ${cfg.s3.urlStyle}`);
    console.log(`  s3.useSsl  : ${cfg.s3.useSsl}`);
    console.log(`  s3.keyId   : ${cfg.s3.keyId}`);
    console.log(`  s3.secret  : ${cfg.s3.secret ? '••• (decrypted, len ' + cfg.s3.secret.length + ')' : '(none)'}`);
  }
  console.log();

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('INSTALL httpfs; LOAD httpfs; INSTALL ducklake; LOAD ducklake;');

  if (cfg.s3) {
    await conn.run(`
      CREATE OR REPLACE SECRET lake_s3 (
        TYPE s3, PROVIDER config,
        KEY_ID ${q(cfg.s3.keyId)}, SECRET ${q(cfg.s3.secret)},
        ENDPOINT ${q(cfg.s3.endpoint)}, REGION ${q(cfg.s3.region)},
        USE_SSL ${cfg.s3.useSsl ? 'true' : 'false'}, URL_STYLE ${q(cfg.s3.urlStyle)}
      )`);
    console.log('[verify] ✓ CREATE SECRET from decrypted creds');
  }

  const catalogTarget = cfg.ducklakeCatalogFile
    ? `ducklake:${cfg.ducklakeCatalogFile}`
    : `ducklake:postgres:${cfg.ducklakeCatalogDsn}`;
  if (cfg.ducklakeCatalogFile) mkdirSync(dirname(cfg.ducklakeCatalogFile), { recursive: true });
  // DATA_INLINING_ROW_LIMIT 0 forces every write to a parquet file on DATA_PATH
  // instead of inlining small changes into the catalog — so we can prove the
  // creds authorize an actual S3 object PUT.
  const attachOpts = [`DATA_PATH ${q(cfg.ducklakeDataPath)}`];
  if (process.env.NO_INLINE === '1') attachOpts.push('DATA_INLINING_ROW_LIMIT 0');
  await conn.run(`ATTACH '${catalogTarget}' AS lake (${attachOpts.join(', ')})`);
  console.log(`[verify] ✓ ATTACH ${catalogTarget} on ${cfg.ducklakeDataPath}`);

  const tbl = `verify_${process.env.TBL ?? 't'}`;
  await conn.run(`CREATE TABLE IF NOT EXISTS lake.${tbl} (i INTEGER, note VARCHAR)`);
  await conn.run(`INSERT INTO lake.${tbl} VALUES (1,'ui-created'),(2,'lake'),(3,'works')`);
  const r = await conn.runAndReadAll(`SELECT count(*)::int AS n FROM lake.${tbl}`);
  const n = Number((r.getRows()[0] as unknown[])[0]);
  console.log(`[verify] ✓ wrote + read back ${n} rows via the lake`);

  // Prove the parquet really landed on the object store (independent of the catalog).
  const snap = await conn.runAndReadAll(
    "SELECT count(*)::int AS files FROM glob('" + cfg.ducklakeDataPath + "**/*.parquet')",
  ).catch((e) => { console.log('  glob error:', e instanceof Error ? e.message : e); return null; });
  if (snap) console.log(`[verify] ✓ ${Number((snap.getRows()[0] as unknown[])[0])} parquet file(s) under ${cfg.ducklakeDataPath}`);

  if (process.env.KEEP === '1') {
    console.log('[verify] KEEP=1 — leaving data in place');
  } else {
    await conn.run(`DROP TABLE lake.${tbl}`);
    await conn.run('DETACH lake');
  }
  if (n !== 3) { console.error('row count mismatch'); process.exit(1); }
  console.log('\n[verify] PASS — the UI-created lake attaches and round-trips data.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[verify] FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
