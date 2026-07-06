// UI-only types for the agent-detail page that have no @waddling/control-schema
// equivalent yet. Kept page-local (not in control-schema) until the backend
// settles a real contract.

/**
 * A private agent-memory entry surfaced read-only for oversight. Shape of the
 * rows returned by GET /api/cp/quackboard/memory (the memory lake's
 * /ctrl/qb-memory-all: agent_role/key/content/ts, plus the agentName the
 * control plane joins on).
 */
export interface QbMemoryEntry {
  agent_role: string;
  key: string | null;
  content: string;
  /** ISO timestamp of the write. */
  ts: string;
  agentName?: string;
}
