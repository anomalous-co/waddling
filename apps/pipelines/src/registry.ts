/**
 * The pipeline fleet. One entry per source; the dispatcher enumerates these and
 * the workflow runs them. Adding a source = one entry here + a SourceAdapter + a
 * TargetModel (reusing conformed dims) + infra (stream/sink/pipeline + agent key)
 * + birdshot grants. No new Worker.
 */

import type { PipelineSpec } from './types';
import { posthogSourceWithEvents } from './sources/posthog';
import { funnelStar } from './models/funnel-star';

/**
 * Widened event allow-list: the full visit→signup→activation→paid funnel. The
 * staging schema (schema.json) carries the props these events add.
 */
const FUNNEL_EVENTS = [
  '$pageview',
  'signup_cta_clicked',
  'signup_started',
  'signup_completed',
  'org_created',
  'endpoint_created',
  'agent_created',
  'mcp_connect',
  'first_query',
  'query_executed',
  'denial_hit',
  'upgrade_viewed',
  'checkout_started',
  'checkout_completed',
  'device_link_created',
  'device_link_claimed',
  'agent_revoked',
];

export const REGISTRY: PipelineSpec[] = [
  {
    id: 'posthog-funnel',
    source: posthogSourceWithEvents(FUNNEL_EVENTS),
    streamBinding: 'FUNNEL_STREAM',
    // The Stream's sink writes Parquet under this prefix, INSIDE the lake bucket
    // so the gateway's lake S3 secret already covers the read_parquet egress.
    // Anomalous Context Lake's per-org R2 bucket (anom-context-lake). The sink
    // writes under the <datalakeId>/ prefix so the gateway's lake read-credential
    // covers it whether that cred is whole-bucket (BYO) or faucet-scoped to
    // <datalakeId>/ (managed-postgres). ** recurses through the sink's
    // year=/month=/day= time-partition dirs.
    stagingGlob: 's3://anom-context-lake/0d4ae298-2039-46a8-9473-c5f41d1620af/_ingest/funnel/**/*.parquet',
    datalakeId: '0d4ae298-2039-46a8-9473-c5f41d1620af',
    agentKeySecret: 'FUNNEL_AGENT_KEY',
    targetModel: funnelStar,
    schedule: '0 * * * *',
    cursorKey: 'posthog-funnel',
    events: FUNNEL_EVENTS,
    budget: { streams: 1, sinks: 1, pipelines: 1 },
  },
];

/** Open-beta account caps. The fleet must stay within each. */
export const ACCOUNT_CAPS = { streams: 20, sinks: 20, pipelines: 20 } as const;

/** Sum the fleet's resource consumption across all specs. */
export function budgetTotals(registry: PipelineSpec[] = REGISTRY): {
  streams: number;
  sinks: number;
  pipelines: number;
} {
  return registry.reduce(
    (acc, s) => ({
      streams: acc.streams + s.budget.streams,
      sinks: acc.sinks + s.budget.sinks,
      pipelines: acc.pipelines + s.budget.pipelines,
    }),
    { streams: 0, sinks: 0, pipelines: 0 },
  );
}

/**
 * Throw if the fleet would exceed an account cap. Called at module load (below)
 * so a registry edit that blows the budget fails fast rather than at deploy.
 */
export function assertWithinCaps(registry: PipelineSpec[] = REGISTRY): void {
  const t = budgetTotals(registry);
  for (const k of ['streams', 'sinks', 'pipelines'] as const) {
    if (t[k] > ACCOUNT_CAPS[k]) {
      throw new Error(
        `pipeline fleet exceeds account cap: ${t[k]} ${k} > ${ACCOUNT_CAPS[k]} (raise the limit or trim the registry)`,
      );
    }
  }
}

assertWithinCaps();

/** Look up a spec by id. */
export function getSpec(id: string): PipelineSpec | undefined {
  return REGISTRY.find((s) => s.id === id);
}
