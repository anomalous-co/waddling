/**
 * Shared display formatters for the UX lab surfaces.
 *
 * Byte/row sizing for catalog tables, workspace scratch tables, and lake cards.
 * Relative-time formatting lives in `@/components/waddling/agent-status`
 * (`formatRelative`) — import it from there, not here.
 *
 * Note: the Quackboard memory view keeps its own compact byte formatter (B/KB
 * only) on purpose — memory values are tiny and read better without the full
 * unit ladder. That is a justified local deviation, not drift.
 */

/** Human-readable byte size with a full unit ladder; em-dash for zero. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Compact row count (1.2K / 3.4M / 5.6B). */
export function formatRows(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
