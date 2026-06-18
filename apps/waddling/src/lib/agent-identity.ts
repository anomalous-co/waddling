/**
 * Agent identity (AAP) — resolve-and-restamp core (W1).
 *
 * Strategy A from waddling-context/agent-auth.md: AAP is a control-plane identity
 * layer. The inbound bearer (API key, or — phase 2 — an OAuth token) is verified in
 * api/cp/_shared `resolveCaller`, then *resolved* here into an AgentIdentity. Its
 * fields are stamped into the existing gateway session JWT and into audit / PostHog.
 * No separate AAP wire token is minted, so the gateway/birdshot verification path is
 * unchanged (it still verifies the RS256 session JWT via JWKS and ignores extra claims).
 *
 * AAP capability (the coarse action, e.g. 'waddling_connect') is recorded here for
 * tracing; it is deliberately NOT the same thing as a birdshot ACL grant (the
 * fine-grained table/column/row policy lives in acl_rule + the policy compiler).
 */
import { queryOne } from '@/lib/db';
import { getPostHogServer } from '@/lib/posthog-server';
import type { AgentIdentity, AgentMode } from '@/lib/types';

/** AAP capabilities — coarse actions, mirrored from the External MCP tool surface. */
export const CAPABILITY = {
  connect: 'waddling_connect',
  query: 'waddling_query',
  describe: 'waddling_describe',
} as const;

/** Extra session-JWT claims carrying AAP identity. `id`/`sub` stay = agent:<id>. */
export interface AapClaims {
  /** 'delegated' | 'autonomous' */
  mode: AgentMode;
  /** capability invoked (coarse action). */
  cap: string;
  /** delegating human (key owner, or run-as user); omitted if unknown. */
  act?: string;
}

interface AgentIdentityRow {
  id: string;
  name: string;
  mode: AgentMode;
  status: string;
  /** auth.user.id that owns the agent's API key (the delegating human, autonomous mode). */
  owner_user: string | null;
}

/**
 * Resolve the full AAP identity for an agent: id, name, mode, and the human who owns
 * its API key (on-behalf-of for autonomous agents). Throws via the caller's handle()
 * funnel if the agent is missing.
 */
export async function resolveAgentIdentity(
  agentId: string,
): Promise<AgentIdentity | null> {
  const row = await queryOne<AgentIdentityRow>(
    `SELECT a.id, a.name, a.mode, a.status, k."userId" AS owner_user
       FROM waddling.agent a
       LEFT JOIN "apikey" k ON k.id = a.api_key_id
      WHERE a.id = $1`,
    [agentId],
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    status: row.status as AgentIdentity['status'],
    onBehalfOf: row.owner_user ?? undefined,
  };
}

/**
 * Emit a PostHog event keyed on the AGENT principal (not the human), so an agent's
 * timeline is queryable and distinct from its owner's. For autonomous agents the
 * distinctId is meaningful per-key; that is the whole point of one-key-per-agent —
 * Claude gives us no finer identity over the wire (agent-auth.md §cardinality).
 */
export function captureAgentEvent(params: {
  identity: AgentIdentity;
  orgId: string;
  event: string;
  capability: string;
  /** delegating human for this action (run-as user overrides the key owner). */
  onBehalfOf?: string;
  sessionId?: string;
  jti?: string;
  endpointId?: string;
  /** ACL/grant detail — kept separate from capability (different layer). */
  extra?: Record<string, unknown>;
}): void {
  const { identity, orgId, event, capability, onBehalfOf, sessionId, jti, endpointId, extra } =
    params;
  const ph = getPostHogServer();
  // Register the agent as its own identity so per-agent timelines hold.
  ph.identify({
    distinctId: `agent:${identity.id}`,
    properties: {
      $set: {
        agent_name: identity.name,
        agent_mode: identity.mode,
        delegated_by: onBehalfOf ?? identity.onBehalfOf,
      },
    },
  });
  ph.capture({
    distinctId: `agent:${identity.id}`,
    event,
    properties: {
      agent_name: identity.name,
      agent_mode: identity.mode,
      on_behalf_of: onBehalfOf ?? identity.onBehalfOf,
      capability,
      agent_session_id: sessionId,
      jti,
      endpoint_id: endpointId,
      ...extra,
    },
    groups: { organization: orgId },
  });
}
