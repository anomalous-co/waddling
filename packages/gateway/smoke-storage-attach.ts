/**
 * Smoke test — stored BYO credentials actually attach a DuckLake on MinIO/S3.
 *
 * Proves the migration-005 storage contract end to end WITHOUT the birdshot/quack
 * machinery (which needs a compiled extension): it stores encrypted object-store
 * creds, resolves them through the real `getEndpointGatewayConfig` accessor, then
 * does exactly what the gateway's duck.ts does for storage — CREATE SECRET from
 * the decrypted creds + ATTACH a DuckLake whose DATA_PATH is the S3 bucket — and
 * round-trips a table (write → read) to prove the creds authorize the bucket.
 *
 * Run (needs Postgres on $DATABASE_URL + MinIO on $S3_ENDPOINT, bucket created):
 *   DATABASE_URL=postgres://waddling:waddling@localhost:5470/waddling \
 *   BETTER_AUTH_SECRET=demo-better-auth-secret-change-in-prod \
 *   S3_ENDPOINT=localhost:9000 S3_KEY_ID=minioadmin S3_SECRET=minioadmin \
 *   pnpm --filter @waddling/gateway exec tsx smoke-storage-attach.ts
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../../apps/waddling/src/lib/db.ts';
import {
  putEndpointSecret,
  getEndpointGatewayConfig,
} from '../../apps/waddling/src/lib/endpoint-secrets.ts';

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'localhost:9000';
const S3_KEY_ID = process.env.S3_KEY_ID ?? 'minioadmin';
const S3_SECRET = process.env.S3_SECRET ?? 'minioadmin';
const BUCKET = process.env.SMOKE_BUCKET ?? 'waddling-lake';

function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const endpointId = `smoke-${Date.now()}`;
  const dataPath = `s3://${BUCKET}/smoke-${Date.now()}/`;
  console.log(`\n[smoke] endpoint ${endpointId} → ${dataPath}\n`);

  // 1. Insert a minimal endpoint row (BYO storage, managed-local catalog).
  await query(
    `INSERT INTO waddling.endpoint
       (id, org_id, name, slug, catalog_dsn, data_path, region, encrypted, server_token, status,
        storage_provider, storage_endpoint, storage_region, storage_url_style, storage_use_ssl, catalog_mode)
     VALUES ($1,'smoke-org','Smoke','smoke','', $2,'us-east-1', false,'srv_smoke','provisioning',
             'config',$3,'us-east-1','path', false,'managed-local')`,
    [endpointId, dataPath, S3_ENDPOINT],
  );
  pass('endpoint row inserted');

  // 2. Encrypt + store the object-store credentials.
  await putEndpointSecret(endpointId, 'storage', { keyId: S3_KEY_ID, secret: S3_SECRET });
  pass('storage credentials sealed into endpoint_secret');

  // 3. Resolve through the real accessor (decrypts) — the gateway's seam.
  const cfg = await getEndpointGatewayConfig(endpointId);
  if (!cfg) fail('getEndpointGatewayConfig returned null');
  if (cfg.localData) fail('expected S3 data path (localData=false)');
  if (!cfg.s3) fail('no s3 config resolved');
  if (cfg.s3.secret !== S3_SECRET) fail('decrypted secret does not match original');
  pass('credentials decrypted via getEndpointGatewayConfig (round-trip OK)');

  // 4. Do what duck.ts does for storage: CREATE SECRET + ATTACH ducklake on S3.
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('INSTALL httpfs; LOAD httpfs; INSTALL ducklake; LOAD ducklake;');
  await conn.run(`
    CREATE OR REPLACE SECRET lake_s3 (
      TYPE s3, PROVIDER config,
      KEY_ID ${q(cfg.s3.keyId)}, SECRET ${q(cfg.s3.secret)},
      ENDPOINT ${q(cfg.s3.endpoint)}, REGION ${q(cfg.s3.region)},
      USE_SSL ${cfg.s3.useSsl ? 'true' : 'false'}, URL_STYLE ${q(cfg.s3.urlStyle)}
    )`);
  pass('CREATE SECRET from decrypted creds');

  // Managed-local catalog lives in a throwaway local file; data on S3.
  const catalogFile = join(mkdtempSync(join(tmpdir(), 'smoke-lake-')), 'lake.ducklake');
  await conn.run(
    `ATTACH 'ducklake:${catalogFile}' AS lake (DATA_PATH ${q(cfg.ducklakeDataPath)})`,
  );
  pass(`ATTACH ducklake on ${cfg.ducklakeDataPath}`);

  // 5. Write → read proves the creds authorize the bucket (Parquet to MinIO).
  await conn.run('CREATE TABLE lake.smoke_t (i INTEGER, label VARCHAR)');
  await conn.run("INSERT INTO lake.smoke_t VALUES (1,'a'),(2,'b'),(3,'c')");
  const reader = await conn.runAndReadAll('SELECT count(*)::int AS n FROM lake.smoke_t');
  const n = Number((reader.getRows()[0] as unknown[])[0]);
  if (n !== 3) fail(`expected 3 rows back, got ${n}`);
  pass(`wrote + read back ${n} rows through the S3 lake`);

  // 6. Cleanup.
  await conn.run('DROP TABLE lake.smoke_t');
  await conn.run('DETACH lake');
  await query(`DELETE FROM waddling.endpoint WHERE id = $1`, [endpointId]);
  pass('cleaned up (endpoint + secret cascade)');

  console.log('\n[smoke] PASS — stored credentials attach and authorize the S3 lake.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[smoke] ERROR:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
