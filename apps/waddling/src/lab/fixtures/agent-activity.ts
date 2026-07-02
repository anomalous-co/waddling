/**
 * Agent activity fixtures — audit trail + usage per agent.
 *
 * All ISO timestamps are derived at call time (same pattern as quackboard.ts)
 * to prevent stale "N hours ago" reads when the server has been running a while.
 * Never store raw `Date.now()` / `toISOString()` at module scope here.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentActivityEntry {
  id: string;
  agentId: string;
  at: string;            // ISO — computed at REQUEST TIME (no module-scope Date.now())
  kind: 'query' | 'grant' | 'revoke' | 'connect' | 'deny';
  summary: string;       // e.g. "SELECT … FROM analytics.events" or "Granted read on analytics.conversions"
  decision?: 'allow' | 'deny';   // for query/access attempts
  table?: string;        // schema.table the action touched, when relevant
  costCents?: number;    // usage cost for queries (small ints)
}

export interface AgentActivityRollup {
  queriesToday: number;
  denials: number;
  creditSpentCents: number;
  lastActiveAt: string;  // ISO at request time
}

// ── Agent id refs — match agents.ts / quackboard.ts so joins hit ──────────────

const AGT_ETL = 'agt_01j8k9m2n3p4q5r6s7t8u9v0w';
const AGT_BOT = 'agt_02j8k9m2n3p4q5r6s7t8u9v0x';
// legacy-reporter (agt_03…) has zero activity — no entries seeded; EmptyState shows

// ── Static entry bases ────────────────────────────────────────────────────────

interface EntryBase extends Omit<AgentActivityEntry, 'at'> {
  atMinutesAgo: number;
}

const ENTRY_BASES: EntryBase[] = [
  // ── analytics-etl ──────────────────────────────────────────────────────────
  {
    id: 'act_001',
    agentId: AGT_ETL,
    atMinutesAgo: 300,
    kind: 'connect',
    summary: 'Session connected',
  },
  {
    id: 'act_002',
    agentId: AGT_ETL,
    atMinutesAgo: 250,
    kind: 'grant',
    summary: 'Granted read on analytics.conversions',
    table: 'analytics.conversions',
  },
  {
    id: 'act_003',
    agentId: AGT_ETL,
    atMinutesAgo: 240,
    kind: 'query',
    summary: "SELECT event_type, COUNT(*) FROM analytics.events WHERE date > '2026-06-28' GROUP BY 1",
    decision: 'allow',
    table: 'analytics.events',
    costCents: 3,
  },
  {
    id: 'act_004',
    agentId: AGT_ETL,
    atMinutesAgo: 120,
    kind: 'query',
    summary: "SELECT SUM(revenue) FROM analytics.conversions WHERE cohort = 'jun-2026'",
    decision: 'allow',
    table: 'analytics.conversions',
    costCents: 4,
  },
  {
    id: 'act_005',
    agentId: AGT_ETL,
    atMinutesAgo: 90,
    kind: 'deny',
    summary: 'SELECT * FROM analytics.pii_users LIMIT 10',
    decision: 'deny',
    table: 'analytics.pii_users',
  },
  {
    id: 'act_006',
    agentId: AGT_ETL,
    atMinutesAgo: 60,
    kind: 'query',
    summary: 'SELECT user_id, session_count FROM analytics.events GROUP BY 1 ORDER BY 2 DESC LIMIT 100',
    decision: 'allow',
    table: 'analytics.events',
    costCents: 5,
  },
  {
    id: 'act_007',
    agentId: AGT_ETL,
    atMinutesAgo: 5,
    kind: 'deny',
    summary: 'SELECT email FROM analytics.pii_users WHERE churned = true',
    decision: 'deny',
    table: 'analytics.pii_users',
  },
  {
    id: 'act_008',
    agentId: AGT_ETL,
    atMinutesAgo: 3,
    kind: 'query',
    summary: "SELECT COUNT(*) FROM analytics.events WHERE dt = '2026-06-29'",
    decision: 'allow',
    table: 'analytics.events',
    costCents: 2,
  },
  // ── insight-bot ────────────────────────────────────────────────────────────
  {
    id: 'act_009',
    agentId: AGT_BOT,
    atMinutesAgo: 480,
    kind: 'connect',
    summary: 'Session connected',
  },
  {
    id: 'act_010',
    agentId: AGT_BOT,
    atMinutesAgo: 78,
    kind: 'query',
    summary: 'SELECT cohort, conversion_rate FROM analytics.conversions GROUP BY 1',
    decision: 'allow',
    table: 'analytics.conversions',
    costCents: 3,
  },
  {
    id: 'act_011',
    agentId: AGT_BOT,
    atMinutesAgo: 40,
    kind: 'deny',
    summary: 'SELECT customer_id, ltv FROM analytics.customer_profiles LIMIT 50',
    decision: 'deny',
    table: 'analytics.customer_profiles',
  },
  {
    id: 'act_012',
    agentId: AGT_BOT,
    atMinutesAgo: 11,
    kind: 'query',
    summary: "SELECT AVG(session_duration_ms) FROM analytics.events WHERE date = '2026-06-29'",
    decision: 'allow',
    table: 'analytics.events',
    costCents: 2,
  },
];

// ── Helper ────────────────────────────────────────────────────────────────────

function minsAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// ── Factory function (call at request time) ───────────────────────────────────

/**
 * Returns activity entries for the given agentId (or all if omitted),
 * with `at` computed now. Entries are returned newest-first.
 */
export function makeFixtureActivity(agentId?: string): AgentActivityEntry[] {
  const bases = agentId
    ? ENTRY_BASES.filter((e) => e.agentId === agentId)
    : ENTRY_BASES;

  return bases
    .map(({ atMinutesAgo, ...base }) => ({
      ...base,
      at: minsAgo(atMinutesAgo),
    }))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
