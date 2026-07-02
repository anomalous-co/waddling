import type { AgentSummary } from '@/lib/types';

/**
 * Base agent shapes (no lastSeenAt — computed fresh at request time).
 *
 * status:'active' with a recent lastSeenAt → displayed as "active"
 * status:'active' with a stale lastSeenAt  → displayed as "idle" at the call site
 * status:'suspended'                        → displayed as "suspended"
 *
 * One is delegated (mode:'delegated') to satisfy the spec's "one delegated" requirement.
 *
 * IMPORTANT: lastSeenAt is expressed as `lastSeenMinutesAgo` here and converted to
 * absolute ISO timestamps in `makeFixtureAgents()` at request time. This ensures the
 * Home launchpad always shows a realistic mix (Active / Idle / Suspended) regardless
 * of how long the server has been running. A static `Date.now()` call at module load
 * would freeze and cause all agents to read as "Idle" after 15 minutes of uptime.
 */

interface FixtureAgentBase extends Omit<AgentSummary, 'lastSeenAt'> {
  /** Minutes ago this agent was last seen. Converted to ISO in makeFixtureAgents(). */
  lastSeenMinutesAgo: number;
}

const FIXTURE_AGENT_BASES: FixtureAgentBase[] = [
  {
    id: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    name: 'analytics-etl',
    description: 'Runs nightly ETL pipelines over the event lake.',
    defaultRole: 'reader',
    mode: 'autonomous',
    status: 'active',
    lastSeenMinutesAgo: 2, // ~2 min ago → Active
    apiKeyId: 'key_01abc',
    owner: 'mirri@anomalous.computer',
    activeSessions: 1,
  },
  {
    id: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    name: 'insight-bot',
    description: 'LLM agent for ad-hoc metric lookups; human-delegated.',
    defaultRole: 'analyst',
    mode: 'delegated',
    status: 'active',
    lastSeenMinutesAgo: 50, // ~50 min ago → Idle (> 15 min threshold)
    owner: 'mirri@anomalous.computer',
    activeSessions: 0,
  },
  {
    id: 'agt_03j8k9m2n3p4q5r6s7t8u9v0y',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    name: 'legacy-reporter',
    description: 'Deprecated pipeline — suspended pending cleanup.',
    defaultRole: 'reader',
    mode: 'autonomous',
    status: 'suspended',
    lastSeenMinutesAgo: 3 * 24 * 60, // 3 days ago
    apiKeyId: 'key_03def',
    owner: 'mirri@anomalous.computer',
    activeSessions: 0,
  },
];

/**
 * Returns fixture agents with `lastSeenAt` computed fresh from the current time.
 * Call this at request time (in route handlers) to ensure the timestamps remain
 * accurate regardless of server uptime.
 */
export function makeFixtureAgents(): AgentSummary[] {
  const now = Date.now();
  return FIXTURE_AGENT_BASES.map(({ lastSeenMinutesAgo, ...base }) => ({
    ...base,
    lastSeenAt: new Date(now - lastSeenMinutesAgo * 60 * 1000).toISOString(),
  }));
}

/**
 * Static snapshot — baked at module load. Use only when request-time freshness
 * is not required (e.g. seeding tests). Prefer `makeFixtureAgents()` in handlers.
 */
export const FIXTURE_AGENTS: AgentSummary[] = makeFixtureAgents();

/**
 * AgentRow — lab-local extension of AgentSummary that adds fields present on
 * the full agent detail endpoint (GET /api/cp/agents/:id). The `AclRuleRow` /
 * `SessionRow` precedent: richer server-response types live in fixtures/, not
 * in control-schema.
 */
export interface AgentRow extends AgentSummary {
  /** ISO timestamp when the agent was created. */
  createdAt: string;
}

const FIXTURE_AGENT_CREATED_AT: Record<string, string> = {
  'agt_01j8k9m2n3p4q5r6s7t8u9v0w': '2026-05-15T10:00:00Z',
  'agt_02j8k9m2n3p4q5r6s7t8u9v0x': '2026-06-01T08:30:00Z',
  'agt_03j8k9m2n3p4q5r6s7t8u9v0y': '2025-12-01T00:00:00Z',
};

/**
 * Returns a single fixture AgentRow by id with lastSeenAt computed at request time.
 */
export function makeFixtureAgentRow(id: string): AgentRow | undefined {
  const agents = makeFixtureAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent) return undefined;
  return {
    ...agent,
    createdAt: FIXTURE_AGENT_CREATED_AT[id] ?? new Date().toISOString(),
  };
}
