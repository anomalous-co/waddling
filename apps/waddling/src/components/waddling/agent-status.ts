import type { AgentSummary } from '@/lib/types';
import type { SemanticStatus } from '@/components/waddling/status-dot';

/**
 * Derive a display semantic status from an agent's real status + lastSeenAt.
 * An agent that is technically 'active' but last seen > 15 min ago is shown
 * as "idle". Only 'active' agents participate in the idle check.
 */
export function agentSemanticStatus(agent: AgentSummary): SemanticStatus {
  if (agent.status === 'suspended' || agent.status === 'revoked') {
    return 'suspended';
  }
  if (agent.status === 'active') {
    const lastSeen = agent.lastSeenAt ? new Date(agent.lastSeenAt) : null;
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    if (!lastSeen || lastSeen.getTime() < fifteenMinAgo) return 'idle';
    return 'active';
  }
  return 'idle';
}

/**
 * Format an ISO timestamp as a human-readable relative time string.
 */
export function formatRelative(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
