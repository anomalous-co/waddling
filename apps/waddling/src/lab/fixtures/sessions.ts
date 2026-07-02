/**
 * SessionRow — lab-local type for /api/cp/sessions.
 * The real SessionSummary (control-schema) has `datalakeId` but no denormalised
 * display names or `lastQuery`. We add those here for the live-sessions table.
 * These fields (agentName, lakeName, lastQuery) are GUESSED / denormalised.
 */
export interface SessionRow {
  id: string;
  agentId: string;
  /** Display name of the agent (join from agents table — guessed). */
  agentName: string;
  datalakeId: string;
  /** Display name of the lake (join from datalakes table — guessed). */
  lakeName: string;
  /** Most-recent query text, truncated server-side (guessed). */
  lastQuery?: string;
  startedAt: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
}

/** Fixture live sessions for the UX lab. */
export const FIXTURE_SESSIONS: SessionRow[] = [
  {
    id: 'sess_01active',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    agentName: 'analytics-etl',
    datalakeId: 'dl_01j8events',
    lakeName: 'Event Lake',
    lastQuery: 'SELECT date_trunc(\'day\', ts) AS day, count(*) AS events FROM analytics.events GROUP BY 1 ORDER BY 1 DESC',
    startedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    status: 'active',
  },
  {
    id: 'sess_02active',
    agentId: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    agentName: 'insight-bot',
    datalakeId: 'dl_01j8events',
    lakeName: 'Event Lake',
    lastQuery: 'SELECT user_id, sum(revenue) FROM analytics.conversions WHERE ts > now() - INTERVAL 7 DAY GROUP BY 1 LIMIT 100',
    startedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    status: 'active',
  },
];
