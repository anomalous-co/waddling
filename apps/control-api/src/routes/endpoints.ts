/**
 * /api/cp/endpoints — Hono port of apps/waddling/src/app/api/cp/endpoints/route.ts.
 *
 * GET  → list this org's endpoints (EndpointSummary[]).
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
import { getEndpointGatewayConfig } from '../lib/endpoint-secrets';
import type { StorageCreds, CatalogCreds } from '../lib/endpoint-secrets';
import { getCrypto } from '../lib/secret-crypto';
import { gatewayClientFor, GatewayError } from '../lib/gateway-client';
import { compilePolicy, grantsForAgent, type AclRuleRow } from '../lib/policy-compiler';
import type { DescribeResult, TableInfo, EndpointStatus, EndpointSummary } from '../lib/types';

// Endpoint status domain (canonical: lib/types EndpointSummary['status']). The full
// types module is now ported, so this route uses the shared types directly (B2's
// inline EndpointStatus/EndpointSummary placeholders are reconciled away). New rows
// are created 'provisioning'; gateway boot flips them to 'running' later.
type EndpointStatusName = EndpointSummary['status'];

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
  })
  .refine((d) => !!d.storage || !!d.dataPath, {
    message: 'storage is required',
    path: ['storage'],
  });

const endpoints = new Hono<{ Bindings: Env }>();

// GET — list this org's endpoints. Faithful full port: passes (requireOrg=true,
// allowDelegated=true) because this is a data-plane read (the MCP waddling_list_
// endpoints tool) and the original deliberately permits delegated OAuth/MCP callers.
endpoints.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, true, true);
    const rows = await query<{
      id: string;
      name: string;
      slug: string;
      status: EndpointStatusName;
    }>(
      `SELECT id, name, slug, status FROM waddling.endpoint
        WHERE org_id = $1 ORDER BY created_at ASC`,
      [caller.orgId],
    );
    const list: EndpointSummary[] = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
    }));
    return ok(c, { endpoints: list });
  }),
);

// POST — create an endpoint row (status 'provisioning'); gateway boot is Stage D.
//
// Reconciled from the B2 minimal create: the plan-quota gate (getEntitlements) and
// the credential sealing (getCrypto().sealJson → waddling.endpoint_secret) are now
// wired, since lib/entitlements + lib/secret-crypto are ported. The insert + secret
// writes run in ONE transaction (matching the original's withTransaction) — the seal
// + INSERT is inlined on the txn client rather than calling putEndpointSecret, which
// would run on a separate pool connection and trip endpoint_secret's FK (see below).
//
// Still deferred (no lib seam in control-api yet):
//   - the managed-local catalog_file path assignment used getLocalLakeDir(), which
//     control-api's env.ts does not expose — gateway/workspace provisioning (Stage C)
//     owns the workspace/catalog file layout, so the catalog_file UPDATE stays out.
//   - PostHog telemetry (posthog-node) does not bundle/run on workerd — neutered
//     (mirrors lib/agent-identity's guarded no-op pattern); no event is emitted.
endpoints.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, CreateSchema);

    // Quota check (plan entitlement gate).
    const ent = await getEntitlements(caller.orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.endpoint WHERE org_id = $1`,
      [caller.orgId],
    );
    if (Number(count?.n ?? 0) >= ent.endpoints) {
      return err(c, 'endpoint_quota_exceeded', 402, `Plan allows ${ent.endpoints} endpoint(s)`);
    }

    // Normalise BYO storage vs. legacy flat dataPath into one descriptor.
    const storage = input.storage ?? {
      dataPath: input.dataPath!,
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
    // Managed catalog ⇒ local DuckLake file (production uses a postgres catalog).
    const catalogMode = input.catalogDsn ? 'byo-postgres' : 'managed-local';

    const serverToken = `srv_${crypto.randomUUID().replace(/-/g, '')}`;
    try {
      const created = await withTransaction(async (q) => {
        // catalog_dsn kept non-secret ('' = see secret store) — matches the original.
        const row = await q<{ id: string; status: string }>(
          `INSERT INTO waddling.endpoint
             (org_id, name, slug, catalog_dsn, data_path, region, encrypted, server_token, status,
              storage_provider, storage_endpoint, storage_region, storage_url_style, storage_use_ssl,
              catalog_mode)
           VALUES ($1,$2,$3,'',$4,$5,$6,$7,'provisioning',$8,$9,$10,$11,$12,$13)
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
          ],
        );
        const endpointId = row.rows[0]!.id;

        // Encrypt + store credentials (never written to plaintext columns). The
        // seal+INSERT is inlined here (matching the original) and runs on the
        // TRANSACTION client `q`, NOT putEndpointSecret — that lib seam uses the
        // module-level pool, a different connection that can't see the still-
        // uncommitted endpoint row, so endpoint_secret's FK to endpoint(id)
        // (migration 005) would fail. Same getCrypto() seal as putEndpointSecret.
        if (storage.provider === 'config' && storage.keyId && storage.secret) {
          const creds: StorageCreds = {
            keyId: storage.keyId,
            secret: storage.secret,
            sessionToken: storage.sessionToken,
          };
          const s = getCrypto().sealJson(creds);
          await q(
            `INSERT INTO waddling.endpoint_secret (endpoint_id, kind, iv, auth_tag, ciphertext)
               VALUES ($1,'storage',$2,$3,$4)`,
            [endpointId, s.iv, s.authTag, s.ciphertext],
          );
        }
        if (input.catalogDsn) {
          const creds: CatalogCreds = { dsn: input.catalogDsn };
          const s = getCrypto().sealJson(creds);
          await q(
            `INSERT INTO waddling.endpoint_secret (endpoint_id, kind, iv, auth_tag, ciphertext)
               VALUES ($1,'catalog',$2,$3,$4)`,
            [endpointId, s.iv, s.authTag, s.ciphertext],
          );
        }

        return row.rows[0]!;
      });

      return ok(c, { endpointId: created.id, status: created.status }, 201);
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
  status: EndpointStatus['status'];
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
  data_path: string;
  region: string;
}

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['provisioning', 'running', 'stopped', 'error']).optional(),
  gatewayHost: z.string().optional(),
  quackPort: z.number().int().optional(),
});

async function loadOwned(id: string, orgId: string): Promise<EndpointRow | null> {
  const ep = await queryOne<EndpointRow>(
    `SELECT id, org_id, name, slug, status, gateway_host, quack_port, server_token, data_path, region
       FROM waddling.endpoint WHERE id = $1`,
    [id],
  );
  if (!ep) return null;
  assertOrg({ kind: 'user', orgId, callerId: '' }, ep.org_id);
  return ep;
}

endpoints.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'endpoint_not_found', 404);

    let birdshotStatus: EndpointStatus['birdshotStatus'];
    let snapshotLag: number | undefined;
    if (ep.status === 'running') {
      try {
        // e2e-gated on Stage D gateway reachability — GATEWAY_INTERNAL_URL is a
        // localhost placeholder unreachable from workerd until the gateway moves
        // to a CF Container/Durable Object. Best-effort: a failure degrades to
        // status-without-live-health (the original swallowed it the same way).
        const s = await gatewayClientFor(ep).status(ep.id);
        birdshotStatus = {
          authMode: s.authMode,
          policySize: s.policySize,
          sessionCount: s.sessionCount,
          auditRingDepth: s.auditRingDepth,
        };
        snapshotLag = s.snapshotLag;
      } catch {
        // gateway unreachable — report status without live health
      }
    }

    const status: EndpointStatus = {
      endpointId: ep.id,
      status: ep.status,
      gatewayHost: ep.gateway_host ?? undefined,
      quackPort: ep.quack_port ?? undefined,
      birdshotStatus,
      duckLakeSnapshotLag: snapshotLag,
    };
    // Map to the dashboard's camelCase EndpointDetail and merge live status.
    // NOTE: never send server_token to the browser.
    const endpoint = {
      id: ep.id,
      name: ep.name,
      slug: ep.slug,
      status: ep.status,
      gatewayHost: ep.gateway_host ?? undefined,
      quackPort: ep.quack_port ?? undefined,
      dataPath: ep.data_path,
      region: ep.region,
      birdshotStatus,
      duckLakeSnapshotLag: snapshotLag,
    };
    return ok(c, { endpoint, status });
  }),
);

endpoints.patch('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'endpoint_not_found', 404);
    const patch = await parseBody(c, PatchSchema);

    await query(
      `UPDATE waddling.endpoint
          SET name = COALESCE($2, name),
              status = COALESCE($3, status),
              gateway_host = COALESCE($4, gateway_host),
              quack_port = COALESCE($5, quack_port),
              updated_at = now()
        WHERE id = $1`,
      [id, patch.name ?? null, patch.status ?? null, patch.gatewayHost ?? null, patch.quackPort ?? null],
    );
    return ok(c, { success: true });
  }),
);

endpoints.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'endpoint_not_found', 404);
    await query(`DELETE FROM waddling.endpoint WHERE id = $1`, [id]);
    return ok(c, { success: true });
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
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
}

endpoints.get('/:id/describe', (c) =>
  handle(c, async () => {
    // Data-plane read (waddling_describe) — allow delegated OAuth/MCP callers.
    const caller = await resolveCaller(c, true, true);
    const endpointId = c.req.param('id');
    const u = new URL(c.req.url);
    const schemaFilter = u.searchParams.get('schema');
    const tableFilter = u.searchParams.get('table');

    // Agent identity: api-key callers describe themselves; users pass ?agentId.
    const agentId = caller.agentId ?? u.searchParams.get('agentId') ?? undefined;
    if (!agentId) {
      return err(c, 'agent_required', 400, 'describe requires an agentId to run as');
    }

    const endpoint = await queryOne<DescribeEndpointRow>(
      `SELECT id, org_id, status, gateway_host, quack_port, server_token
         FROM waddling.endpoint WHERE id = $1`,
      [endpointId],
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
        WHERE endpoint_id = $1 AND (agent_id = $2 OR agent_id IS NULL)`,
      [endpointId, agentId],
    );
    const compiled = compilePolicy(ruleRows.rows, new Date());
    const granted = grantsForAgent(compiled, agentId);
    if (granted.tables.length === 0) {
      return ok<DescribeResult>(c, { endpointId, tables: [] });
    }
    if (endpoint.status !== 'running') {
      // Can't introspect a stopped gateway; grants are known but types aren't.
      return ok<DescribeResult>(c, { endpointId, tables: [] });
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
      if (e instanceof GatewayError) return ok<DescribeResult>(c, { endpointId, tables: [] });
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

    return ok<DescribeResult>(c, { endpointId, tables });
  }),
);

// ── /api/cp/endpoints/:id/provision — LOCAL/DEV provisioning stand-in ────────────
//
// Production endpoint boot (the gateway container/port pool/DNS) is the Stage D
// deployment workstream and is intentionally NOT built here. This route closes the
// local UX loop: it resolves the endpoint's stored credentials through
// getEndpointGatewayConfig (proving the encrypted BYO storage creds + managed
// catalog decrypt into a valid gateway config), then marks the endpoint `running`
// with a localhost gateway address so the dashboard provisioning poll completes. It
// does NOT call the gateway and does NOT start a real gateway process.
//
// SECURITY NOTE: the original gated this on getNodeEnv()==='production' (default
// 'development' ⇒ ENABLED). workerd has no NODE_ENV, so the guard reads
// c.env.WADDLING_ENV; preserving the original default means the route is OPEN
// unless WADDLING_ENV is explicitly 'production'. Set WADDLING_ENV=production in
// the deployed Worker so this dev stand-in can never flip prod endpoints green.

const LOCAL_GATEWAY_HOST = 'localhost';
const LOCAL_QUACK_PORT = 9500;

endpoints.post('/:id/provision', (c) =>
  handle(c, async () => {
    if (c.env.WADDLING_ENV === 'production') {
      return err(c, 'not_available', 403, 'Dev provisioning is disabled in production (Stage D owns boot)');
    }
    const caller = await resolveCaller(c);
    const id = c.req.param('id');

    const owned = await queryOne<{ org_id: string; status: string }>(
      `SELECT org_id, status FROM waddling.endpoint WHERE id = $1`,
      [id],
    );
    if (!owned) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, owned.org_id);

    // Resolve + validate stored credentials (decrypts BYO storage / catalog).
    const cfg = await getEndpointGatewayConfig(id);
    if (!cfg) return err(c, 'endpoint_not_found', 404);
    if (!cfg.localData && cfg.s3?.provider === 'config' && !cfg.s3.secret) {
      return err(c, 'missing_storage_secret', 422, 'Object-store credentials did not resolve');
    }

    await query(
      `UPDATE waddling.endpoint
          SET status = 'running', gateway_host = $2, quack_port = $3, updated_at = now()
        WHERE id = $1`,
      [id, LOCAL_GATEWAY_HOST, LOCAL_QUACK_PORT],
    );

    // Echo the resolved config WITHOUT secrets, so a developer can confirm the
    // credential plumbing without exposing keys to the browser.
    return ok(c, {
      status: 'running',
      gatewayHost: LOCAL_GATEWAY_HOST,
      quackPort: LOCAL_QUACK_PORT,
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

export { endpoints };
