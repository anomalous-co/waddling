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
import { makePostHog } from '../lib/posthog';
import { getEntitlements } from '../lib/entitlements';
import { getDatalakeGatewayConfig } from '../lib/datalake-secrets';
import type { StorageCreds, CatalogCreds } from '../lib/datalake-secrets';
import { getCrypto } from '../lib/secret-crypto';
import { gatewayClientFor, GatewayError } from '../lib/gateway-client';
import { getCachedCatalog, refreshCatalog } from '../lib/catalog-cache';
import { recompileAndPush } from '../lib/gateway-push';
import { grantsForKey, agentSubject, listStatements, epochFor } from '../lib/grant-store';
import { authVersionFor, bumpPolicyVersion } from '../lib/policy-version';
import { loadSigningKey } from '../lib/session-jwt';
import { provisionOrgCatalog } from '../lib/catalog-provision';
import { provisionGateway, provisionQuackboard, type ProvisionableDatalake } from '../lib/provisioner';
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
      // Exclude quackboards: they are a distinct kind (a catalog-less coordination
      // board), not a governed data lake, and must not surface in any lake list — a
      // quackboard row has no DuckLake catalog, so rendering it as a selectable lake
      // (lake index, connect-agent wizard) would offer a broken target. IS DISTINCT
      // FROM is null-safe; the column is NOT NULL DEFAULT 'lake', but future-proof.
      `SELECT id, name, slug, status FROM waddling.datalake
        WHERE org_id = $1 AND kind IS DISTINCT FROM 'quackboard' ORDER BY created_at ASC`,
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

        // Activate immediately (provisioning → running). The gateway is now a lazy-boot
        // dynamic pool (it boots on the first connect's snapshot push and scales back to
        // zero when idle), and the managed catalog was provisioned synchronously above —
        // so there is no async Stage-D step left for 'provisioning' to gate on. The dev
        // /provision stand-in that used to flip this is 403 in production, and onboarding
        // does the same one-line activation for its demo lake; without this, a lake created
        // via "+ new datalake" sits in 'provisioning' forever. connect re-checks catalog
        // readiness, so this is safe even if the best-effort provisionOrgCatalog above hiccupped.
        await q(`UPDATE waddling.datalake SET status = 'running', updated_at = now() WHERE id = $1`, [datalakeId]);
        return { id: datalakeId, status: 'running' as const };
      });

      // Deploy this datalake's OWN private Cloud Run gateway (gw-<slug>, max=1) via the provisioner
      // and record its URL, so control-api targets it for snapshot pushes / revocations. Runs after
      // the row commits (the deploy is ~30-60s and needs the catalog ready). Best-effort: on failure
      // the datalake is still 'running' and POST /:id/provision re-attempts; connect fails clearly
      // until the gateway exists. Unset PROVISIONER_URL ⇒ legacy single-gateway (GATEWAY_BASE_URL).
      if (c.env.PROVISIONER_URL) {
        try {
          const dlRow = await queryOne<ProvisionableDatalake>(
            `SELECT id, org_id, slug, server_token, catalog_schema, catalog_mode, encrypted
               FROM waddling.datalake WHERE id = $1`,
            [created.id],
          );
          if (dlRow) {
            // A quackboard row has no catalog DSN, so provisionGateway would throw resolving one.
            // Provision the per-org QB gateway (QUACKBOARD=1 mode) instead; both return { url }.
            const { url } = isQb
              ? await provisionQuackboard(c.env, {
                  slug: dlRow.slug,
                  orgId: dlRow.org_id,
                  serverToken: dlRow.server_token,
                })
              : await provisionGateway(c.env, dlRow);
            await query(`UPDATE waddling.datalake SET gateway_url = $1 WHERE id = $2`, [url, created.id]);
          }
        } catch (e) {
          console.log(`[datalake create] gateway provisioning failed for ${created.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Provisioning funnel: a new endpoint/datalake was created. Server-side,
      // fire-and-forget via waitUntil; no-op when POSTHOG_KEY is unset.
      makePostHog(c.env, c.executionCtx).capture({
        distinctId: caller.callerId,
        event: 'endpoint_created',
        properties: { region: input.region, encrypted: input.encrypted, kind: input.kind },
        groups: { organization: caller.orgId },
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
  gateway_url: string | null;
}

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['provisioning', 'running', 'stopped', 'error']).optional(),
});

async function loadOwned(id: string, orgId: string): Promise<EndpointRow | null> {
  const ep = await queryOne<EndpointRow>(
    `SELECT id, org_id, name, slug, status, server_token, data_path, region, gateway_url
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

// ── POST /:id/refresh-policy — on-demand recompile + push (admin recovery lever) ──
//
// Recompiles the FULL endpoint policy (every agent) from waddling.acl_rule and
// pushes it to the gateway control channel. This is the recovery lever for the two
// cases where a gateway's cached snapshot goes stale and a normal reconnect can't
// fix it (Step 1 of the gateway-lifecycle plan):
//   1. Direct DB edits to waddling.acl_rule bypass recompileAndPush (e.g. a manual
//      SQL fix), so the gateway's cached snapshot diverges from the rules table.
//   2. Reconnecting a LOCKED workspace fails (lock_configuration is immutable
//      post-init), so there is no way to force a fresh push through connect.
//
// Org-scoped (any caller that owns the datalake — agent API key OR dashboard user),
// matching teardown-gateways. This is NOT an escalation: the pushed snapshot is
// compiled from acl_rule rows the caller cannot write, so an agent re-pushing the
// truth gains nothing it did not already have. Making it agent-key-callable is what
// unblocks the CLI recovery path (no browser session available).
//
// Unlike the push on ACL CRUD (best-effort, swallows gateway errors), this route
// surfaces push failures as 502 so the caller knows whether the snapshot landed.
datalakes.post('/:id/refresh-policy', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'datalake_not_found', 404);

    // surfacePushError so a failed gateway push surfaces as 502 instead of being
    // swallowed (best-effort is correct for the CRUD path, wrong for an explicit
    // recovery action).
    let compiled;
    try {
      compiled = await recompileAndPush(c, id, { surfacePushError: true });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await query(
        `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
         VALUES ($1,'control-plane','refresh_policy',$2,'deny',$3,$4)`,
        [caller.orgId, id, `push failed: ${detail}`, caller.callerId],
      );
      return err(c, 'policy_push_failed', 502, detail);
    }

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
       VALUES ($1,'control-plane','refresh_policy',$2,'allow',$3,$4)`,
      [
        caller.orgId,
        id,
        `pushed=${compiled.pushed ?? false} epoch=${compiled.epoch ?? 0}`,
        caller.callerId,
      ],
    );

    // Config-only re-arm (spec §13): grants live in the store; nothing compiled here. `epoch`
    // is the datalake's grant-store version (the freshness signal birdshot re-reads).
    return ok(c, {
      datalakeId: id,
      pushed: compiled.pushed ?? false,
      pushSkipped: compiled.pushSkipped ?? false,
      pushError: compiled.pushError,
      epoch: compiled.epoch ?? 0,
    });
  }),
);

// ── GET /:id/policy — versioned compiled policy (Step 9, the dynamic-ACL keystone) ──
//
// Returns the endpoint's FULL compiled birdshot snapshot (every agent) PLUS a stable
// content-hash `version` (grantVersion-authVersion). This is what the GatewayPoolDO
// refresh alarm (Step 11) polls: it fetches this endpoint, compares `version` to the
// last-applied version, and re-applies the snapshot ONLY when it changed. So ACL
// edits (even direct DB edits that bypassed recompileAndPush) propagate within the
// alarm interval — with zero birdshot C++ changes and no per-query Postgres coupling.
//
// The `version` mixes grants + the JWKS kid/n/e so JWKS rotation re-pushes too (a new
// signing key would leave the gateway rejecting JWTs signed by the new kid). Org-scoped
// (agent key OR dashboard user) — read-only, no escalation: it only returns what the
// caller's own grants are compiled from. `?includeJwks=true` exposes the public JWK
// (kid/n/e only — never the private key) so the alarm can re-arm a cold gateway.
datalakes.get('/:id/policy', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, true, true);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'datalake_not_found', 404);

    const u = new URL(c.req.url);
    const includeJwks = u.searchParams.get('includeJwks') === 'true';

    // Pull-model (spec §13): the "policy" is the datalake's literal GRANT/DENY SQL statements
    // (rendered verbatim by the UI) + a `version` = the store epoch mixed with the JWKS version.
    const statements = await listStatements(id);
    const epoch = await epochFor(id);

    // Load the current signing key (kid/n/e) for the auth version + the optional
    // includeJwks payload. Best-effort: a missing JWKS (jwt plugin not yet minted)
    // yields authVersion='no-jwks' and no jwks field — the alarm treats that as
    // "unarmed" and re-pushes once a key exists.
    let jwks: { kid: string; n: string; e: string } | undefined;
    try {
      const sk = await loadSigningKey();
      jwks = { kid: sk.kid, n: sk.publicJwk.n, e: sk.publicJwk.e };
    } catch {
      /* jwt plugin not initialized — jwks stays undefined */
    }
    const jwksArr = jwks ? [jwks] : undefined;

    // Bump the cached policy_version column (migration 013) so the refresh alarm can poll one
    // column. The grant version IS the store epoch now (a mutation bumps it in the same txn).
    const version = await bumpPolicyVersion(id, epoch, jwksArr);
    return ok(c, {
      datalakeId: id,
      version,
      grantVersion: String(epoch),
      authVersion: authVersionFor(jwksArr),
      compiledAt: new Date().toISOString(),
      auth: jwks
        ? { issuer: c.env.JWT_ISSUER, audience: `gw:${id}`, mode: 'rs256' as const }
        : undefined,
      jwks: includeJwks ? jwksArr : undefined,
      statements: statements.map((s) => ({ id: s.id, granteeKind: s.grantee_kind, grantee: s.grantee, stmt: s.stmt, version: Number(s.version) })),
      epoch,
    });
  }),
);

// ── GET /:id/replicas — per-replica pool status (Step 8 dashboard + Step 4 read path) ──
// Returns the director's view of every replica (index, appliedVersion vs current,
// lastActiveAt, inFlight, warm). Does NOT wake any container. Org-scoped (agent key
// OR dashboard user), like teardown-gateways — read-only, no escalation.
datalakes.get('/:id/replicas', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'datalake_not_found', 404);
    const result = await gatewayClientFor(ep).replicaStatus(id);
    return ok(c, result);
  }),
);

// ── POST /:id/reset-pool + /:id/clear-snapshot — pool-director reset (Step 4) ──────
// resetPool: drop the cached snapshot + zero currentVersion → fail-closed (pickReplica
//   refuses) until the next /gw/snapshot. Recovers a corrupt pushed snapshot by forcing
//   a clean re-push from the control plane.
// clearSnapshot: keep the cache but mark every replica stale → the next pick re-applies
//   the SAME cached snapshot. Lighter: the policy is fine, we just distrust that the
//   replicas have it loaded.
// Both org-scoped like teardown-gateways. They mutate the live gateway director, so an
// audit_event is written. (Admin-only gating is intentionally NOT added — mirrors
// teardown-gateways, which is strictly more destructive, and the pushed/resent policy
// is compiled from acl_rule rows the caller cannot write.)
async function poolReset(c: Parameters<typeof handle>[0], id: string, op: 'reset' | 'clear') {
  const caller = await resolveCaller(c);
  const ep = await loadOwned(id, caller.orgId);
  if (!ep) return err(c, 'datalake_not_found', 404);
  const gw = gatewayClientFor(ep);
  let result;
  try {
    result = op === 'reset' ? await gw.resetPool(id) : await gw.clearSnapshot(id);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
       VALUES ($1,'control-plane','pool_reset',$2,'deny',$3,$4)`,
      [caller.orgId, id, `${op} failed: ${detail}`, caller.callerId],
    );
    return err(c, 'pool_reset_failed', 502, detail);
  }
  await query(
    `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
     VALUES ($1,'control-plane','pool_reset',$2,'allow',$3,$4)`,
    [caller.orgId, id, `op=${op} ${JSON.stringify(result)}`, caller.callerId],
  );
  return ok(c, { datalakeId: id, op, ...result });
}

datalakes.post('/:id/reset-pool', (c) => handle(c, () => poolReset(c, c.req.param('id'), 'reset')));
datalakes.post('/:id/clear-snapshot', (c) => handle(c, () => poolReset(c, c.req.param('id'), 'clear')));

// ── POST /:id/replicas/:n/reapply — birdshot-only reset+recommit (Step 5) ──────────
// Asks replica n's CONTAINER to re-run its own last-cached birdshot snapshot (reset →
// set → commit), with NO control-plane round trip. Recovers a hot replica whose
// in-memory birdshot policy got corrupted while the container stayed up. Returns 409
// if the container has never received a snapshot (cold boot) — push one first.
// Distinct from rearm (Step 3): rearm re-pushes the DIRECTOR's cached snapshot;
// reapply re-runs the CONTAINER's. Use reapply when you trust the last push was
// correct and only the in-memory state is suspect; use rearm/reset-pool otherwise.
// Query param ?force=false skips the re-apply when birdshot_status already reports a
// loaded policy (lighter check). Org-scoped + audited.
datalakes.post('/:id/replicas/:n/reapply', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 0) return err(c, 'bad_replica_index', 400);
    const u = new URL(c.req.url);
    const force = u.searchParams.get('force') !== 'false';
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err(c, 'datalake_not_found', 404);
    let result;
    try {
      result = await gatewayClientFor(ep).reapplyReplica(id, n, force);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await query(
        `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
         VALUES ($1,'control-plane','reapply_snapshot',$2,'deny',$3,$4)`,
        [caller.orgId, id, `replica ${n} failed: ${detail}`, caller.callerId],
      );
      return err(c, 'reapply_failed', 502, detail);
    }
    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
       VALUES ($1,'control-plane','reapply_snapshot',$2,'allow',$3,$4)`,
      [caller.orgId, id, `replica ${n} force=${force} ${JSON.stringify(result)}`, caller.callerId],
    );
    return ok(c, { datalakeId: id, replica: n, force, ...result });
  }),
);

// ── POST /:id/replicas/:n/{wake,sleep,destroy,rearm} — per-replica lifecycle (Step 3 ext surface) ─
// External surface for the Step 3 director RPCs, needed by the Step 6 MCP tools + the
// Step 8 dashboard. Each is org-scoped + audited. `destroy` forces a container cold-boot
// on the next pick (the new container boots from the latest pushed image — the lever for
// picking up gateway-image code changes like the /gw/reapply route itself).
async function replicaOp(
  c: Parameters<typeof handle>[0],
  id: string,
  n: number,
  op: 'wake' | 'sleep' | 'destroy' | 'rearm',
) {
  const caller = await resolveCaller(c);
  if (!Number.isInteger(n) || n < 0) return err(c, 'bad_replica_index', 400);
  const ep = await loadOwned(id, caller.orgId);
  if (!ep) return err(c, 'datalake_not_found', 404);
  const gw = gatewayClientFor(ep);
  let result;
  try {
    if (op === 'wake') result = await gw.wakeReplica(id, n);
    else if (op === 'sleep') result = await gw.sleepReplica(id, n);
    else if (op === 'destroy') result = await gw.destroyReplica(id, n);
    else result = await gw.rearmReplica(id, n);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
       VALUES ($1,'control-plane','replica_op',$2,'deny',$3,$4)`,
      [caller.orgId, id, `${op} replica ${n} failed: ${detail}`, caller.callerId],
    );
    return err(c, 'replica_op_failed', 502, detail);
  }
  await query(
    `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, reason, actor)
     VALUES ($1,'control-plane','replica_op',$2,'allow',$3,$4)`,
    [caller.orgId, id, `${op} replica ${n} ${JSON.stringify(result)}`, caller.callerId],
  );
  return ok(c, { datalakeId: id, replica: n, op, ...result });
}

datalakes.post('/:id/replicas/:n/wake', (c) => handle(c, () => replicaOp(c, c.req.param('id')!, Number(c.req.param('n')), 'wake')));
datalakes.post('/:id/replicas/:n/sleep', (c) => handle(c, () => replicaOp(c, c.req.param('id')!, Number(c.req.param('n')), 'sleep')));
datalakes.post('/:id/replicas/:n/destroy', (c) => handle(c, () => replicaOp(c, c.req.param('id')!, Number(c.req.param('n')), 'destroy')));
datalakes.post('/:id/replicas/:n/rearm', (c) => handle(c, () => replicaOp(c, c.req.param('id')!, Number(c.req.param('n')), 'rearm')));

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
  gateway_url: string | null;
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
      `SELECT id, org_id, status, server_token, gateway_url
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

    // Pull-model (spec §13): the agent's grants are literal GRANT/DENY SQL, not a compiled
    // table/column structure. An agent with zero statements has nothing to introspect.
    const statements = await grantsForKey(datalakeId, agentSubject(agentId));
    if (statements.length === 0) {
      return ok<DescribeResult>(c, { datalakeId, tables: [] });
    }
    // Grant-scoped COLUMN introspection (intersecting gateway catalog types with each grant's
    // ref/column allow-list) needs a re-implementation that parses the literal statements +
    // reads the gateway catalog. Deferred with the read/display path (§13 FOLLOW-UP); until
    // then this returns no typed columns (the gateway `describe` surface is 501-gated anyway).
    // The literal statements themselves are available via GET /:id/policy + GET /acl.
    void schemaFilter; void tableFilter; void GatewayError;
    return ok<DescribeResult>(c, { datalakeId, tables: [] as TableInfo[] });
  }),
);

// ── /api/cp/datalakes/:id/catalog — FULL catalog for the ACL authoring picker ────
//
// UNFILTERED by grants (unlike /describe, which is the agent-facing grant-scoped
// view) → owner/admin only. Serves the cached snapshot instantly; if nothing is
// cached yet, boots the gateway once on demand to populate it. The real freshness
// driver is the change-tracked refresh after catalog-mutating statements, not this
// read path.
async function requireOrgAdmin(caller: { callerId: string; orgId: string }): Promise<boolean> {
  const member = await queryOne<{ role: string }>(
    `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
    [caller.callerId, caller.orgId],
  );
  return !!member && ['owner', 'admin'].includes(member.role);
}

datalakes.get('/:id/catalog', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const datalakeId = c.req.param('id');
    const endpoint = await queryOne<DescribeEndpointRow>(
      `SELECT id, org_id, status, server_token, gateway_url FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!endpoint) return err(c, 'datalake_not_found', 404);
    assertOrg(caller, endpoint.org_id);
    if (!(await requireOrgAdmin(caller))) {
      return err(c, 'forbidden', 403, 'Only org owners and admins may browse the catalog');
    }

    let cached = await getCachedCatalog(datalakeId);
    if (!cached) {
      // Boot-on-demand: nothing cached yet — try to populate once (may cold-boot).
      const snap = await refreshCatalog(endpoint);
      if (snap) cached = await getCachedCatalog(datalakeId);
    }
    if (!cached) {
      return ok(c, { datalakeId, schemas: [], fetchedAt: null, stale: true });
    }
    return ok(c, { datalakeId, schemas: cached.snapshot.schemas, fetchedAt: cached.fetchedAt, stale: false });
  }),
);

datalakes.post('/:id/catalog/refresh', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const datalakeId = c.req.param('id');
    const endpoint = await queryOne<DescribeEndpointRow>(
      `SELECT id, org_id, status, server_token, gateway_url FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!endpoint) return err(c, 'datalake_not_found', 404);
    assertOrg(caller, endpoint.org_id);
    if (!(await requireOrgAdmin(caller))) {
      return err(c, 'forbidden', 403, 'Only org owners and admins may refresh the catalog');
    }
    const snap = await refreshCatalog(endpoint);
    if (!snap) {
      return err(c, 'gateway_unreachable', 503, 'could not fetch catalog (gateway cold or stopped)');
    }
    return ok(c, { datalakeId, schemas: snap.snapshot.schemas });
  }),
);

// ── POST /api/cp/endpoints/:id/provision — (re)activate a lake ───────────────────
//
// The supported API path to (re)activate a lake WITHOUT a direct DB write. New lakes
// activate automatically at create (the POST handler above), so this is the recovery
// path for a lake that ended up not 'running' — a legacy lake created before auto-
// activation, one left in 'error'/'stopped', or one whose managed catalog needs a
// re-provision. Idempotent: safe to call on an already-running lake.
//
// It does NOT boot a gateway — the gateway is a lazy-boot dynamic pool that boots on
// the first connect's snapshot push and scales back to zero. Activation just (a)
// ensures the managed org catalog exists (idempotent re-provision), (b) proves the
// stored creds decrypt into a valid gateway config, then (c) flips the lifecycle
// status to 'running' so connect/agent-tooling stop gating on it. Connect re-checks
// catalog readiness, so a transient catalog hiccup self-heals on the next connect.
//
// (Formerly a dev-only stand-in hard-403'd in production — which is why a lake created
// via the UI sat in 'provisioning' forever. The gateway is lazy-boot now, so flipping
// the status IS the correct activation; no Stage-D boot to wait on.)

datalakes.post('/:id/provision', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');

    const owned = await queryOne<{ org_id: string; status: string; catalog_mode: string | null }>(
      `SELECT org_id, status, catalog_mode FROM waddling.datalake WHERE id = $1`,
      [id],
    );
    if (!owned) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, owned.org_id);

    // (a) Ensure the managed org catalog exists (idempotent — returns the existing 'ready'
    // row, or re-provisions a missing/errored one). Best-effort: connect re-checks anyway.
    let catalogState: string | undefined;
    if (owned.catalog_mode === 'managed-postgres') {
      const slugRow = await queryOne<{ slug: string }>(`SELECT slug FROM "organization" WHERE id = $1`, [owned.org_id]);
      try {
        catalogState = (await provisionOrgCatalog(c.env, owned.org_id, slugRow?.slug ?? owned.org_id)).state;
      } catch {
        // leave catalogState undefined; connect re-checks readiness via getOrgCatalogDsn
      }
    }

    // (b) Resolve + validate stored credentials (decrypts BYO storage / catalog).
    const cfg = await getDatalakeGatewayConfig(id);
    if (!cfg) return err(c, 'endpoint_not_found', 404);
    if (!cfg.localData && cfg.s3?.provider === 'config' && !cfg.s3.secret) {
      return err(c, 'missing_storage_secret', 422, 'Object-store credentials did not resolve');
    }

    // (c) Flip the lifecycle status to running (idempotent).
    await query(
      `UPDATE waddling.datalake SET status = 'running', updated_at = now() WHERE id = $1`,
      [id],
    );

    // (d) Ensure this datalake's own private gateway is deployed (idempotent create-or-update via
    // the provisioner). This is the recovery for a datalake whose create-time provision failed or
    // a legacy row with no gateway_url. Best-effort: connect re-checks and the next call retries.
    if (c.env.PROVISIONER_URL) {
      try {
        const dlRow = await queryOne<ProvisionableDatalake>(
          `SELECT id, org_id, slug, server_token, catalog_schema, catalog_mode, encrypted
             FROM waddling.datalake WHERE id = $1`,
          [id],
        );
        if (dlRow) {
          const { url } = await provisionGateway(c.env, dlRow);
          await query(`UPDATE waddling.datalake SET gateway_url = $1 WHERE id = $2`, [url, id]);
        }
      } catch (e) {
        console.log(`[datalake provision] gateway (re)provision failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Echo the resolved config WITHOUT secrets, so the dashboard can confirm the
    // credential plumbing without exposing keys to the browser. The gateway is a
    // dynamic pool (no fixed host:port) — activation just flips the lifecycle status.
    return ok(c, {
      status: 'running',
      catalogState,
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

export { datalakes };
