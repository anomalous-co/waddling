/**
 * EtlWorkflow — one durable run of one pipeline.
 *
 * Steps (each a named, durably-checkpointed step.do):
 *   extract-buffer pull records AND send them to the Stream in one step (pull
 *                  sources only; push sources skip — records arrive out-of-band).
 *                  Combined so the (potentially large) record array never crosses
 *                  a persisted step boundary — only the small watermark does,
 *                  staying well under the step-result size quota. On retry the
 *                  whole pull+send re-runs; the uuid-dedup fact CTAS absorbs it.
 *   settle         sleep ≥ the sink roll-interval so Parquet rolls before we read
 *   governed-load  build the star schema on ONE governed session (ordered CTAS)
 *   advance-cursor monotonic D1 watermark advance + clear the running flag
 *
 * At-least-once invariants:
 *  - `extract-buffer` may double-send on a retry → the fact CTAS dedups on uuid,
 *    so a double-send is absorbed, not duplicated.
 *  - `governed-load` is idempotent: CREATE OR REPLACE TABLE + deterministic
 *    md5 surrogate keys → a re-run rebuilds to the identical state.
 *  - `advance-cursor` is a monotonic guarded UPDATE → a stale retry is a no-op.
 *  - clearRunning runs in the SAME step as the advance, AND in a catch on the
 *    run() body, so an errored run doesn't wedge the dispatcher's overlap guard.
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Pipeline } from 'cloudflare:pipelines';
import type { Env, EtlParams } from './env';
import type { StagingRecord } from './types';
import { getSpec } from './registry';
import { CursorStore } from './cursor';
import { runStarBuild } from './lib/governed-load';

// The settle sleep must be ≥ the sink's roll-interval (README provisions the
// sink with --roll-interval 300), or governed-load reads staging before any
// Parquet has rolled → an empty fact. Margin covers sink scheduling jitter.
// Keep this in lockstep with the README's roll-interval.
const SINK_ROLL_INTERVAL_SECONDS = 300;
const SETTLE_MARGIN_SECONDS = 60;

// Pipelines: max 1 MB / send; chunk conservatively by record count.
const STREAM_CHUNK = 1000;

export class EtlWorkflow extends WorkflowEntrypoint<Env, EtlParams> {
  async run(event: WorkflowEvent<EtlParams>, step: WorkflowStep): Promise<void> {
    const { pipelineId } = event.payload;
    const spec = getSpec(pipelineId);
    if (!spec) throw new Error(`unknown pipeline: ${pipelineId}`);

    const cursors = new CursorStore(this.env.DB);

    try {
      // 1. extract-buffer (pull only). Pull a page AND send it to the Stream in
      //    ONE step, so only the watermark crosses the persisted step boundary —
      //    the record array (up to PAGE_SIZE * MAX_PAGES rows) never does, keeping
      //    the step result tiny. push sources skip — records already landed.
      let nextCursor: string | null = null;
      let sent = 0;
      if (spec.source.kind === 'pull' && spec.source.extract) {
        const cursorRow = await cursors.read(pipelineId);
        const cursor = cursorRow?.watermark ?? null;
        const binding = this.env[spec.streamBinding] as Pipeline<StagingRecord> | undefined;
        if (!binding) throw new Error(`missing stream binding: ${spec.streamBinding}`);
        const r = await step.do('extract-buffer', async () => {
          // Read-only against PostHog; the send is re-run on retry (uuid-deduped
          // downstream), so the whole step is safe to replay.
          const { records, nextCursor: nc } = await spec.source.extract!(this.env, cursor);
          for (let i = 0; i < records.length; i += STREAM_CHUNK) {
            await binding.send(records.slice(i, i + STREAM_CHUNK));
          }
          return { nextCursor: nc, sent: records.length };
        });
        nextCursor = r.nextCursor;
        sent = r.sent;
      }

      // If a pull produced nothing AND no records are otherwise pending, there's
      // nothing to load — short-circuit so we don't settle+rebuild on empty.
      if (spec.source.kind === 'pull' && sent === 0) {
        await step.do('advance-cursor', async () => {
          await cursors.clearRunning(pipelineId, 'ok', 0);
          return { sent: 0 };
        });
        return;
      }

      // 3. settle — let the sink roll the buffered records into Parquet before
      //    governed-load reads them. Sleeping instances don't count toward
      //    concurrency, so this is cheap.
      await step.sleep('settle', `${SINK_ROLL_INTERVAL_SECONDS + SETTLE_MARGIN_SECONDS} seconds`);

      // 4. governed-load — ONE session, ordered star CTAS. Idempotent.
      await step.do('governed-load', { timeout: '5 minutes' }, async () => {
        const r = await runStarBuild(this.env, spec);
        return { statements: r.statements };
      });

      // 5. advance-cursor — monotonic watermark + clear running, atomically from
      //    the dispatcher's perspective (running cleared only after a clean build).
      await step.do('advance-cursor', async () => {
        if (nextCursor) await cursors.advance(pipelineId, nextCursor);
        await cursors.clearRunning(pipelineId, 'ok', sent || null);
        return { watermark: nextCursor };
      });
    } catch (err) {
      // Free the overlap guard so a failed run doesn't wedge this pipeline
      // forever. The watermark is NOT advanced, so the next run retries the
      // same window. Best-effort: never mask the original error.
      try {
        await cursors.clearRunning(pipelineId, 'error', null);
      } catch {
        // ignore — surfacing the build error matters more than the flag clear
      }
      throw err;
    }
  }
}
