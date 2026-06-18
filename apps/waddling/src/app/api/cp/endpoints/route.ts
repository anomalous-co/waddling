/**
 * /api/cp/endpoints (W1) — org analytics endpoints (§2 endpoint, §4a list).
 *
 * GET  → list this org's endpoints (EndpointSummary[]).
 * POST → create an endpoint record (status 'provisioning'); gateway boot is W3.
 *        Gated by the org's plan endpoint quota.
 */
import { join } from 'node:path';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@/lib/db';
import { getEntitlements } from '@/lib/entitlements';
import { getLocalLakeDir } from '@/lib/env';
import { sealJson } from '@/lib/secret-crypto';
import type { StorageCreds, CatalogCreds } from '@/lib/endpoint-secrets';
import { getPostHogServer } from '@/lib/posthog-server';
import { resolveCaller, parseBody, handle, ok, err } from '../_shared';
import type { EndpointSummary } from '@/lib/types';

// Bring-your-own object storage for the lake's data files. `config` uses static
// keyId/secret (encrypted at rest); `credential_chain` uses the gateway's ambient
// role (no creds stored). See migration 005 + lib/endpoint-secrets.
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    // Data-plane read (waddling_list_endpoints) — allow delegated OAuth/MCP callers.
    const caller = await resolveCaller(req, true, true);
    const rows = await query<{
      id: string;
      name: string;
      slug: string;
      status: EndpointSummary['status'];
    }>(
      `SELECT id, name, slug, status FROM waddling.endpoint
        WHERE org_id = $1 ORDER BY created_at ASC`,
      [caller.orgId],
    );
    const endpoints: EndpointSummary[] = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
    }));
    return ok({ endpoints });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const input = await parseBody(req, CreateSchema);

    // Quota check.
    const ent = await getEntitlements(caller.orgId);
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.endpoint WHERE org_id = $1`,
      [caller.orgId],
    );
    if (Number(count?.n ?? 0) >= ent.endpoints) {
      return err(
        'endpoint_quota_exceeded',
        402,
        `Plan allows ${ent.endpoints} endpoint(s)`,
      );
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
        // catalog_dsn column kept non-secret for new rows: the real BYO DSN is
        // encrypted in endpoint_secret; '' here means "see secret store".
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

        // Managed-local: assign a per-endpoint catalog file path now we have the id.
        if (catalogMode === 'managed-local') {
          const catalogFile = join(getLocalLakeDir(), endpointId, 'lake.ducklake');
          await q(`UPDATE waddling.endpoint SET catalog_file = $2 WHERE id = $1`, [
            endpointId,
            catalogFile,
          ]);
        }

        // Encrypt + store credentials (never written to plaintext columns).
        if (storage.provider === 'config' && storage.keyId && storage.secret) {
          const creds: StorageCreds = {
            keyId: storage.keyId,
            secret: storage.secret,
            sessionToken: storage.sessionToken,
          };
          const s = sealJson(creds);
          await q(
            `INSERT INTO waddling.endpoint_secret (endpoint_id, kind, iv, auth_tag, ciphertext)
               VALUES ($1,'storage',$2,$3,$4)`,
            [endpointId, s.iv, s.authTag, s.ciphertext],
          );
        }
        if (input.catalogDsn) {
          const creds: CatalogCreds = { dsn: input.catalogDsn };
          const s = sealJson(creds);
          await q(
            `INSERT INTO waddling.endpoint_secret (endpoint_id, kind, iv, auth_tag, ciphertext)
               VALUES ($1,'catalog',$2,$3,$4)`,
            [endpointId, s.iv, s.authTag, s.ciphertext],
          );
        }

        return row.rows[0]!;
      });

      // Telemetry: non-secret create attributes only — never credentials, DSNs,
      // data paths, or bucket names.
      getPostHogServer().capture({
        distinctId: caller.callerId,
        event: 'endpoint_created',
        properties: { region: input.region, storageProvider: storage.provider, catalogMode },
        groups: { organization: caller.orgId },
      });

      return ok({ endpointId: created.id, status: created.status }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return err('slug_taken', 409, 'An endpoint with that slug already exists');
      }
      throw e;
    }
  });
}
