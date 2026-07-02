import { FIXTURE_LAKE_DETAILS } from '@/lab/fixtures/datalake-catalog';
import { FIXTURE_ACL_RULES } from '@/lab/fixtures/acl';
import type { DatalakeSummary } from '@/lib/types';

/** Lab-local enrichment layered on top of DatalakeSummary for the index list. */
export interface DatalakeSummaryEnriched extends DatalakeSummary {
  tableCount: number;
  sizeBytes: number;
  agentCount: number;
}

/**
 * GET /api/cp/datalakes
 * Mock handler — returns enriched fixture data lakes for the UX lab.
 * Derives tableCount and sizeBytes from the catalog fixture (single source of
 * truth) and computes agentCount from the ACL fixture (distinct agentIds per lake).
 * Guards against serving when the real control-api is configured.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const datalakes: DatalakeSummaryEnriched[] = Object.values(FIXTURE_LAKE_DETAILS).map((detail) => {
    const tableCount = detail.catalog.reduce((n, s) => n + s.tables.length, 0);
    const agentIds = new Set(
      FIXTURE_ACL_RULES.filter((r) => r.datalakeId === detail.id && r.agentId).map(
        (r) => r.agentId,
      ),
    );
    return {
      id: detail.id,
      name: detail.name,
      slug: detail.slug,
      status: detail.status,
      schemas: detail.catalog.map((s) => s.schema),
      tableCount,
      sizeBytes: detail.sizeBytes ?? 0,
      agentCount: agentIds.size,
    };
  });

  return Response.json({ datalakes });
}

/**
 * POST /api/cp/datalakes
 * Mock handler — creates a stub lake record and returns a provisioning response.
 * In the lab the lake isn't persisted, so navigating to its detail page would
 * 404; callers should advance to a success state rather than router.push.
 */
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const body = (await req.json()) as {
    name?: string;
    slug?: string;
    region?: string;
    storage?: { kind: string; endpoint?: string; bucket?: string };
  };

  const name = String(body.name ?? '').trim();
  const slug =
    String(body.slug ?? '').trim() ||
    name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Derive an id from the slug — in a real implementation this would be a
  // persistent database row with a globally unique id.
  const id = `dl_${slug || 'new'}`;

  return Response.json({
    datalake: {
      id,
      name: name || slug,
      slug,
      status: 'provisioning',
      schemas: [],
    },
  });
}
