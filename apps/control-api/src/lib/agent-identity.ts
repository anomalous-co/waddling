/**
 * Agent identity (AAP) — resolve-and-restamp core
 * (ported from apps/waddling/src/lib/agent-identity.ts).
 *
 * Strategy A from waddling-context/agent-auth.md: AAP is a control-plane identity
 * layer. The inbound bearer (API key, or — phase 2 — an OAuth token) is verified in
 * cp-shared `resolveCaller`, then *resolved* here into an AgentIdentity. Its fields
 * are stamped into the existing gateway session JWT and into audit / analytics. No
 * separate AAP wire token is minted, so the gateway/birdshot verification path is
 * unchanged (it still verifies the RS256 session JWT via JWKS and ignores extra claims).
 *
 * AAP capability (the coarse action, e.g. 'waddling_connect') is recorded here for
 * tracing; it is deliberately NOT the same thing as a birdshot ACL grant (the
 * fine-grained table/column/row policy lives in acl_rule + the policy compiler).
 *
 * Workers difference vs the original: `captureAgentEvent` called posthog-node
 * (`getPostHogServer()`), a Node-only library that does not bundle/run on workerd.
 * Real analytics is a later stage; here the function keeps its exact signature but
 * is a guarded no-op (mirrors how auth.ts neutered its PostHog funnel hooks), so
 * callers port over verbatim and telemetry never breaks a request.
 */
import { queryOne } from './db';
import type { AgentIdentity, AgentMode } from './types';

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
    `SELECT a.id, a.name, a.mode, a.status, k."referenceId" AS owner_user
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
 * Emit an analytics event keyed on the AGENT principal. PostHog (posthog-node) is
 * Node-only and does not run on workerd, so this is a guarded no-op for now —
 * signature preserved so callers (api/cp/sessions) port verbatim. Real server-side
 * analytics is deferred to a later stage; never import posthog-node here.
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
  // no-op: analytics deferred on workerd (posthog-node does not bundle/run here).
  // Reference the param so the unused-arg shape stays honest if telemetry returns.
  void params;
}
