// UI-only types for the agent-detail page that have no @waddling/control-schema
// equivalent yet. Kept page-local (not in control-schema) until the backend
// settles a real contract.

/**
 * A private agent-memory entry surfaced read-only for oversight.
 *
 * The control-api memory endpoint is not wired in production yet (the fetch
 * 404s and the section renders empty), so this shape mirrors what the Memory
 * section renders rather than a committed server contract.
 */
export interface QbMemoryEntry {
  id: string;
  agentId: string;
  key: string;
  valuePreview: string;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  sizeBytes: number;
}
