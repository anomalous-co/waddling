/**
 * Cloud Tasks producer for the async context-graph embedding pipeline.
 *
 * The board's un-embedded rows (observations + agent_memory with no `embeddings` row) ARE the
 * queue — this module just schedules the DRAIN. On every board write we enqueue a coalescing
 * Cloud Tasks task that, after a short debounce, POSTs the board gateway's `/ctrl/qb-drain`
 * (OIDC-authed). Cloud Tasks gives us three things the old per-minute inline cron did not:
 *   - **only-when-work**: a task exists only because a write happened; the GPU service is never
 *     woken on an empty backlog (the gateway also re-checks and skips /embed when pending=0).
 *   - **coalescing**: the task NAME is bucketed by a debounce window, so many writes in that
 *     window collapse to ONE drain (duplicate creates return ALREADY_EXISTS — swallowed).
 *   - **horizontal scale + retry**: Cloud Tasks delivers many boards' drains concurrently and
 *     retries failures; within a board, the gateway fans embed requests out concurrently so a
 *     large backlog recruits multiple embeddings Cloud Run instances.
 *
 * Enqueue is fire-and-forget and must NEVER throw into the agent write path (that would put a
 * GPU-adjacent dependency back in the write path — the invariant we are protecting). All failures
 * are logged and swallowed; a lost enqueue is recovered by the low-frequency backstop sweep.
 */
import { GoogleAuth } from 'google-auth-library';
import type { Env } from './env.js';

const DEBOUNCE_SECONDS = 15; // coalesce writes within this window into a single drain task

// One reusable ADC client (Cloud Run metadata → control-api-run@). getAccessToken() refreshes
// the underlying token internally, so caching the client across requests is safe on Node.
let authClient: GoogleAuth | null = null;
function taskAuth(): GoogleAuth {
  if (!authClient) authClient = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  return authClient;
}

export interface EnqueueEmbedDrainInput {
  datalakeId: string;
  gatewayUrl: string | null;
  embeddingsUrl?: string;
  /** Coalescing window in seconds. Write path uses the tight default (fast embeds); the backstop
   *  sweep passes a coarse value so re-enqueuing every warm board each tick collapses to at most
   *  one recovery drain per window (it must not degrade into a per-minute poller). */
  debounceSeconds?: number;
}

/**
 * Enqueue (or coalesce onto) a debounced drain task for one board. No-op — never throws — when the
 * queue/embeddings/gateway aren't configured (local dev), or on any Cloud Tasks error.
 */
export async function enqueueEmbedDrain(env: Env, input: EnqueueEmbedDrainInput): Promise<void> {
  const queue = env.EMBED_QUEUE; // projects/<p>/locations/<r>/queues/embed-drain
  const oidcSa = env.EMBED_DRAIN_SA;
  const embeddingsUrl = input.embeddingsUrl ?? env.EMBEDDINGS_URL;
  if (!queue || !oidcSa || !embeddingsUrl || !input.gatewayUrl) return;

  try {
    // Deterministic per-window name: floor(now/DEBOUNCE) buckets every write in the window to the
    // SAME task id and the SAME scheduleTime (bucket end), so the first create wins and the rest
    // are ALREADY_EXISTS — true coalescing, not just best-effort dedup.
    const window = input.debounceSeconds ?? DEBOUNCE_SECONDS;
    const bucket = Math.floor(Date.now() / 1000 / window);
    // Window is part of the name so tight write-path buckets and coarse backstop buckets never
    // collide on a shared integer (they'd otherwise drop one another as ALREADY_EXISTS).
    const taskId = `drain-${input.datalakeId}-w${window}-${bucket}`;
    const scheduleTime = new Date((bucket + 1) * window * 1000).toISOString();
    const targetUrl = `${input.gatewayUrl.replace(/\/$/, '')}/ctrl/qb-drain`;

    const token = await taskAuth().getAccessToken();
    if (!token) return; // no ADC (local) — nothing to enqueue against

    const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: {
          name: `${queue}/tasks/${taskId}`,
          scheduleTime,
          httpRequest: {
            url: targetUrl,
            httpMethod: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ embeddingsUrl })).toString('base64'),
            // OIDC audience = the Cloud Run service ROOT url (not the /ctrl path) — that's what the
            // gateway's invoker check validates. control-api-run@ holds run.invoker on the gateway.
            oidcToken: { serviceAccountEmail: oidcSa, audience: input.gatewayUrl.replace(/\/$/, '') },
          },
        },
      }),
    });
    if (res.ok || res.status === 409) return; // 409 ALREADY_EXISTS = coalesced onto an existing task
    console.log(`[embed-queue] enqueue ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.log(`[embed-queue] enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
