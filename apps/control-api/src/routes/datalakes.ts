/**
 * /api/cp/endpoints — Hono port of apps/waddling/src/app/api/cp/endpoints/route.ts.
 *
 * GET  → list this org's endpoints (DatalakeSummary[]).
 * POST → create an endpoint record (status 'provisioning').
 *
 * This is the B2 representative route: it exercises resolveCaller + the db pool +
 * org-scoping end-to-end. The GET is a faithful full port. The POST is a MINIMAL
 * create — see the deferral note on the handler.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne, withTransaction } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';
import { getEntitlements } from '../lib/entitlements';
import { getDatalakeGatewayConfig } from '../lib/datalake-secrets';
import type { StorageCreds, CatalogCreds } from '../lib/datalake-secrets';
import { getCrypto } from '../lib/secret-crypto';
import { gatewayClientFor, GatewayError } from '../lib/gateway-client';
import { compilePolicy, grantsForAgent, type AclRuleRow } from '../lib/policy-compiler';
import { provisionOrgCatalog } from '../lib/catalog-provision';
import { resolveGatewayBoot, CatalogNotReadyError, StorageNotReadyError } from '../lib/gateway-boot';
import type { DescribeResult, TableInfo, DatalakeStatus, DatalakeSummary, DatalakeDetail, DatalakeRuntime } from '../lib/types';

// Endpoint status domain (canonical: lib/types DatalakeSummary['status']). The full
// types module is now ported, so this route uses the shared types directly (B2's
// inline DatalakeStatus/DatalakeSummary placeholders are reconciled away). New rows
// are created 'provisioning'; gateway boot flips them to 'running' later.
type DatalakeStatusName = DatalakeSummary['status'];

// BYO object storage for the lake's data files (unchanged from the original).
const StorageSchema = z
  .object({
    dataPath: z.string().min(1),
    provider: z.enum(['config', 'credential_chain']).default('config'),
    keyId: z.string().optional(),
    secret: z.string().optional(),
    sessionToken: z.string().optional(),
    region: z.string().optional(),
    endpoint: z.string().optional(),
    urlStyle: z.enum(['path', 'vhost']).default('vhost'),
    useSsl: z.boolean().default(true),
  })
  .refine((s) => s.provider === 'credential_chain' || (!!s.keyId && !!s.secret), {
    message: 'config provider requires keyId and secret',
    path: ['keyId'],
  });

const CreateSchema = z
  .object({
    name: z.string().min(1),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'slug must be url-safe (a-z 0-9 -)')
      .min(1),
    region: z.string().default('auto'),
    encrypted: z.boolean().default(true),
    // BYO postgres catalog DSN; omit ⇒ waddling provisions a (managed-local) catalog.
    catalogDsn: z.string().min(1).optional(),
    // Preferred: full BYO storage descriptor.
    storage: StorageSchema.optional(),
    // Legacy flat field (admin MCP / seed.ts) — treated as a local data dir.
    dataPath: z.string().min(1).optional(),
    // Fully-managed: per-org PlanetScale catalog + per-org R2 bucket (faucet). No BYO
    // catalog/storage needed — waddling provisions both.
    managed: z.boolean().default(false),
    // 'lake' (default) = governed DuckLake. 'quackboard' = per-org governed DuckDB with no
    // DuckLake mounted (durable shared agent memory); needs no catalog/storage at all.
    kind: z.enum(['lake', 'quackboard']).default('lake'),
  })
  .refine((d) => d.kind === 'quackboard' || !!d.storage || !!d.dataPath || d.managed, {
    message: 'storage is required (or set managed:true)',
    path: ['storage'],
  });

const datalakes = new Hono<{ Bindings: Env }>();

// GET — list this org's endpoints. Faithful full port: passes (requireOrg=true,
// allowDelegated=true) because this is a data-plane read (the MCP waddling_list_
// endpoints tool) and the original deliberately permits delegated OAuth/MCP callers.
datalakes.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, true, true);
    const rows = await query<{
      id: string;
      name: string;
      slug: string;
      status: DatalakeStatusName;
    }>(
      `SELECT id, name, slug, status FROM waddling.datalake
        WHERE org_id = $1 ORDER BY created_at ASC`,
      [caller.orgId],
    );
    const list: DatalakeSummary[] = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
    }));
    return ok(c, { datalakes: list });
  }),
);

// POST — create an endpoint row (status 'provisioning'); gateway boot is Stage D.
//
// Reconciled from the B2 minimal create: the plan-quota gate (getEntitlements) and
// the credential sealing (getCrypto().sealJson → waddling.datalake_secret) are now
// wired, since lib/entitlements + lib/secret-crypto are ported. The insert + secret
// writes run in ONE transaction (matching the original's withTransaction) — the seal
// + INSERT is inlined on the txn client rather than calling putEndpointSecret, which
// would run on a separate pool connection and trip datalake_secret's FK (see below).
//
// Still deferred (no lib seam in control-api yet):
//   - the managed-local catalog_file path assignment used getLocalLakeDir(), which
//     control-api's env.ts does not expose — gateway/workspace provisioning (Stage C)
//     owns the workspace/catalog file layout, so the catalog_file UPDATE stays out.
//   - PostHog telemetry (posthog-node) does not bundle/run on workerd — neutered
//     (mirrors lib/agent-identity's guarded no-op pattern); no event is emitted.
datalakes.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, CreateSchema);

    // Quota check (plan entitlement gate) — only when billing is configured.
    const billingOn = !!c.env.STRIPE_SECRET_KEY && !/placeholder/i.test(c.env.STRIPE_SECRET_KEY);
    const ent = await getEntitlements(caller.orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.datalake WHERE org_id = $1`,
      [caller.orgId],
    );
    if (billingOn && Number(count?.n ?? 0) >= ent.endpoints) {
      return err(c, 'endpoint_quota_exceeded', 402, `Plan allows ${ent.endpoints} endpoint(s)`);
    }

    // Normalise BYO storage vs. legacy flat dataPath into one descriptor. For a fully-
    // managed endpoint there is no BYO storage: the data_path is a marker (the R2 faucet
    // sets the real s3://<org-bucket>/<datalakeId>/ path at gateway boot).
    // A quackboard has no DuckLake and no object store — it IS its own durable DuckDB,
    // persisted to R2 by the data plane. It needs no catalog provisioning or storage creds.
    const isQb = input.kind === 'quackboard';
    const storage = input.storage ?? {
      dataPath: isQb ? 'quackboard' : input.managed ? 'managed-r2' : input.dataPath!,
      provider: 'config' as const,
      region: input.region,
      urlStyle: 'path' as const,
      useSsl: false,
      keyId: undefined,
      secret: undefined,
      sessionToken: undefined,
      endpoint: undefined,
    };
    const storageRegion = storage.region ?? input.region;
    // The catalog is ALWAYS a managed Neon catalog (per-org project + per-datalake metadata
    // schema) unless the caller brings their own DSN. The `managed` flag only selects STORAGE
    // (the R2 faucet bucket vs a BYO bucket) — never the catalog. (managed-local is retired:
    // a local DuckLake file is not durable on the data plane.)
    const catalogMode = isQb ? null : input.catalogDsn ? 'byo-postgres' : 'managed-postgres';
    // Per-datalake metadata schema inside the org's shared Neon catalog (managed-postgres only).
    const catalogSchema = catalogMode === 'managed-postgres' ? `dl_${input.slug.replace(/-/g, '_')}` : null;

    // Auto-provision the org's Neon catalog for any managed-postgres datalake — BYO storage or
    // managed, it still needs a durable catalog (idempotent; Neon returns the DSN synchronously).
    if (catalogMode === 'managed-postgres') {
      const slugRow = await queryOne<{ slug: string }>(`SELECT slug FROM "organization" WHERE id = $1`, [caller.orgId]);
      const slug = slugRow?.slug ?? caller.orgId;
      try {
        await provisionOrgCatalog(c.env, caller.orgId, slug);
      } catch {
        // best-effort: an already-provisioned catalog (or transient API hiccup) is fine;
        // connect re-checks readiness via getOrgCatalogDsn.
      }
    }

    const serverToken = `srv_${crypto.randomUUID().replace(/-/g, '')}`;
    try {
      const created = await withTransaction(async (q) => {
        // catalog_dsn kept non-secret ('' = see secret store) — matches the original.
        const row = await q<{ id: string; status: string }>(
          `INSERT INTO waddling.datalake
             (org_id, name, slug, catalog_dsn, data_path, region, encrypted, server_token, status,
              storage_provider, storage_endpoint, storage_region, storage_url_style, storage_use_ssl,
              catalog_mode, catalog_schema, kind)
           VALUES ($1,$2,$3,'',$4,$5,$6,$7,'provisioning',$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, status`,
          [
            caller.orgId,
            input.name,
            input.slug,
            storage.dataPath,
            input.region,
            input.encrypted,
            serverToken,
            storage.provider,
            storage.endpoint ?? '',
            storageRegion,
            storage.urlStyle,
            storage.useSsl,
            catalogMode,
            catalogSchema,
            input.kind,
          ],
        );
        const datalakeId = row.rows[0]!.id;

        // Encrypt + store credentials (never written to plaintext columns). The
        // seal+INSERT is inlined here (matching the original) and runs on the
        // TRANSACTION client `q`, NOT putEndpointSecret — that lib seam uses the
        // module-level pool, a different connection that can't see the still-
        // uncommitted endpoint row, so datalake_secret's FK to endpoint(id)
        // (migration 005) would fail. Same getCrypto() seal as putEndpointSecret.
        if (storage.provider === 'config' && storage.keyId && storage.secret) {
          const creds: StorageCreds = {
            keyId: storage.keyId,
            secret: storage.secret,
            sessionToken: storage.sessionToken,
          };
          const s = getCrypto().sealJson(creds);
          await q(
            `INSERT INTO waddling.datalake_secret (datalake_id, kind, iv, auth_tag, ciphertext)
               VALUES ($1,'storage',$2,$3,$4)`,
            [datalakeId, s.iv, s.authTag, s.ciphertext],
          );
        }
        if (input.catalogDsn) {
          const creds: CatalogCreds = { dsn: input.catalogDsn };
          const s = getCrypto().sealJson(creds);
          await q(
            `INSERT INTO waddling.datalake_secret (datalake_id, kind, iv, auth_tag, ciphertext)
               VALUES ($1,'catalog',$2,$3,$4)`,
            [datalakeId, s.iv, s.authTag, s.ciphertext],
          );
        }

        return row.rows[0]!;
      });

      return ok(c, { datalakeId: created.id, status: created.status }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return err(c, 'slug_taken', 409, 'An endpoint with that slug already exists');
      }
      throw e;
    }
  }),
);

// ── /api/cp/endpoints/:id — endpoint detail + status (§4b endpoint_status) ───────
//
// GET    → endpoint detail + live gateway status (best-effort).
// PATCH  → update mutable fields (name, status, gateway runtime fields).
// DELETE → remove the endpoint (cascades acl_rule / agent_session).

interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  status: DatalakeStatus['status'];
  server_token: string;
  data_path: string;
  region: string;
}

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['provisioning', 'running', 'stopped', 'error']).optional(),
});

async function loadOwned(id: string, orgId: string): Promise<EndpointRow | null> {
  const ep = await queryOne<EndpointRow>(
    `SELECT id, org_id, name, slug, status, server_token, data_path, region
       FROM waddling.datalake WHERE id = $1`,
    [id],
  );
  if (!ep) return null;
  assertOrg({ kind: 'user', orgId, callerId: '' }, ep.org_id);
  return ep;
}

datalakes.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'endpoint_not_found', 404);

    // Gateway RUNTIME state from the pool — derived live, WITHOUT waking a sleeping pool
    // (the pool's status() reads director state only). Lifecycle status (provisioning/
    // error) wins; otherwise surface the pool's live state (running/asleep/unconfigured).
    let runtime: DatalakeRuntime;
    if (ep.status === 'provisioning' || ep.status === 'error') {
      runtime = { state: ep.status, replicas: 0 };
    } else {
      try {
        const s = await gatewayClientFor(ep).status(ep.id);
        runtime = { state: s.state, replicas: s.replicas };
      } catch {
        // pool unreachable — report unconfigured rather than failing the page
        runtime = { state: 'unconfigured', replicas: 0 };
      }
    }

    const status: DatalakeStatus = { datalakeId: ep.id, status: ep.status, runtime };
    // The dashboard's camelCase DatalakeDetail. NOTE: never send server_token to the browser.
    const datalake: DatalakeDetail = {
      id: ep.id,
      name: ep.name,
      slug: ep.slug,
      status: ep.status,
      dataPath: ep.data_path,
      region: ep.region,
      runtime,
    };
    return ok(c, { datalake, status });
  }),
);

datalakes.patch('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'endpoint_not_found', 404);
    const patch = await parseBody(c, PatchSchema);

    await query(
      `UPDATE waddling.datalake
          SET name = COALESCE($2, name),
              status = COALESCE($3, status),
              updated_at = now()
        WHERE id = $1`,
      [id, patch.name ?? null, patch.status ?? null],
    );
    return ok(c, { success: true });
  }),
);

datalakes.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'datalake_not_found', 404);
    await query(`DELETE FROM waddling.datalake WHERE id = $1`, [id]);
    return ok(c, { success: true });
  }),
);

// POST /:id/teardown-gateways — operator cutover: destroy this datalake's gateway pool
// (and any abandoned legacy static gateway DO). Mirrors DELETE's owner auth. The gateway
// compute is ephemeral, so this is safe — the next agent query lazily re-creates + re-arms
// a fresh replica from the current snapshot.
datalakes.post('/:id/teardown-gateways', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'datalake_not_found', 404);
    const result = await gatewayClientFor(ep).teardownGateways(id);
    return ok(c, result);
  }),
);

// ── /api/cp/endpoints/:id/describe — governed schema introspection ───────────────
//
// GET ?agentId=&schema=&table= → the tables + columns + types the given agent is
// allowed to see. Compiles the agent's ACL → granted tables, asks the gateway to
// introspect those tables, then INTERSECTS (the non-leak guarantee: never reveal a
// table/column the agent could not query). Agent (api-key) callers describe
// themselves; dashboard users pass ?agentId to run-as a chosen agent.

interface DescribeEndpointRow {
  id: string;
  org_id: string;
  status: string;
  server_token: string;
}

datalakes.get('/:id/describe', (c) =>
  handle(c, async () => {
    // Data-plane read (waddling_describe) — allow delegated OAuth/MCP callers.
    const caller = await resolveCaller(c, true, true);
    const datalakeId = c.req.param('id');
    const u = new URL(c.req.url);
    const schemaFilter = u.searchParams.get('schema');
    const tableFilter = u.searchParams.get('table');

    // Agent identity: api-key callers describe themselves; users pass ?agentId.
    const agentId = caller.agentId ?? u.searchParams.get('agentId') ?? undefined;
    if (!agentId) {
      return err(c, 'agent_required', 400, 'describe requires an agentId to run as');
    }

    const endpoint = await queryOne<DescribeEndpointRow>(
      `SELECT id, org_id, status, server_token
         FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!endpoint) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, endpoint.org_id);

    // Org-scope the target agent for run-as (tenant isolation).
    if (!caller.agentId) {
      const target = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [agentId],
      );
      if (!target) return err(c, 'agent_not_found', 404);
      assertOrg(caller, target.org_id);
    }

    // Compile the agent's grants (tables + per-table column allow-lists).
    const ruleRows = await query<AclRuleRow>(
      `SELECT * FROM waddling.acl_rule
        WHERE datalake_id = $1 AND (agent_id = $2 OR agent_id IS NULL)`,
      [datalakeId, agentId],
    );
    const compiled = compilePolicy(ruleRows.rows, new Date());
    const granted = grantsForAgent(compiled, agentId);
    if (granted.tables.length === 0) {
      return ok<DescribeResult>(c, { datalakeId, tables: [] });
    }
    if (endpoint.status !== 'running') {
      // Can't introspect a stopped gateway; grants are known but types aren't.
      return ok<DescribeResult>(c, { datalakeId, tables: [] });
    }

    // Ask the gateway for columns/types of just the granted tables.
    // e2e-gated on Stage D gateway reachability — GATEWAY_INTERNAL_URL is a
    // localhost placeholder unreachable from workerd until the gateway lands on
    // a CF Container/Durable Object. A failed probe degrades to no-schema so it
    // never breaks the editor (the original swallowed GatewayError identically).
    let described: { tables: { schema: string; table: string; columns: { name: string; type: string; nullable?: boolean }[] }[] };
    try {
      described = await gatewayClientFor(endpoint).describe(
        granted.tables.map((t) => ({ schema: t.schema, table: t.table })),
      );
    } catch (e) {
      if (e instanceof GatewayError) return ok<DescribeResult>(c, { datalakeId, tables: [] });
      throw e;
    }

    const describedByRef = new Map(
      described.tables.map((t) => [`${t.schema}.${t.table}`.toLowerCase(), t]),
    );

    // Intersect introspected columns with the grant (non-leak guarantee).
    const tables: TableInfo[] = [];
    for (const g of granted.tables) {
      if (schemaFilter && g.schema !== schemaFilter) continue;
      if (tableFilter && g.table !== tableFilter) continue;
      const d = describedByRef.get(`${g.schema}.${g.table}`.toLowerCase());
      if (!d) continue; // granted but not present in the lake — omit
      // Allow-list defined ⇒ keep only those columns; undefined ⇒ all columns.
      const allow = g.columns ? new Set(g.columns.map((col) => col.toLowerCase())) : null;
      const columns = (allow ? d.columns.filter((col) => allow.has(col.name.toLowerCase())) : d.columns).map(
        (col) => ({ name: col.name, type: col.type, nullable: col.nullable }),
      );
      tables.push({ schema: g.schema, table: g.table, columns });
    }

    return ok<DescribeResult>(c, { datalakeId, tables });
  }),
);

// ── /api/cp/endpoints/:id/provision — LOCAL/DEV provisioning stand-in ────────────
//
// Production endpoint boot (the gateway container/port pool/DNS) is the Stage D
// deployment workstream and is intentionally NOT built here. This route closes the
// local UX loop: it resolves the endpoint's stored credentials through
// getDatalakeGatewayConfig (proving the encrypted BYO storage creds + managed
// catalog decrypt into a valid gateway config), then marks the endpoint `running`
// with a localhost gateway address so the dashboard provisioning poll completes. It
// does NOT call the gateway and does NOT start a real gateway process.
//
// SECURITY NOTE: the original gated this on getNodeEnv()==='production' (default
// 'development' ⇒ ENABLED). workerd has no NODE_ENV, so the guard reads
// c.env.WADDLING_ENV; preserving the original default means the route is OPEN
// unless WADDLING_ENV is explicitly 'production'. Set WADDLING_ENV=production in
// the deployed Worker so this dev stand-in can never flip prod endpoints green.

datalakes.post('/:id/provision', (c) =>
  handle(c, async () => {
    if (c.env.WADDLING_ENV === 'production') {
      return err(c, 'not_available', 403, 'Dev provisioning is disabled in production (Stage D owns boot)');
    }
    const caller = await resolveCaller(c);
    const id = c.req.param('id');

    const owned = await queryOne<{ org_id: string; status: string }>(
      `SELECT org_id, status FROM waddling.datalake WHERE id = $1`,
      [id],
    );
    if (!owned) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, owned.org_id);

    // Resolve + validate stored credentials (decrypts BYO storage / catalog).
    const cfg = await getDatalakeGatewayConfig(id);
    if (!cfg) return err(c, 'endpoint_not_found', 404);
    if (!cfg.localData && cfg.s3?.provider === 'config' && !cfg.s3.secret) {
      return err(c, 'missing_storage_secret', 422, 'Object-store credentials did not resolve');
    }

    await query(
      `UPDATE waddling.datalake SET status = 'running', updated_at = now() WHERE id = $1`,
      [id],
    );

    // Echo the resolved config WITHOUT secrets, so a developer can confirm the
    // credential plumbing without exposing keys to the browser. The gateway is now a
    // dynamic pool (no fixed host:port) — provisioning just flips the lifecycle status.
    return ok(c, {
      status: 'running',
      resolved: {
        dataPath: cfg.ducklakeDataPath,
        localData: cfg.localData,
        catalogMode: cfg.ducklakeCatalogFile ? 'managed-local' : 'byo-postgres',
        storage: cfg.s3
          ? {
              provider: cfg.s3.provider,
              endpoint: cfg.s3.endpoint,
              region: cfg.s3.region,
              urlStyle: cfg.s3.urlStyle,
              useSsl: cfg.s3.useSsl,
              hasCredentials: Boolean(cfg.s3.secret),
            }
          : null,
      },
    });
  }),
);

/**
 * POST /:id/seed-hn — trusted data load: index the top HN stories from the last `days`
 * into the endpoint's real lake. Resolves the boot config (faucet creds + catalog) and
 * hands it to the data plane, which boots the gateway and runs the loader on its trusted
 * connection (parquet → R2). Agents only READ the result via the birdshot-gated path.
 */
datalakes.post('/:id/seed-hn', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [id],
    );
    if (!ep || ep.org_id !== caller.orgId) return err(c, 'endpoint_not_found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { days?: number; limit?: number };

    let boot;
    try {
      boot = await resolveGatewayBoot(c.env, id);
    } catch (e) {
      if (e instanceof CatalogNotReadyError) return err(c, 'catalog_provisioning', 503, e.message);
      if (e instanceof StorageNotReadyError) return err(c, 'storage_unavailable', 503, e.message);
      throw e;
    }
    if (!boot.gatewayBoot) return err(c, 'no_real_lake', 409, 'endpoint has no managed/real lake to load into');

    const res = await c.env.DATAPLANE.fetch('https://dataplane/lakeload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        datalakeId: id,
        gatewayBoot: boot.gatewayBoot,
        days: body.days ?? 30,
        limit: body.limit ?? 1000,
      }),
    });
    const json = (await res.json().catch(() => ({ error: 'non-json data-plane response' }))) as Record<string, unknown>;
    return c.json(json, res.status as 200);
  }),
);

export { datalakes };
