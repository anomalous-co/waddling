/**
 * AgentKey — lab-local type for /api/cp/agents/:id/keys.
 * The real control-plane key response carries these fields.
 */
export interface AgentKey {
  id: string;
  label: string;
  /** Masked display prefix, e.g. "sk_agent_a1b2c3d4…" */
  maskedPrefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface FixtureKeyBase extends Omit<AgentKey, 'lastUsedAt'> {
  /** Minutes ago this key was last used. Converted to ISO in makeFixtureAgentKeys(). */
  lastUsedMinutesAgo?: number;
}

const FIXTURE_KEY_BASES: Record<string, FixtureKeyBase[]> = {
  // analytics-etl — one active production key
  'agt_01j8k9m2n3p4q5r6s7t8u9v0w': [
    {
      id: 'key_01abc',
      label: 'Production key',
      maskedPrefix: 'sk_agent_a1b2c3d4…',
      createdAt: '2026-05-15T10:00:00Z',
      lastUsedMinutesAgo: 2,
    },
  ],
  // insight-bot — delegated mode, no own key
  'agt_02j8k9m2n3p4q5r6s7t8u9v0x': [],
  // legacy-reporter — one legacy key (agent is suspended)
  'agt_03j8k9m2n3p4q5r6s7t8u9v0y': [
    {
      id: 'key_03def',
      label: 'Legacy key',
      maskedPrefix: 'sk_agent_d3f4g5h6…',
      createdAt: '2025-12-01T00:00:00Z',
      lastUsedMinutesAgo: 3 * 24 * 60, // 3 days ago
    },
  ],
};

/**
 * Returns fixture agent keys for a given agentId with lastUsedAt computed fresh
 * from the current time. Call at request time to keep timestamps realistic.
 */
export function makeFixtureAgentKeys(agentId: string): AgentKey[] {
  const now = Date.now();
  const bases = FIXTURE_KEY_BASES[agentId] ?? [];
  return bases.map(({ lastUsedMinutesAgo, ...base }) => ({
    ...base,
    ...(lastUsedMinutesAgo !== undefined
      ? { lastUsedAt: new Date(now - lastUsedMinutesAgo * 60 * 1000).toISOString() }
      : {}),
  }));
}
