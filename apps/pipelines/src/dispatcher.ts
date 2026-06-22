/**
 * Fleet dispatcher — the Worker entrypoint.
 *
 * scheduled(): the cron tick. Enumerate the registry; for each due, not-running
 * pipeline, mark it running in D1 and create a workflow instance. The overlap
 * guard (skip if a prior instance is still running) is the primary defense
 * against two runs of the same pipeline racing the same window.
 *
 * fetch(): a manual kick — GET /run?pipeline=<id>. Gated (Access in front, or a
 * RUN_TOKEN bearer) since the Worker is private (workers_dev disabled).
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import { REGISTRY, getSpec } from './registry';
import { CursorStore } from './cursor';
import { EtlWorkflow } from './workflow';

// Re-export so the wrangler `workflows` binding (class_name: EtlWorkflow) and the
// Workflow runtime can find the class on the Worker's module exports.
export { EtlWorkflow };

// A pipeline whose `running` flag has been set longer than this is treated as
// wedged (a prior run errored before it could clear the flag, e.g. an isolate
// eviction between steps) and is allowed to re-dispatch. Generous vs the hourly
// cadence so a legitimately long run is never pre-empted.
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000; // 6h

function isStaleRunning(lastRunAt: string | null): boolean {
  if (!lastRunAt) return true;
  const t = Date.parse(lastRunAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > STALE_RUNNING_MS;
}

/** Create a workflow instance for one spec, guarding against overlap. */
async function dispatch(env: Env, pipelineId: string): Promise<'created' | 'skipped' | 'unknown'> {
  const spec = getSpec(pipelineId);
  if (!spec) return 'unknown';

  const cursors = new CursorStore(env.DB);
  const row = await cursors.read(pipelineId);

  // Overlap guard: a prior run is still going. Skip unless it's been running long
  // enough to be considered wedged (flag never cleared by an errored run).
  if (row?.running === 1 && !isStaleRunning(row.last_run_at)) {
    return 'skipped';
  }

  // Mark running BEFORE create so a concurrent tick sees the flag — the `running`
  // flag (not the instance id) is the overlap guard.
  await cursors.markRunning(pipelineId);

  // Date.now() makes each instance id unique. That's deliberate: it's plain
  // Worker code (not workflow orchestration, where wall-clock would break replay
  // determinism), and a unique id lets a post-error re-dispatch get a fresh id
  // instead of colliding with the errored instance still in retention.
  const instanceId = `${spec.id}-${row?.watermark ?? 'init'}-${Date.now()}`;
  try {
    await env.WF.create({ id: instanceId, params: { pipelineId } });
    return 'created';
  } catch (err) {
    // create failed (e.g. transient). The running flag is set; the stale-running
    // guard will release it for re-dispatch if this never recovers.
    console.warn(`[pipelines] create ${instanceId} failed:`, err);
    return 'skipped';
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        for (const spec of REGISTRY) {
          try {
            const r = await dispatch(env, spec.id);
            console.log(`[pipelines] dispatch ${spec.id}: ${r}`);
          } catch (err) {
            console.error(`[pipelines] dispatch ${spec.id} failed:`, err);
          }
        }
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/run') {
      return new Response('waddling-pipelines', { status: 200 });
    }

    // Gate: an Access policy in front is preferred; RUN_TOKEN is the fallback for
    // direct invocation. Either way the Worker is private (no workers.dev).
    if (env.RUN_TOKEN) {
      const auth = req.headers.get('authorization');
      if (auth !== `Bearer ${env.RUN_TOKEN}`) {
        return new Response('forbidden', { status: 403 });
      }
    }

    const pipeline = url.searchParams.get('pipeline');
    if (!pipeline) {
      return Response.json({ error: 'missing ?pipeline=', pipelines: REGISTRY.map((s) => s.id) }, { status: 400 });
    }
    const result = await dispatch(env, pipeline);
    if (result === 'unknown') {
      return Response.json({ error: 'unknown pipeline', pipeline }, { status: 404 });
    }
    return Response.json({ pipeline, result });
  },
};
