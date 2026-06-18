/**
 * /api/cp/endpoints/[id] (W1) — endpoint detail + status (§4b endpoint_status).
 *
 * GET    → endpoint detail + live gateway status (best-effort).
 * PATCH  → update mutable fields (name, status, gateway runtime fields set by W3).
 * DELETE → remove the endpoint (cascades acl_rule / agent_session).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { gatewayClientFor } from '@/lib/gateway-client';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../../_shared';
import type { EndpointStatus } from '@/lib/types';

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

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err('endpoint_not_found', 404);

    let birdshotStatus: EndpointStatus['birdshotStatus'];
    let snapshotLag: number | undefined;
    if (ep.status === 'running') {
      try {
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
    return ok({ endpoint, status });
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err('endpoint_not_found', 404);
    const patch = await parseBody(req, PatchSchema);

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
    return ok({ success: true });
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const ep = await loadOwned(id, caller.orgId);
    if (!ep) return err('endpoint_not_found', 404);
    await query(`DELETE FROM waddling.endpoint WHERE id = $1`, [id]);
    return ok({ success: true });
  });
}
