/**
 * Durable control→gateway dispatch (the outbox over waddling.gateway_dispatch,
 * migration 020).
 *
 * Replaces the old inline best-effort push (recompileAndPush called synchronously in
 * the ACL/policy/agent-delete request, swallowing gateway failures with no retry). Two
 * wins:
 *
 *   Durability — an edit ENQUEUES a row in the same DB path as the rule mutation, so a
 *   dropped /gw/snapshot or /gw/revoke is retried (immediate waitUntil attempt + the
 *   control-api 5-minute cron drain) until it lands, instead of silently leaving the
 *   gateway stale until a coincidental later connect.
 *
 *   Latency / write-amplification — the edit returns after the cheap enqueue instead of
 *   blocking on compileEndpointPolicy + a 45s-timeout push. And because the snapshot is
 *   recompiled FROM CURRENT DB STATE at drain (never stored in the row), a burst of N
 *   edits to one datalake COALESCES into a single recompile + push.
 *
 * The connect path (sessions.ts) and the admin refresh-policy path stay SYNCHRONOUS —
 * they must observe the pushed snapshot before minting a JWT / reporting success.
 *
 * Underlying delivery is idempotent (recompile+push re-applies current state; a repeat
 * birdshot_revoke of the same subject is a no-op denylist write), so concurrent drains
 * (cron + immediate) racing the same row at most waste a call — we don't hold row locks.
 */
import { query, runInDbScope } from './db';
import { recompileAndPush } from './gateway-push';
import { compileEndpointPolicy } from './effective-policy';
import type { CompileResult } from './policy-compiler';
import { gatewayClientFor, initDataplane } from './gateway-client';
import { refreshCatalog, type CatalogEndpoint } from './catalog-cache';
import type { Env } from './env';

/**
 * Drop-in async replacement for recompileAndPush on the EDIT paths (acl / delegations /
 * policies). Compiles the endpoint policy SYNCHRONOUSLY so the editor still gets the
 * resulting grants in its response (cheap in-worker CPU — no network, no 45s push, no
 * per-replica apply), then ENQUEUES delivery and kicks an immediate drain. The expensive
 * gateway push happens off the request path and coalesces with any concurrent edit.
 *
 * Mirrors recompileAndPush's signature/return so callers swap one import + one call.
 * A null datalake (global-scope delegation) has no gateway to reach: compile-empty, no
 * enqueue (a later per-endpoint connect/recompile picks it up).
 */
export async function recompileAndEnqueue(
  c: { env: Env; executionCtx: ExecutionContext },
  datalakeId: string | null,
): Promise<CompileResult> {
  if (!datalakeId) {
    return {
      snapshot: { roleGrants: [], userRoles: [], roleConstraints: [] },
      constraints: [],
      activeAgentIds: [],
    };
  }
  const compiled = await compileEndpointPolicy(datalakeId, new Date());
  await enqueueSnapshotDispatch(datalakeId);
  kickDispatch(c, datalakeId);
  return compiled;
}

/**
 * Pull the live catalog from the gateway and, IF it changed, enqueue a durable recompile+
 * push (so any covering read/write WILDCARD grant folds in the new/removed/renamed table —
 * the "future tables are auto-covered" promise the authoring UI makes for "whole schema /
 * entire lake" grants). The DURABLE variant of gateway-push.ts `refreshCatalogAndRecompile`:
 * a changed catalog goes through the outbox (enqueue + kick) instead of a direct best-effort
 * push, so a failed push is retried by the drain rather than silently lost — the cached
 * content_hash is already advanced, so a direct push that failed would never re-fire until
 * the NEXT content change.
 *
 * Best-effort: never throws into the caller (cron tick / waitUntil / awaited loopback). The
 * gateway must already be warm — callers status-gate (or run on the just-woken connect path)
 * so this never cold-boots a sleeping gateway.
 */
export async function refreshCatalogAndEnqueue(
  c: { env: Env; executionCtx?: ExecutionContext },
  datalakeId: string,
  endpoint: CatalogEndpoint,
): Promise<{ changed: boolean }> {
  try {
    const r = await refreshCatalog(endpoint);
    if (r?.changed) {
      await enqueueSnapshotDispatch(datalakeId);
      kickDispatch(c, datalakeId);
      return { changed: true };
    }
  } catch {
    /* best-effort: the next tick / connect picks up the fresh catalog anyway */
  }
  return { changed: false };
}

/**
 * Periodic backstop for tables created/dropped/renamed OUT-OF-BAND (not via governed ETL):
 * for every running datalake whose gateway is currently WARM, pull the live catalog and
 * enqueue a recompile when it changed. Gated on `/gw/status` (which derives state WITHOUT
 * waking the pool) so a sleeping gateway is never cold-booted — an asleep gateway has no
 * held session to serve stale grants to, and its next connect refreshes the catalog anyway.
 *
 * Runs in the caller's DB scope; assumes initDataplane already ran (the cron does it). Pass
 * a context WITHOUT executionCtx so kickDispatch is a no-op here — the cron's own drain pass
 * (which runs right after this) delivers the freshly-enqueued snapshots in the same tick.
 */
export async function refreshWarmCatalogs(
  env: Env,
): Promise<{ scanned: number; warm: number; changed: number }> {
  const { rows } = await query<CatalogEndpoint>(
    `SELECT id, org_id, status, server_token, gateway_url
       FROM waddling.datalake WHERE status = 'running'`,
  );
  let warm = 0;
  let changed = 0;
  for (const ep of rows) {
    try {
      const st = await gatewayClientFor(ep).status(ep.id); // no wake
      if (st.state !== 'running') continue;
      warm++;
      const r = await refreshCatalogAndEnqueue({ env }, ep.id, ep);
      if (r.changed) changed++;
    } catch {
      /* best-effort per datalake; keep scanning the rest */
    }
  }
  return { scanned: rows.length, warm, changed };
}

/** Backoff: first retry ~15s, doubling, capped at the 5m cron cadence. */
const BASE_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Give up a row after sustained failure (~ tens of minutes of retries). */
const MAX_ATTEMPTS = 12;
/** Rows processed per drain pass. */
const DRAIN_BATCH = 50;

interface RevokePayload {
  kind: 'user' | 'jti' | 'session';
  id: string;
  reason?: string;
  expiresUs?: number;
}

/**
 * Enqueue (or coalesce onto) the single pending snapshot dispatch for a datalake. The
 * partial unique index `gateway_dispatch_snapshot_uq` keeps it to one row per datalake;
 * re-enqueue flips it back to 'pending' and resets the retry schedule. payload stays NULL
 * — the drain recompiles the full endpoint policy. Runs in the caller's DB scope.
 */
export async function enqueueSnapshotDispatch(datalakeId: string): Promise<void> {
  await query(
    `INSERT INTO waddling.gateway_dispatch (datalake_id, kind, status, attempts, next_attempt_at)
       VALUES ($1, 'snapshot', 'pending', 0, now())
     ON CONFLICT (datalake_id) WHERE kind = 'snapshot'
     DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = now(),
                   last_error = NULL, updated_at = now()`,
    [datalakeId],
  );
}

/**
 * Enqueue (or coalesce onto) a pending revoke dispatch for a (datalake, subject). The
 * partial unique index `gateway_dispatch_revoke_pending_uq` dedupes repeat revokes of the
 * same subject while one is still pending. Runs in the caller's DB scope.
 */
export async function enqueueRevokeDispatch(
  datalakeId: string,
  revoke: RevokePayload,
): Promise<void> {
  await query(
    `INSERT INTO waddling.gateway_dispatch
       (datalake_id, kind, dedup_key, payload, status, attempts, next_attempt_at)
       VALUES ($1, 'revoke', $2, $3::jsonb, 'pending', 0, now())
     ON CONFLICT (datalake_id, dedup_key) WHERE kind = 'revoke' AND status = 'pending'
     DO UPDATE SET payload = $3::jsonb, attempts = 0, next_attempt_at = now(),
                   last_error = NULL, updated_at = now()`,
    [datalakeId, revoke.id, JSON.stringify(revoke)],
  );
}

/**
 * Fire-and-forget immediate drain of one datalake's due rows, in its OWN DB scope (the
 * request's pool closes on response, so we can't reuse it from waitUntil). The cron tick
 * is the backstop if this attempt fails. Always enqueue BEFORE calling this so the work is
 * durable even if the isolate dies before the drain runs.
 */
export function kickDispatch(
  c: { env: Env; executionCtx?: ExecutionContext },
  datalakeId: string,
): void {
  // c.executionCtx is a GETTER that THROWS when no ExecutionContext is present (Hono on
  // in-process loopback — e.g. the onboarding seed dispatching routes via app.request).
  // No ctx ⇒ no waitUntil; the row is already enqueued, so the cron drain delivers it.
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (!ctx) return;
  ctx.waitUntil(
    runInDbScope(undefined, c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL ?? '', async () => {
      await drainGatewayDispatch(c.env, { onlyDatalakeId: datalakeId });
    }).catch(() => {
      /* best-effort fast path; the cron drain retries */
    }),
  );
}

interface DispatchRow {
  id: string;
  datalake_id: string;
  kind: 'snapshot' | 'revoke';
  payload: RevokePayload | null;
  attempts: number;
}

/**
 * Deliver due dispatch rows (snapshots + revokes) to the gateway, with exponential
 * backoff on failure. Called by the control-api 5-minute cron (whole backlog) and by
 * kickDispatch (one datalake, immediately after an edit). Must run inside a DB scope;
 * initialises the gateway transport itself (idempotent) so it works from cron too.
 */
export async function drainGatewayDispatch(
  env: Env,
  opts: { onlyDatalakeId?: string; limit?: number } = {},
): Promise<{ delivered: number; failed: number }> {
  initDataplane(env.GATEWAY_BASE_URL);
  const { onlyDatalakeId, limit = DRAIN_BATCH } = opts;

  const due = await query<DispatchRow>(
    `SELECT id, datalake_id, kind, payload, attempts
       FROM waddling.gateway_dispatch
      WHERE status = 'pending' AND next_attempt_at <= now()
        AND ($1::text IS NULL OR datalake_id = $1)
      ORDER BY next_attempt_at ASC
      LIMIT $2`,
    [onlyDatalakeId ?? null, limit],
  );

  let delivered = 0;
  let failed = 0;
  for (const row of due.rows) {
    try {
      await deliverRow(env, row);
      if (row.kind === 'revoke') {
        // Revokes are transient denylist work — no value kept once delivered.
        await query(`DELETE FROM waddling.gateway_dispatch WHERE id = $1`, [row.id]);
      } else {
        await query(
          `UPDATE waddling.gateway_dispatch
              SET status = 'delivered', last_error = NULL, updated_at = now()
            WHERE id = $1 AND status = 'pending'`,
          [row.id],
        );
      }
      delivered++;
    } catch (e) {
      failed++;
      const attempts = row.attempts + 1;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** row.attempts, MAX_BACKOFF_MS);
      const giveUp = attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE waddling.gateway_dispatch
            SET attempts = $2,
                status = $3,
                next_attempt_at = now() + ($4::bigint * interval '1 millisecond'),
                last_error = $5,
                updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [
          row.id,
          attempts,
          giveUp ? 'failed' : 'pending',
          giveUp ? 0 : backoff,
          e instanceof Error ? e.message : String(e),
        ],
      ).catch(() => {
        /* bookkeeping is best-effort; the row stays pending and retries next tick */
      });
    }
  }
  return { delivered, failed };
}

/** Deliver one row; throws on failure so the caller backs the row off. */
async function deliverRow(env: Env, row: DispatchRow): Promise<void> {
  if (row.kind === 'snapshot') {
    // Recompile from CURRENT acl_rule/acl_policy state and push. surfacePushError makes a
    // gateway failure throw (→ backoff) rather than resolve best-effort. A non-running
    // endpoint resolves to pushSkipped (no throw): nothing to deliver now — it arms from
    // the director cache / next connect, so we treat it as delivered.
    await recompileAndPush({ env }, row.datalake_id, { surfacePushError: true });
    return;
  }
  const p = row.payload;
  if (!p || !p.kind || !p.id) return; // malformed; treat as delivered (drops the row)
  await gatewayClientFor().revoke({
    datalakeId: row.datalake_id,
    kind: p.kind,
    id: p.id,
    reason: p.reason ?? '',
    expiresUs: p.expiresUs,
  });
}
