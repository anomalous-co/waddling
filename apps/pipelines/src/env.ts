/**
 * Worker environment bindings + vars + secrets.
 *
 * Per-source agent keys are NOT enumerated here as named fields: a `PipelineSpec`
 * names its key secret in `agentKeySecret`, and `governed-load` reads it via an
 * index lookup. Document each one in the README and `wrangler secret put` it.
 */

import type { Pipeline } from 'cloudflare:pipelines';

/** Params each EtlWorkflow instance is created with. */
export interface EtlParams {
  pipelineId: string;
}

export interface Env {
  /** Workflow binding (EtlWorkflow); the dispatcher creates instances on it. */
  WF: Workflow<EtlParams>;
  /** D1 cursor store (table `cursor`). */
  DB: D1Database;

  /** Pipelines Stream binding for the funnel pipeline. */
  FUNNEL_STREAM: Pipeline;

  // ── PostHog HogQL pull (the pull adapter) ──────────────────────────────────
  /** PostHog app host, e.g. https://us.posthog.com (NOT the ingestion host). */
  POSTHOG_APP_HOST: string;
  /** PostHog project id the events live in. */
  POSTHOG_PROJECT_ID: string;
  /** PostHog personal API key with "query read" scope (Worker secret). */
  POSTHOG_PERSONAL_API_KEY: string;

  // ── Governed lake load (acts-as-agent) ─────────────────────────────────────
  /** control-api origin, e.g. https://api.getwaddling.com. */
  CONTROL_API_BASE: string;
  /** The org endpoint/datalake id the star schema is loaded into. */
  DATALAKE_ID: string;

  // ── Manual-trigger gate ────────────────────────────────────────────────────
  /** Optional shared secret for GET /run (when not fronted by Access). */
  RUN_TOKEN?: string;

  /**
   * Per-source agent keys (sk_agent_…) and any other secrets are looked up by
   * name (`spec.agentKeySecret`). The index signature lets governed-load read
   * `env[spec.agentKeySecret]` while keeping the typed fields above strict.
   */
  [key: string]: unknown;
}
