/**
 * /api/cp/usage — Hono port of apps/waddling/src/app/api/cp/usage/route.ts.
 * Metering rollups + ingest (§4b admin_usage, §2 usage_event).
 *
 * GET  / → monthly rollup (queries, rows/bytes scanned, active sessions, $ est) for
 *          the org's current period, optionally per-agent. Reads usage_event.
 * POST / → ingest a usage_event (gateway/MCP push query metrics here). Org-scoped.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import { getActivePlanName } from '../lib/entitlements';
import { getBalanceMicro, MICRO_PER_USD } from '../lib/credits';
import type { Env } from '../lib/env';
import { resolveCaller, parseBody, handle, ok } from '../lib/cp-shared';
import type { UsageRollup } from '../lib/types';

const IngestSchema = z.object({
  agentId: z.string().optional(),
  datalakeId: z.string().optional(),
  kind: z.enum(['query', 'rows_scanned', 'bytes_scanned', 'session']),
  quantity: z.number().int().nonnegative().default(1),
  durationMs: z.number().int().nonnegative().optional(),
});

/**
 * Resolve a `period` query param into a [start,end) window + the time-bucket
 * granularity for the series. Accepts rolling windows ('24h','7d','30d') and a
 * calendar month ('YYYY-MM'). Bucket unit is restricted to a literal allow-list
 * ('hour'|'day') so it is safe to inline into SQL.
 */
function resolvePeriod(period: string): {
  startIso: string;
  endIso: string;
  unit: 'hour' | 'day';
  step: string;
} {
  const now = new Date();
  if (/^\d{4}-\d{2}$/.test(period)) {
    const start = new Date(`${period}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { startIso: start.toISOString(), endIso: end.toISOString(), unit: 'day', step: '1 day' };
  }
  const map: Record<string, { ms: number; unit: 'hour' | 'day'; step: string }> = {
    '24h': { ms: 24 * 3600e3, unit: 'hour', step: '1 hour' },
    '7d': { ms: 7 * 86400e3, unit: 'day', step: '1 day' },
    '30d': { ms: 30 * 86400e3, unit: 'day', step: '1 day' },
  };
  const w = map[period] ?? map['30d']!;
  const start = new Date(now.getTime() - w.ms);
  return { startIso: start.toISOString(), endIso: now.toISOString(), unit: w.unit, step: w.step };
}

const usage = new Hono<{ Bindings: Env }>();

// GET / — monthly rollup + bucketed series.
usage.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const agentId = c.req.query('agentId') ?? null;
    const period = c.req.query('period') ?? new Date().toISOString().slice(0, 7);
    const { startIso, endIso, unit, step } = resolvePeriod(period);

    const agg = await queryOne<{
      queries: string;
      rows_scanned: string;
      bytes_scanned: string;
    }>(
      `SELECT
         COALESCE(SUM(quantity) FILTER (WHERE kind='query'),0)::text         AS queries,
         COALESCE(SUM(quantity) FILTER (WHERE kind='rows_scanned'),0)::text  AS rows_scanned,
         COALESCE(SUM(quantity) FILTER (WHERE kind='bytes_scanned'),0)::text AS bytes_scanned
       FROM waddling.usage_event
      WHERE org_id = $1
        AND ts >= $2::timestamptz AND ts < $3::timestamptz
        AND ($4::text IS NULL OR agent_id = $4)`,
      [caller.orgId, startIso, endIso, agentId],
    );
    const active = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM waddling.agent_session
        WHERE org_id = $1 AND status = 'active'
          AND ($2::text IS NULL OR agent_id = $2)`,
      [caller.orgId, agentId],
    );

    // Bucketed time series for the charts. `unit` is a literal allow-list value.
    const seriesRows = await query<{
      ts: string;
      queries: number;
      rows_scanned: number;
      sessions: number;
    }>(
      `WITH buckets AS (
         SELECT generate_series(
                  date_trunc('${unit}', $2::timestamptz),
                  date_trunc('${unit}', $3::timestamptz),
                  $4::interval
                ) AS bucket
       ),
       q AS (
         SELECT date_trunc('${unit}', ts) AS bucket,
                SUM(quantity) FILTER (WHERE kind='query')        AS queries,
                SUM(quantity) FILTER (WHERE kind='rows_scanned') AS rows_scanned
           FROM waddling.usage_event
          WHERE org_id = $1 AND ts >= $2::timestamptz AND ts < $3::timestamptz
            AND ($5::text IS NULL OR agent_id = $5)
          GROUP BY 1
       ),
       s AS (
         SELECT date_trunc('${unit}', started_at) AS bucket, count(*) AS sessions
           FROM waddling.agent_session
          WHERE org_id = $1 AND started_at >= $2::timestamptz AND started_at < $3::timestamptz
            AND ($5::text IS NULL OR agent_id = $5)
          GROUP BY 1
       )
       SELECT b.bucket::text                    AS ts,
              COALESCE(q.queries, 0)::int       AS queries,
              COALESCE(q.rows_scanned, 0)::int  AS rows_scanned,
              COALESCE(s.sessions, 0)::int      AS sessions
         FROM buckets b
         LEFT JOIN q ON q.bucket = b.bucket
         LEFT JOIN s ON s.bucket = b.bucket
        ORDER BY b.bucket`,
      [caller.orgId, startIso, endIso, step, agentId],
    );
    const series = seriesRows.rows.map((r) => ({
      ts: r.ts,
      queries: Number(r.queries),
      rowsScanned: Number(r.rows_scanned),
      sessions: Number(r.sessions),
    }));

    const queries = Number(agg?.queries ?? 0);
    const bytes = Number(agg?.bytes_scanned ?? 0);

    // Real spend for this period = the sum of the actual credit_ledger DEBIT rows
    // (session duration + per-query floor), not a per-unit estimate. amount_micro is
    // negative for debits, so negate to get a positive µUSD spend. Org-scoped: the
    // ledger has no agent_id, so a per-agent rollup can't attribute spend (left
    // undefined there rather than showing a wrong number). See docs/credit-unit-economics.md.
    const spend = await queryOne<{ spent_micro: string }>(
      `SELECT COALESCE(-SUM(amount_micro) FILTER (WHERE entry_type='debit'), 0)::text AS spent_micro
         FROM waddling.credit_ledger
        WHERE org_id = $1 AND ts >= $2::timestamptz AND ts < $3::timestamptz`,
      [caller.orgId, startIso, endIso],
    );
    const spentMicro = Number(spend?.spent_micro ?? 0);
    const spentUsd = spentMicro / MICRO_PER_USD;

    const rollup: UsageRollup = {
      orgId: caller.orgId,
      agentId: agentId ?? undefined,
      period,
      queries,
      rowsScanned: Number(agg?.rows_scanned ?? 0),
      bytesScanned: bytes,
      activeSessions: Number(active?.n ?? 0),
      // Org-wide actual spend; omitted for a per-agent view (ledger isn't agent-scoped).
      estimatedCost: agentId ? undefined : spentUsd,
    };
    const planName = await getActivePlanName(caller.orgId);
    const totalSessions = series.reduce((acc, p) => acc + p.sessions, 0);
    // Prepaid credit balance (µUSD ledger → USD for display). Drives the dashboard's
    // remaining-credits widget + low-balance UX; the actual cutoff is enforced server-side.
    const balanceMicro = await getBalanceMicro(caller.orgId);
    return ok(c, {
      rollup,
      series,
      totalQueries: queries,
      totalSessions,
      plan: planName,
      planName,
      credit: {
        balanceMicro,
        balanceUsd: balanceMicro / MICRO_PER_USD,
        // Actual prepaid spend drawn down this period (org-wide).
        spentMicro,
        spentUsd,
      },
    });
  }),
);

// POST / — ingest a usage_event.
usage.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const e = await parseBody(c, IngestSchema);
    await query(
      `INSERT INTO waddling.usage_event (org_id, agent_id, datalake_id, kind, quantity, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [caller.orgId, e.agentId ?? null, e.datalakeId ?? null, e.kind, e.quantity, e.durationMs ?? null],
    );
    return ok(c, { success: true }, 201);
  }),
);

export { usage };
