/**
 * WorkspaceSummary — lab-local type.
 *
 * A workspace is a per-agent durable DuckDB scratch DB attached to a data lake.
 * This type is not yet in @waddling/control-schema; it mirrors the expected shape
 * of `GET /api/cp/workspaces → { workspaces: WorkspaceSummary[] }`.
 */
export interface WorkspaceTable {
  name: string;        // e.g. "stg_events", "daily_rollup"
  rowCount: number;
  sizeBytes: number;
  lastWriteAt: string; // ISO — computed at request time
}

export interface WorkspaceSummary {
  id: string;
  agentId: string;
  /** Display name of the agent (denormalized for convenience; join source = agents table). */
  agentName: string;
  datalakeId: string;
  /** ISO timestamp of the last agent activity in this workspace. */
  lastActiveAt: string;
  /** Current size of the workspace DuckDB file in bytes. */
  sizeBytes: number;
  /** Materialized scratch tables the agent has written into this workspace. */
  scratchTables: WorkspaceTable[];
}

interface WorkspaceTableBase extends Omit<WorkspaceTable, 'lastWriteAt'> {
  /** Minutes ago the table was last written. Converted to ISO in makeFixtureWorkspaces(). */
  lastWriteMinutesAgo: number;
}

interface FixtureWorkspaceBase extends Omit<WorkspaceSummary, 'lastActiveAt' | 'scratchTables'> {
  /** Minutes ago the workspace was last active. Converted to ISO in makeFixtureWorkspaces(). */
  lastActiveMinutesAgo: number;
  scratchTableBases: WorkspaceTableBase[];
}

const FIXTURE_WORKSPACE_BASES: FixtureWorkspaceBase[] = [
  {
    id: 'ws_01j8alpha',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    agentName: 'analytics-etl',
    datalakeId: 'dl_01j8events',
    lastActiveMinutesAgo: 3,         // 3 min ago — currently active
    sizeBytes: 536_870_912,          // 512 MB
    scratchTableBases: [
      { name: 'stg_events',       rowCount: 2_418_000, sizeBytes: 134_217_728, lastWriteMinutesAgo: 5  }, // 128 MB
      { name: 'daily_rollup',     rowCount:   182_500, sizeBytes:  47_185_920, lastWriteMinutesAgo: 8  }, //  45 MB
      { name: 'anomaly_clusters', rowCount:     3_200, sizeBytes:  12_582_912, lastWriteMinutesAgo: 15 }, //  12 MB
    ],
  },
  {
    id: 'ws_02j8beta',
    agentId: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    agentName: 'insight-bot',
    datalakeId: 'dl_01j8events',
    lastActiveMinutesAgo: 75,        // 75 min ago — idle
    sizeBytes: 134_217_728,          // 128 MB
    scratchTableBases: [
      { name: 'cohort_scratch', rowCount: 95_000, sizeBytes: 29_360_128, lastWriteMinutesAgo: 85 }, // 28 MB
      { name: 'funnel_tmp',     rowCount: 42_000, sizeBytes: 18_874_368, lastWriteMinutesAgo: 90 }, // 18 MB
    ],
  },
  {
    id: 'ws_03j8gamma',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    agentName: 'analytics-etl',
    datalakeId: 'dl_02j8product',    // Product Catalog — still provisioning
    lastActiveMinutesAgo: 14 * 24 * 60, // 14 days ago
    sizeBytes: 8_388_608,            // 8 MB (barely initialized)
    scratchTableBases: [],           // no scratch tables — empty state
  },
];

/**
 * Returns workspace fixtures with `lastActiveAt` and each scratch table's `lastWriteAt`
 * computed fresh from the current time.
 * Call at request time so relative times remain realistic regardless of server uptime.
 */
export function makeFixtureWorkspaces(): WorkspaceSummary[] {
  const now = Date.now();
  return FIXTURE_WORKSPACE_BASES.map(({ lastActiveMinutesAgo, scratchTableBases, ...base }) => ({
    ...base,
    lastActiveAt: new Date(now - lastActiveMinutesAgo * 60 * 1000).toISOString(),
    scratchTables: scratchTableBases.map(({ lastWriteMinutesAgo, ...t }) => ({
      ...t,
      lastWriteAt: new Date(now - lastWriteMinutesAgo * 60 * 1000).toISOString(),
    })),
  }));
}
