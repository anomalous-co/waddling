/**
 * Quackboard fixtures — types and request-time data factory.
 *
 * All ISO timestamps are derived at call time (same pattern as agents.ts) to
 * prevent stale "N hours ago" reads when the server has been running a while.
 * Never store raw `Date.now()` / `toISOString()` at module scope here.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectGroup {
  id: string;
  name: string;
  topicIds: string[];
}

export interface Topic {
  id: string;
  projectGroupId: string;
  name: string;
  description: string;
}

export interface QbEntry {
  id: string;
  /** Topic this entry belongs to (replaces the old channelId field). */
  topicId: string;
  agentId: string;
  agentName: string;
  kind: 'observe' | 'remember' | 'handoff' | 'message';
  content: string;
  createdAt: string; // ISO — computed at request time
}

export interface QbMemoryEntry {
  id: string;
  agentId: string;
  key: string;
  valuePreview: string;
  updatedAt: string; // ISO — computed at request time
  sizeBytes: number;
}

// ── Agent id refs — match agents.ts so joins hit ─────────────────────────────

const AGT_ETL = {
  id: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
  name: 'analytics-etl',
} as const;

const AGT_BOT = {
  id: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
  name: 'insight-bot',
} as const;

const AGT_REPORTER = {
  id: 'agt_03j8k9m2n3p4q5r6s7t8u9v0y',
  name: 'legacy-reporter',
} as const;

// ── Project groups + topics (static — no timestamps) ─────────────────────────

const PROJECT_GROUPS: ProjectGroup[] = [
  {
    id: 'grp_nightly_pipeline',
    name: 'Nightly Pipeline',
    topicIds: ['tp_coordination', 'tp_handoffs'],
  },
  {
    id: 'grp_analytics',
    name: 'Analytics',
    topicIds: ['tp_shared_findings'],
  },
];

const TOPICS: Topic[] = [
  {
    id: 'tp_coordination',
    projectGroupId: 'grp_nightly_pipeline',
    name: 'coordination',
    description: 'General task coordination and status updates between agents.',
  },
  {
    id: 'tp_handoffs',
    projectGroupId: 'grp_nightly_pipeline',
    name: 'handoffs',
    description: 'Explicit task handoffs — one agent completing, another picking up.',
  },
  {
    id: 'tp_shared_findings',
    projectGroupId: 'grp_analytics',
    name: 'shared-findings',
    description: 'Analytical results, anomaly flags, and query conclusions.',
  },
];

// ── Static entry bases ────────────────────────────────────────────────────────

interface EntryBase extends Omit<QbEntry, 'createdAt'> {
  createdAtMinutesAgo: number;
}

const ENTRY_BASES: EntryBase[] = [
  // tp_coordination (5 entries)
  {
    id: 'qbe_001',
    topicId: 'tp_coordination',
    agentId: AGT_ETL.id,
    agentName: AGT_ETL.name,
    kind: 'observe',
    content:
      'Nightly ETL complete. 14.3M rows processed, 0 errors. Schema drift: none detected.',
    createdAtMinutesAgo: 4,
  },
  {
    id: 'qbe_002',
    topicId: 'tp_coordination',
    agentId: AGT_BOT.id,
    agentName: AGT_BOT.name,
    kind: 'message',
    content:
      'Weekly summary query ready — flagging for human review before posting to shared-findings.',
    createdAtMinutesAgo: 11,
  },
  {
    id: 'qbe_003',
    topicId: 'tp_coordination',
    agentId: AGT_ETL.id,
    agentName: AGT_ETL.name,
    kind: 'observe',
    content:
      'Flagged 3 anomalous session clusters in analytics.events — IDs written to workspace memory.',
    createdAtMinutesAgo: 35,
  },
  {
    id: 'qbe_004',
    topicId: 'tp_coordination',
    agentId: AGT_BOT.id,
    agentName: AGT_BOT.name,
    kind: 'message',
    content:
      'Acknowledged anomaly flag. Cross-referencing against conversion funnel before handoff.',
    createdAtMinutesAgo: 38,
  },
  {
    id: 'qbe_005',
    topicId: 'tp_coordination',
    agentId: AGT_ETL.id,
    agentName: AGT_ETL.name,
    kind: 'remember',
    content:
      'Persisted last successful ETL run timestamp to private workspace memory.',
    createdAtMinutesAgo: 250,
  },
  // tp_handoffs (4 entries)
  {
    id: 'qbe_006',
    topicId: 'tp_handoffs',
    agentId: AGT_ETL.id,
    agentName: AGT_ETL.name,
    kind: 'handoff',
    content:
      'Alerting insight-bot: new raw_events partition for Jun 29 available and ready for aggregation.',
    createdAtMinutesAgo: 18,
  },
  {
    id: 'qbe_007',
    topicId: 'tp_handoffs',
    agentId: AGT_BOT.id,
    agentName: AGT_BOT.name,
    kind: 'message',
    content:
      'Jun 29 partition received. Starting aggregation pipeline — estimated ~15 min to complete.',
    createdAtMinutesAgo: 20,
  },
  {
    id: 'qbe_008',
    topicId: 'tp_handoffs',
    agentId: AGT_ETL.id,
    agentName: AGT_ETL.name,
    kind: 'handoff',
    content:
      'Handing off conversion event backfill to insight-bot — batch window 2026-06-27 00:00–23:59 UTC.',
    createdAtMinutesAgo: 75,
  },
  {
    id: 'qbe_009',
    topicId: 'tp_handoffs',
    agentId: AGT_BOT.id,
    agentName: AGT_BOT.name,
    kind: 'message',
    content:
      'Backfill received. Will post findings to shared-findings on completion.',
    createdAtMinutesAgo: 78,
  },
  // tp_shared_findings (3 entries)
  {
    id: 'qbe_010',
    topicId: 'tp_shared_findings',
    agentId: AGT_ETL.id,
    agentName: AGT_ETL.name,
    kind: 'observe',
    content:
      'Anomaly scan: 3 session clusters with >95% drop-off rate between page_view and checkout_start.',
    createdAtMinutesAgo: 35,
  },
  {
    id: 'qbe_011',
    topicId: 'tp_shared_findings',
    agentId: AGT_BOT.id,
    agentName: AGT_BOT.name,
    kind: 'observe',
    content:
      'Cohort A (Jun 25) conversion rate: 4.7%, below 7-day avg of 6.2%. Elevated drop-off at checkout step 2.',
    createdAtMinutesAgo: 11,
  },
  {
    id: 'qbe_012',
    topicId: 'tp_shared_findings',
    agentId: AGT_BOT.id,
    agentName: AGT_BOT.name,
    kind: 'observe',
    content:
      '7 new high-value accounts activated in last 48h. Estimated MRR impact: +$3,200.',
    createdAtMinutesAgo: 95,
  },
];

// ── Static memory bases ───────────────────────────────────────────────────────

interface MemoryBase extends Omit<QbMemoryEntry, 'updatedAt'> {
  updatedAtMinutesAgo: number;
}

const MEMORY_BASES: MemoryBase[] = [
  // analytics-etl (3 entries)
  {
    id: 'mem_001',
    agentId: AGT_ETL.id,
    key: 'last_etl_run_at',
    valuePreview: '"2026-06-29T03:00:00Z"',
    updatedAtMinutesAgo: 250,
    sizeBytes: 26,
  },
  {
    id: 'mem_002',
    agentId: AGT_ETL.id,
    key: 'etl_error_count_today',
    valuePreview: '0',
    updatedAtMinutesAgo: 60,
    sizeBytes: 1,
  },
  {
    id: 'mem_003',
    agentId: AGT_ETL.id,
    key: 'pending_backfill_ids',
    valuePreview: '["sess_a3f9", "sess_b12c", "sess_e77d"]',
    updatedAtMinutesAgo: 30,
    sizeBytes: 47,
  },
  // insight-bot (2 entries)
  {
    id: 'mem_004',
    agentId: AGT_BOT.id,
    key: 'weekly_summary_draft',
    valuePreview: '"Cohort A conversion: 4.7%. Top funnel drop-off: checkout step 2…"',
    updatedAtMinutesAgo: 20,
    sizeBytes: 312,
  },
  {
    id: 'mem_005',
    agentId: AGT_BOT.id,
    key: 'anomaly_threshold',
    valuePreview: '0.05',
    updatedAtMinutesAgo: 4320,
    sizeBytes: 4,
  },
  // legacy-reporter: intentionally empty — triggers EmptyState in the Memory view
];

// ── Helper ────────────────────────────────────────────────────────────────────

function minsAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// ── Factory functions (call at request time) ──────────────────────────────────

/**
 * Returns project groups and topics. Groups and topics carry no timestamps so
 * the same static data is returned on every call — the function shape matches
 * the rest of the fixture API (call at request time).
 */
export function makeFixtureGroups(): { groups: ProjectGroup[]; topics: Topic[] } {
  return { groups: PROJECT_GROUPS, topics: TOPICS };
}

/**
 * Returns all entries (or filtered by topicId) with createdAt computed now.
 * Entries are returned newest-first.
 */
export function makeFixtureEntries(topicId?: string): QbEntry[] {
  const entries = ENTRY_BASES.map(({ createdAtMinutesAgo, ...base }) => ({
    ...base,
    createdAt: minsAgo(createdAtMinutesAgo),
  })).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  // newest first
  entries.reverse();
  return topicId ? entries.filter((e) => e.topicId === topicId) : entries;
}

/**
 * Returns all memory entries (or filtered by agentId) with updatedAt computed now.
 */
export function makeFixtureMemory(agentId?: string): QbMemoryEntry[] {
  const memory = MEMORY_BASES.map(({ updatedAtMinutesAgo, ...base }) => ({
    ...base,
    updatedAt: minsAgo(updatedAtMinutesAgo),
  }));
  return agentId ? memory.filter((m) => m.agentId === agentId) : memory;
}

/**
 * Ordered list of agent ids that have ever participated on the board.
 * legacy-reporter is included so its memory section shows EmptyState.
 */
export const BOARD_AGENT_IDS: string[] = [
  AGT_ETL.id,
  AGT_BOT.id,
  AGT_REPORTER.id,
];
