/**
 * seed.ts — waddling demo seed script.
 *
 * Run: docker compose -f scripts/waddling-demo/docker-compose.yml \
 *        --profile seed run --rm seed
 *
 * Or locally: DATABASE_URL=... S3_ENDPOINT=... tsx scripts/waddling-demo/seed.ts
 *
 * What it does:
 *  1. Waits for Postgres and MinIO to be healthy.
 *  2. Creates MinIO bucket "waddling-lake" via mc-setup.sh.
 *  3. Applies packages/control-schema/schema.sql (waddling schema).
 *  4. Runs Better Auth migrations (creates auth.* tables).
 *  5. Seeds: org "acme", admin user admin@acme.test / waddling-demo.
 *  6. Seeds: endpoint "prod-lake" for acme org.
 *  7. Seeds: agents "analyst" and "etl-bot" with API keys (prints them).
 *  8. Loads DuckLake sales schema on MinIO (orders, customers w/ ssn, events ~50k rows).
 *  9. Installs ACL rules per §8.
 */

import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import { DuckDBInstance } from '@duckdb/node-api';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
import { createHash } from '@better-auth/utils/hash';
import { base64Url } from '@better-auth/utils/base64';
import { hashPassword } from '@better-auth/utils/password';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, '..', '..');

// ── Config from env ────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://waddling:waddling@localhost:5470/waddling';
const S3_ENDPOINT   = process.env.S3_ENDPOINT   ?? 'http://localhost:9000';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'minioadmin';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? 'minioadmin';
const BUCKET        = 'waddling-lake';
// Local-file DuckLake mode (no Postgres catalog, no MinIO): set when a local
// catalog file is provided. DATA_PATH then points at a local directory and the
// lake is ATTACHed as 'ducklake:<file>'. Mirrors packages/gateway/src/config.ts.
const DUCKLAKE_CATALOG_FILE = process.env.DUCKLAKE_CATALOG_FILE ?? '';
// Dedicated Postgres catalog DSN for the lake (libpq form, e.g.
// 'dbname=ducklake host=127.0.0.1 port=5432 ...'). Enables concurrent/live
// writers (gateway + ingest jobs). Distinct from DATABASE_URL (control plane).
const DUCKLAKE_CATALOG_DSN  = process.env.DUCKLAKE_CATALOG_DSN ?? '';
const DATA_PATH     = process.env.DUCKLAKE_DATA_PATH ?? `s3://${BUCKET}/`;
const LOCAL_DATA    = !/^s3:\/\//i.test(DATA_PATH);

// ── Helpers ────────────────────────────────────────────────────────────────────

function genId(): string {
  return crypto.randomUUID();
}

function genApiKey(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

/**
 * Hash a plaintext API key exactly as @better-auth/api-key's defaultKeyHasher
 * does (bare SHA-256, base64url, no padding) so a directly-INSERTed key verifies
 * via auth.api.verifyApiKey (which hashes the incoming key and looks it up).
 */
async function hashApiKey(key: string): Promise<string> {
  const digest = await createHash('SHA-256').digest(new TextEncoder().encode(key));
  return base64Url.encode(new Uint8Array(digest), { padding: false });
}

async function waitForPostgres(pool: Pool, retries = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[seed] Postgres is ready.');
      return;
    } catch {
      console.log(`[seed] Waiting for Postgres (attempt ${i}/${retries})...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Postgres did not become ready in time.');
}

async function waitForMinio(retries = 30, delayMs = 2000): Promise<void> {
  const url = `${S3_ENDPOINT}/minio/health/live`;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) {
        console.log('[seed] MinIO is ready.');
        return;
      }
    } catch {
      // not yet ready
    }
    console.log(`[seed] Waiting for MinIO (attempt ${i}/${retries})...`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('MinIO did not become ready in time.');
}

// ── Main ───────────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: DATABASE_URL });

async function main(): Promise<void> {
  console.log('[seed] Starting waddling demo seed...');

  // 1. Wait for dependencies
  await waitForPostgres(pool);
  if (!LOCAL_DATA) await waitForMinio();

  // 2. Create the object store (MinIO bucket) — or, in local mode, the data dir.
  if (LOCAL_DATA) {
    mkdirSync(DATA_PATH, { recursive: true });
    if (DUCKLAKE_CATALOG_FILE) mkdirSync(dirname(DUCKLAKE_CATALOG_FILE), { recursive: true });
    console.log(`[seed] Local DuckLake: catalog ${DUCKLAKE_CATALOG_FILE || '(postgres)'} data ${DATA_PATH}`);
  } else {
    console.log('[seed] Setting up MinIO bucket...');
    try {
      execSync(`bash "${join(__dirname, 'mc-setup.sh')}"`, {
        env: {
          ...process.env,
          S3_ENDPOINT,
          S3_ACCESS_KEY,
          S3_SECRET_KEY,
          LAKE_BUCKET: BUCKET,
        },
        stdio: 'inherit',
      });
    } catch {
      // mc may not be installed in the seed container; create bucket directly via S3 API
      console.log('[seed] mc not available, creating bucket via S3 API...');
      await createBucketViaS3();
    }
  }

  // 3. Apply waddling schema
  console.log('[seed] Applying waddling schema...');
  const schemaSql = readFileSync(
    join(WORKSPACE_ROOT, 'packages/control-schema/schema.sql'),
    'utf8',
  );
  await pool.query(schemaSql);
  console.log('[seed] waddling schema applied.');

  // 3b. Apply incremental migrations (migrations-NNN-*.sql) in order. Each is
  //     idempotent (IF [NOT] EXISTS / ADD COLUMN IF NOT EXISTS), so re-running is
  //     safe. Without this, fresh boots miss columns added post-schema.sql (e.g.
  //     device-link, agent-auth mode/origin) → 500s in routes that select them.
  const schemaDir = join(WORKSPACE_ROOT, 'packages/control-schema');
  const migrations = readdirSync(schemaDir)
    .filter((f) => /^migrations-\d+.*\.sql$/.test(f))
    .sort();
  for (const file of migrations) {
    console.log(`[seed] Applying ${file}...`);
    await pool.query(readFileSync(join(schemaDir, file), 'utf8'));
  }
  console.log(`[seed] ${migrations.length} migration(s) applied.`);

  // 4. Apply Better Auth schema
  //    The auth schema is created by Better Auth's getMigrations().
  //    We call it here so both schemas are present before seeding.
  console.log('[seed] Applying Better Auth migrations...');
  await applyBetterAuthMigrations();

  // 4b. Seed an RS256 JWKS keypair. The app's Better Auth jwt plugin mints one
  //     lazily, but it isn't running at seed time, so api/cp/sessions would fail
  //     with no_signing_key on the first connect. Plaintext privateKey matches
  //     disablePrivateKeyEncryption:true so jose can import it.
  console.log('[seed] Seeding JWKS signing key...');
  await seedJwks();

  // 5. Seed org + admin user
  console.log('[seed] Seeding org acme and admin user...');
  const { orgId, adminUserId } = await seedOrgAndAdmin();

  // 6. Seed endpoint prod-lake
  console.log('[seed] Seeding endpoint prod-lake...');
  const endpointId = await seedEndpoint(orgId);

  // 7. Seed agents analyst + etl-bot
  console.log('[seed] Seeding agents...');
  const { analystId, analystKey, etlBotId, etlBotKey } = await seedAgents(orgId, adminUserId);

  // 8. Load DuckLake sales schema with synthetic data
  console.log('[seed] Loading DuckLake sales schema (~50k rows)...');
  await seedDuckLake(endpointId);

  // 9. Install ACL rules
  console.log('[seed] Installing ACL rules...');
  await seedAclRules(orgId, endpointId, analystId, etlBotId, adminUserId);

  console.log('\n[seed] ─────────────────────────────────────────────────────');
  console.log('[seed] Seed complete!');
  console.log('[seed]');
  console.log('[seed]  Org:      acme');
  console.log('[seed]  Admin:    admin@acme.test  /  waddling-demo');
  console.log('[seed]  Endpoint: prod-lake (id:', endpointId, ')');
  console.log('[seed]');
  console.log('[seed]  analyst API key :  ' + analystKey);
  console.log('[seed]  etl-bot API key :  ' + etlBotKey);
  console.log('[seed]');
  console.log('[seed]  Dashboard: http://localhost:3100');
  console.log('[seed] ─────────────────────────────────────────────────────\n');

  await pool.end();
}

// ── S3 bucket creation (fallback when mc is unavailable) ──────────────────────
async function createBucketViaS3(): Promise<void> {
  const url = `${S3_ENDPOINT}/${BUCKET}`;
  // S3 PUT bucket (unsigned for MinIO local dev)
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/xml' },
  });
  if (!res.ok && res.status !== 409 /* BucketAlreadyOwnedByYou */) {
    const body = await res.text();
    console.warn(`[seed] Bucket create returned ${res.status}: ${body} (may be ok if bucket exists)`);
  } else {
    console.log(`[seed] Bucket ${BUCKET} ready.`);
  }
}

// ── Better Auth migrations ────────────────────────────────────────────────────
async function applyBetterAuthMigrations(): Promise<void> {
  // Create the auth schema with the tables Better Auth expects.
  // We create them with IF NOT EXISTS so re-runs are safe.
  // Better Auth also runs getMigrations() at startup, but we need the tables
  // present before we insert the admin user seed data.
  const authSchema = `
    CREATE SCHEMA IF NOT EXISTS public;

    -- Better Auth core tables (simplified DDL matching better-auth 1.6.18)
    CREATE TABLE IF NOT EXISTS "user" (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL UNIQUE,
      "emailVerified" BOOLEAN NOT NULL DEFAULT false,
      image           TEXT,
      "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS account (
      id                TEXT PRIMARY KEY,
      "accountId"       TEXT NOT NULL,
      "providerId"      TEXT NOT NULL,
      "userId"          TEXT NOT NULL,
      "accessToken"     TEXT,
      "refreshToken"    TEXT,
      "idToken"         TEXT,
      "expiresAt"       TIMESTAMPTZ,
      password          TEXT,
      "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS session (
      id          TEXT PRIMARY KEY,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "userId"    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification (
      id         TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value      TEXT NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS jwks (
      id          TEXT PRIMARY KEY,
      "publicKey" TEXT NOT NULL,
      "privateKey" TEXT NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Organization plugin
    CREATE TABLE IF NOT EXISTS organization (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      logo        TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata    TEXT
    );

    CREATE TABLE IF NOT EXISTS member (
      id             TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "userId"       TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'member',
      "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS invitation (
      id             TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      email          TEXT NOT NULL,
      role           TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      "expiresAt"    TIMESTAMPTZ NOT NULL,
      "inviterId"    TEXT NOT NULL
    );

    -- API key plugin. Column set must match @better-auth/api-key's schema
    -- (configId, referenceId, refill* are required/selected by the adapter's
    -- findOne; a missing column makes verifyApiKey throw a SQL error).
    CREATE TABLE IF NOT EXISTS apikey (
      id            TEXT PRIMARY KEY,
      "configId"    TEXT NOT NULL DEFAULT 'default',
      "referenceId" TEXT,
      name          TEXT,
      start         TEXT,
      prefix        TEXT,
      key           TEXT NOT NULL UNIQUE,
      "userId"      TEXT NOT NULL,
      "refillInterval" INTEGER,
      "refillAmount" INTEGER,
      "refillAt"    TIMESTAMPTZ,
      "lastRefillAt" TIMESTAMPTZ,
      enabled       BOOLEAN NOT NULL DEFAULT true,
      "rateLimitEnabled" BOOLEAN NOT NULL DEFAULT false,
      "rateLimitTimeWindow" INTEGER,
      "rateLimitMax" INTEGER,
      "requestCount" INTEGER NOT NULL DEFAULT 0,
      remaining     INTEGER,
      "expiresAt"   TIMESTAMPTZ,
      "lastRequest" TIMESTAMPTZ,
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
      permissions   TEXT,
      metadata      TEXT
    );

    -- Stripe plugin
    CREATE TABLE IF NOT EXISTS subscription (
      id              TEXT PRIMARY KEY,
      plan            TEXT NOT NULL,
      "referenceId"   TEXT NOT NULL,
      "stripeCustomerId"     TEXT,
      "stripeSubscriptionId" TEXT,
      status          TEXT,
      "periodStart"   TIMESTAMPTZ,
      "periodEnd"     TIMESTAMPTZ,
      "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
      seats           INTEGER,
      "trialStart"    TIMESTAMPTZ,
      "trialEnd"      TIMESTAMPTZ,
      "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  await pool.query(authSchema);
  console.log('[seed] Better Auth schema tables created.');
}

// ── JWKS signing key ────────────────────────────────────────────────────────────
async function seedJwks(): Promise<void> {
  const existing = await pool.query<{ id: string }>(`SELECT id FROM jwks LIMIT 1`);
  if (existing.rows.length > 0) {
    console.log('[seed] JWKS key already present, skipping.');
    return;
  }
  // RS256 keypair; export both halves as JWK (extractable).
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  // Better Auth's jwt plugin stores publicKey/privateKey as JSON-stringified JWKs;
  // api/cp/sessions JSON.parses each (publicKey→{n,e,kty}, privateKey→full JWK).
  await pool.query(
    `INSERT INTO jwks (id, "publicKey", "privateKey", "createdAt")
     VALUES ($1, $2, $3, now())`,
    [genId(), JSON.stringify(publicJwk), JSON.stringify(privateJwk)],
  );
  console.log('[seed] JWKS RS256 key seeded.');
}

// ── Org + admin user ──────────────────────────────────────────────────────────
async function seedOrgAndAdmin(): Promise<{ orgId: string; adminUserId: string }> {
  // Idempotent: check if acme org already exists
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM organization WHERE slug = 'acme'`,
  );
  if (existing.rows.length > 0) {
    const orgId = existing.rows[0]!.id;
    const userRow = await pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = 'admin@acme.test'`,
    );
    const adminUserId = userRow.rows[0]?.id ?? genId();
    console.log('[seed] Org acme already exists, skipping.');
    return { orgId, adminUserId };
  }

  const orgId = genId();
  const adminUserId = genId();
  const accountId = genId();
  const memberId = genId();

  // Hash the password with Better Auth's OWN default hasher (scrypt, format
  // 'salt:hash') so the credential verifies on sign-in. Re-implementing the
  // hash by hand produces an "Invalid password hash" error at login.
  const storedPassword = await hashPassword('waddling-demo');

  await pool.query(
    `INSERT INTO organization (id, name, slug, "createdAt")
     VALUES ($1, 'Acme Corp', 'acme', now())
     ON CONFLICT (slug) DO NOTHING`,
    [orgId],
  );

  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Admin', 'admin@acme.test', true, now(), now())
     ON CONFLICT (email) DO NOTHING`,
    [adminUserId],
  );

  await pool.query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
     VALUES ($1, $2, 'credential', $3, $4, now(), now())
     ON CONFLICT DO NOTHING`,
    [accountId, adminUserId, adminUserId, storedPassword],
  );

  await pool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'owner', now())
     ON CONFLICT DO NOTHING`,
    [memberId, orgId, adminUserId],
  );

  // Seed a free-tier subscription for acme
  await pool.query(
    `INSERT INTO subscription (id, plan, "referenceId", status, "createdAt", "updatedAt")
     VALUES ($1, 'pro', $2, 'active', now(), now())
     ON CONFLICT DO NOTHING`,
    [genId(), orgId],
  );

  console.log('[seed] Created org acme and admin user admin@acme.test');
  return { orgId, adminUserId };
}

// ── Endpoint ──────────────────────────────────────────────────────────────────
async function seedEndpoint(orgId: string): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM waddling.endpoint WHERE org_id = $1 AND slug = 'prod-lake'`,
    [orgId],
  );
  if (existing.rows.length > 0) {
    console.log('[seed] Endpoint prod-lake already exists, skipping.');
    return existing.rows[0]!.id;
  }

  // Host the control plane reaches the gateway at: the Docker service name
  // 'gateway' in compose, or 'localhost' for the no-Docker host-native run.
  const gatewayHost = process.env.GATEWAY_HOST ?? 'gateway';
  const id = genId();
  await pool.query(
    `INSERT INTO waddling.endpoint
       (id, org_id, name, slug, status, catalog_dsn, data_path, region, encrypted,
        gateway_host, quack_port, server_token)
     VALUES ($1,$2,'prod-lake','prod-lake','running',$3,$4,'auto',false,
             $5,9500,'demo-server-token-change-in-prod')`,
    [
      id,
      orgId,
      DATABASE_URL,
      DATA_PATH,
      gatewayHost,
    ],
  );
  console.log('[seed] Created endpoint prod-lake id=' + id);
  return id;
}

// ── Agents ────────────────────────────────────────────────────────────────────
async function seedAgents(orgId: string, ownerUserId: string): Promise<{
  analystId: string;
  analystKey: string;
  etlBotId: string;
  etlBotKey: string;
}> {
  async function upsertAgent(
    name: string,
    description: string,
    defaultRole: string,
    apiKey: string,
  ): Promise<{ agentId: string; apiKey: string }> {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM waddling.agent WHERE org_id = $1 AND name = $2`,
      [orgId, name],
    );
    if (existing.rows.length > 0) {
      const agentId = existing.rows[0]!.id;
      console.log(`[seed] Agent ${name} already exists, skipping.`);
      return { agentId, apiKey };
    }

    const agentId = genId();
    const hashedKey = await hashApiKey(apiKey); // store the hash, not plaintext

    // The agent's API key is OWNED by the human who created it (the admin), so
    // the dashboard can show a meaningful "owner" per agent. (The agent's own
    // identity for ACL purposes is `agent:<agentId>`, independent of this.)
    // ON CONFLICT handles re-runs where the apikey was inserted but the agent row
    // was not (e.g. a previous partial seed failure).
    const keyRow = await pool.query<{ id: string }>(
      `INSERT INTO apikey (id, "configId", "referenceId", name, start, prefix, key, "userId",
                           enabled, "rateLimitEnabled", "requestCount", "createdAt", "updatedAt")
       VALUES ($1,'default',$2,$3,$4,'sk_agent_',$5,$6,true,false,0,now(),now())
       ON CONFLICT (key) DO UPDATE SET "updatedAt" = now()
       RETURNING id`,
      [genId(), orgId, name, apiKey.slice(0, 8), hashedKey, ownerUserId],
    );
    const apiKeyId = keyRow.rows[0]!.id;

    await pool.query(
      `INSERT INTO waddling.agent
         (id, org_id, name, description, api_key_id, default_role, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [agentId, orgId, name, description, apiKeyId, defaultRole],
    );

    console.log(`[seed] Created agent ${name} id=${agentId}`);
    return { agentId, apiKey };
  }

  // Deterministic demo keys so docker-compose env (WADDLING_API_KEY,
  // WADDLING_ADMIN_TOKEN) can reference them without parsing seed stdout.
  const { agentId: analystId, apiKey: analystKey } = await upsertAgent(
    'analyst',
    'LLM analytics agent — reads sales data',
    'reader',
    'sk_agent_analyst_demo',
  );

  const { agentId: etlBotId, apiKey: etlBotKey } = await upsertAgent(
    'etl-bot',
    'Nightly ETL agent — writes events data',
    'writer',
    'sk_agent_etlbot_demo',
  );

  // Admin agent — a real org-scoped sk_ key that authorizes the demo agent's
  // control-plane admin calls (POST /api/cp/acl, DELETE /api/cp/agents/:id).
  // These routes accept any active agent key for the org via resolveCaller; no
  // auth weakening. WADDLING_ADMIN_TOKEN in compose must equal this key.
  await upsertAgent(
    'admin-bot',
    'Demo admin principal — grants/revokes via control-plane REST',
    'admin',
    'sk_agent_admin_demo',
  );

  return { analystId, analystKey, etlBotId, etlBotKey };
}

// ── DuckLake seed ─────────────────────────────────────────────────────────────
async function seedDuckLake(endpointId: string): Promise<void> {
  // We spin up a DuckDB instance, install ducklake + postgres extensions,
  // ATTACH the DuckLake, and INSERT synthetic data.
  const duck = await DuckDBInstance.create(':memory:', {
    allow_unsigned_extensions: 'true',
  });

  const conn = await duck.connect();

  try {
    // Install and load required extensions (one statement at a time)
    await conn.run(`INSTALL ducklake`);
    await conn.run(`LOAD ducklake`);
    await conn.run(`INSTALL postgres`);
    await conn.run(`LOAD postgres`);
    await conn.run(`INSTALL httpfs`);
    await conn.run(`LOAD httpfs`);

    // Configure S3 (MinIO) — one SET per call. Skipped in local-file mode.
    if (!LOCAL_DATA) {
      const s3Host = S3_ENDPOINT.replace(/^https?:\/\//, '');
      await conn.run(`SET s3_endpoint='${s3Host}'`);
      await conn.run(`SET s3_access_key_id='${S3_ACCESS_KEY}'`);
      await conn.run(`SET s3_secret_access_key='${S3_SECRET_KEY}'`);
      await conn.run(`SET s3_region='us-east-1'`);
      await conn.run(`SET s3_use_ssl=false`);
      await conn.run(`SET s3_url_style='path'`);
    }

    // ATTACH the DuckLake. Local-file catalog ('ducklake:<file>') in host-native
    // mode; postgres catalog otherwise. (check idempotency below)
    const catalogTarget = DUCKLAKE_CATALOG_FILE
      ? `ducklake:${DUCKLAKE_CATALOG_FILE}`
      : DUCKLAKE_CATALOG_DSN
        ? `ducklake:postgres:${DUCKLAKE_CATALOG_DSN}`
        : `ducklake:postgres:${DATABASE_URL}`;
    await conn.run(
      `ATTACH '${catalogTarget}' AS lake (DATA_PATH '${DATA_PATH}', CREATE_IF_NOT_EXISTS true)`,
    );

    // Check if sales schema already exists (use duckdb_schemas for reliability)
    const schemaCheck = await conn.runAndReadAll(
      `SELECT schema_name FROM duckdb_schemas() WHERE database_name = 'lake' AND schema_name = 'sales'`,
    );

    if (schemaCheck.getRows().length > 0) {
      console.log('[seed] DuckLake sales schema already exists, skipping data load.');
      return;
    }

    console.log('[seed] Creating DuckLake sales schema and tables...');
    await conn.run(`CREATE SCHEMA IF NOT EXISTS lake.sales;`);

    // Create orders table
    await conn.run(`
      CREATE TABLE IF NOT EXISTS lake.sales.orders (
        order_id     BIGINT NOT NULL,
        customer_id  BIGINT NOT NULL,
        product_sku  VARCHAR NOT NULL,
        quantity     INTEGER NOT NULL,
        unit_price   DECIMAL(10,2) NOT NULL,
        total_amount DECIMAL(12,2) NOT NULL,
        status       VARCHAR NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL
      );
    `);

    // Create customers table (with PII ssn column)
    await conn.run(`
      CREATE TABLE IF NOT EXISTS lake.sales.customers (
        customer_id  BIGINT NOT NULL,
        name         VARCHAR NOT NULL,
        email        VARCHAR NOT NULL,
        ssn          VARCHAR NOT NULL,    -- PII: analyst is DENIED this column
        country      VARCHAR NOT NULL,
        tier         VARCHAR NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL
      );
    `);

    // Create events table (etl-bot writes here)
    await conn.run(`
      CREATE TABLE IF NOT EXISTS lake.sales.events (
        event_id    BIGINT NOT NULL,
        customer_id BIGINT NOT NULL,
        event_type  VARCHAR NOT NULL,
        payload     JSON,
        ts          TIMESTAMPTZ NOT NULL
      );
    `);

    console.log('[seed] Inserting synthetic data (~50k rows across 3 tables)...');

    // Generate ~20k orders
    await conn.run(`
      INSERT INTO lake.sales.orders
      SELECT
        row_number() OVER ()::BIGINT                              AS order_id,
        (random() * 9999 + 1)::BIGINT                            AS customer_id,
        'SKU-' || lpad((random()*999+1)::INTEGER::VARCHAR, 4, '0') AS product_sku,
        (random() * 9 + 1)::INTEGER                              AS quantity,
        round((random() * 490 + 10)::NUMERIC, 2)                 AS unit_price,
        round((random() * 4900 + 10)::NUMERIC, 2)                AS total_amount,
        CASE (random()*4)::INTEGER
          WHEN 0 THEN 'pending'
          WHEN 1 THEN 'confirmed'
          WHEN 2 THEN 'shipped'
          WHEN 3 THEN 'delivered'
          ELSE 'cancelled'
        END                                                       AS status,
        now() - (random() * INTERVAL '365 days')                 AS created_at,
        now() - (random() * INTERVAL '30 days')                  AS updated_at
      FROM range(20000);
    `);

    // Generate ~10k customers with fake SSNs
    await conn.run(`
      INSERT INTO lake.sales.customers
      SELECT
        (row_number() OVER ())::BIGINT                          AS customer_id,
        'Customer ' || (row_number() OVER ())::VARCHAR          AS name,
        'user' || (row_number() OVER ())::VARCHAR || '@example.com' AS email,
        lpad((random()*899+100)::INTEGER::VARCHAR,3,'0') || '-'
          || lpad((random()*89+10)::INTEGER::VARCHAR,2,'0') || '-'
          || lpad((random()*8999+1000)::INTEGER::VARCHAR,4,'0') AS ssn,
        CASE (random()*4)::INTEGER
          WHEN 0 THEN 'US' WHEN 1 THEN 'GB'
          WHEN 2 THEN 'DE' ELSE 'CA'
        END                                                     AS country,
        CASE (random()*2)::INTEGER
          WHEN 0 THEN 'standard' WHEN 1 THEN 'premium' ELSE 'enterprise'
        END                                                     AS tier,
        now() - (random() * INTERVAL '730 days')                AS created_at
      FROM range(10000);
    `);

    // Generate ~20k events
    await conn.run(`
      INSERT INTO lake.sales.events
      SELECT
        (row_number() OVER ())::BIGINT                          AS event_id,
        (random() * 9999 + 1)::BIGINT                          AS customer_id,
        CASE (random()*4)::INTEGER
          WHEN 0 THEN 'page_view'  WHEN 1 THEN 'add_to_cart'
          WHEN 2 THEN 'purchase'   WHEN 3 THEN 'refund'
          ELSE 'search'
        END                                                     AS event_type,
        '{"source":"demo"}'::JSON                               AS payload,
        now() - (random() * INTERVAL '90 days')                 AS ts
      FROM range(20000);
    `);

    console.log('[seed] DuckLake sales data loaded (orders: 20k, customers: 10k, events: 20k).');

    // Update endpoint status to 'running'
    await pool.query(
      `UPDATE waddling.endpoint SET status = 'running', updated_at = now() WHERE id = $1`,
      [endpointId],
    );

  } finally {
    conn.closeSync();
    // DuckDBInstance does not expose close() in this version; let GC handle it.
  }
}

// ── ACL rules ─────────────────────────────────────────────────────────────────
async function seedAclRules(
  orgId: string,
  endpointId: string,
  analystId: string,
  etlBotId: string,
  adminUserId: string,
): Promise<void> {
  async function upsertRule(
    agentId: string,
    schemaName: string,
    tableName: string,
    verb: 'read' | 'write',
    columns: string[] | null,
    description: string,
  ): Promise<void> {
    const existing = await pool.query(
      `SELECT id FROM waddling.acl_rule
       WHERE org_id=$1 AND endpoint_id=$2 AND agent_id=$3
         AND schema_name=$4 AND table_name=$5 AND verb=$6`,
      [orgId, endpointId, agentId, schemaName, tableName, verb],
    );
    if (existing.rows.length > 0) {
      console.log(`[seed] ACL rule already exists: ${description}`);
      return;
    }

    await pool.query(
      `INSERT INTO waddling.acl_rule
         (id, org_id, endpoint_id, agent_id, schema_name, table_name,
          columns, verb, effect, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'allow',100,$9)`,
      [
        genId(),
        orgId,
        endpointId,
        agentId,
        schemaName,
        tableName,
        columns,
        verb,
        adminUserId,
      ],
    );
    console.log(`[seed] Created ACL rule: ${description}`);
  }

  // analyst → read sales.orders (all columns)
  await upsertRule(analystId, 'sales', 'orders', 'read', null,
    'analyst read sales.orders (all columns)');

  // analyst → read sales.customers EXCEPT ssn
  // We express this as an allow-list of safe columns (ssn excluded)
  await upsertRule(analystId, 'sales', 'customers', 'read',
    ['customer_id', 'name', 'email', 'country', 'tier', 'created_at'],
    'analyst read sales.customers (no ssn)');

  // etl-bot → write sales.events
  await upsertRule(etlBotId, 'sales', 'events', 'write', null,
    'etl-bot write sales.events');
}

// ── Entry point ───────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  console.error('[seed] FATAL:', err);
  process.exit(1);
});
