/**
 * Core contracts for the ETL fleet.
 *
 * One Worker, one registry, N pipelines. Each pipeline is a `PipelineSpec`: a
 * source adapter (how records arrive), a Pipelines Stream binding (where they
 * land as staging Parquet), and a `TargetModel` (the governed star schema the
 * staging is folded into via the lake's own ETL path).
 *
 * Adding a source is a registry entry — a `SourceAdapter` + a `TargetModel`
 * (reusing the conformed dims) + infra (stream/sink/pipeline + an agent key) —
 * never a new Worker.
 */

import type { Env } from './env';

/**
 * One staging record sent to a Pipelines Stream. Cells are primitives (PostHog
 * projects properties as nullable scalars; timestamp is normalized to an ISO
 * string) — a concrete scalar value type keeps the record provably serializable
 * across a workflow step boundary.
 */
export type StagingRecord = Record<string, string | number | boolean | null>;

/**
 * How records enter the fleet.
 * - `pull`: the workflow calls `extract(env, cursor)` each run to fetch a page
 *   of records and report a new watermark.
 * - `push`: records arrive out-of-band (e.g. a Worker that `send()`s directly to
 *   the stream); the workflow's extract/buffer steps are skipped and it only
 *   runs the settle → governed-load → advance-cursor tail.
 */
export interface SourceAdapter {
  kind: 'pull' | 'push';
  /**
   * Fetch records newer than `cursor` (a watermark string, or null on first run).
   * Returns the records to buffer to the stream and the new watermark to persist
   * once the load succeeds. Required for `pull`; absent for `push`.
   */
  extract?(
    env: Env,
    cursor: string | null,
  ): Promise<{ records: StagingRecord[]; nextCursor: string | null }>;
}

/**
 * One table in the target star schema. `sql()` returns a SINGLE idempotent
 * statement (CREATE OR REPLACE TABLE …) that reads the staging Parquet at
 * `ctx.stagingGlob`. Surrogate keys are deterministic md5(natural_key) so the
 * fact resolves FKs with the same inline expression as each dim — no join, and
 * a full rebuild each run is safe.
 */
export interface StarTable {
  name: string;
  kind: 'dim' | 'fact';
  /** Conformed dims are shared across target models (dim_date, dim_person). */
  conformed?: boolean;
  sql(ctx: { stagingGlob: string }): string;
}

/**
 * A target star schema: the lake schema it lives in, the build order (dims
 * before fact so the proof JOIN returns rows), and the tables themselves.
 */
export interface TargetModel {
  schema: string;
  /** Table names in build order; each is run sequentially on one session. */
  order: string[];
  tables: Record<string, StarTable>;
}

/**
 * The fleet's account-resource budget. The open-beta caps are 20 streams / 20
 * sinks / 20 pipelines; `registry.ts` asserts the fleet stays within them.
 */
export interface PipelineBudget {
  streams: number;
  sinks: number;
  pipelines: number;
}

/** A single pipeline: one registry entry. */
export interface PipelineSpec {
  id: string;
  source: SourceAdapter;
  /** Name of the env binding for this pipeline's Stream (e.g. 'FUNNEL_STREAM'). */
  streamBinding: string;
  /** s3:// glob the gateway reads — the Stream's sink Parquet output prefix. */
  stagingGlob: string;
  /** Target org endpoint/datalake id the star schema is loaded into. */
  datalakeId: string;
  /** Name of the env secret holding this source's sk_agent_ key. */
  agentKeySecret: string;
  targetModel: TargetModel;
  /** Cron-ish cadence label; the dispatcher gates on D1 last_run vs this. */
  schedule: string;
  /** D1 cursor row id for this pipeline (defaults to `id`). */
  cursorKey: string;
  /** Event allow-list passed to a pull adapter (PostHog HogQL filter). */
  events?: string[];
  budget: PipelineBudget;
}
