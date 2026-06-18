/**
 * Shared helpers for all /api/cp/* control-plane routes (W1).
 *
 * Lives under api/cp/ (not lib/) because W1's lib ownership is the fixed six
 * files; this is route-layer glue. Handles:
 *   - dual-mode auth (browser session cookie OR `sk_agent_…` API key)
 *   - org scoping + caller resolution
 *   - zod-validated bodies
 *   - structured error responses {error, detail}
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAccessToken } from 'better-auth/oauth2';
import { auth } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { getBetterAuthUrl, getMcpResourceUrl } from '@/lib/env';
import { UpgradeRequiredError } from '@/lib/entitlements';

// ── Structured errors ───────────────────────────────────────────────────────────

export interface CpError {
  error: string;
  detail?: string;
}

export function err(
  error: string,
  status: number,
  detail?: string,
): NextResponse<CpError> {
  return NextResponse.json<CpError>({ error, detail }, { status });
}

export function ok<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json<T>(body, { status });
}

// ── Caller context ──────────────────────────────────────────────────────────────

export type CallerKind = 'user' | 'agent';

export interface Caller {
  kind: CallerKind;
  orgId: string;
  /** user id (browser) or agent id (api key). */
  callerId: string;
  /** Only set for api-key callers. */
  agentId?: string;
  apiKeyId?: string;
  /** True when authenticated via an OAuth access token (delegated MCP agent). The
   *  caller is the consenting human (`callerId` = user id); data-plane only. */
  delegated?: boolean;
  /** OAuth client_id (the MCP product, e.g. Claude) for delegated callers. */
  clientId?: string;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

interface AgentRow {
  id: string;
  org_id: string;
  status: string;
}

/**
 * Resolve the caller from either a Better Auth browser session (cookie) OR an
 * `Authorization: Bearer sk_agent_…` API key. API-key callers are resolved to a
 * waddling.agent (must be active). For session callers, `orgId` is the active
 * organization if present, else the first org membership.
 *
 * @param requireOrg ensure an org id is resolvable (default true).
 * @param allowDelegated permit OAuth access-token (delegated MCP) callers. Default
 *   FALSE — secure by default: management routes reject delegated tokens; only the
 *   data-plane sessions-connect route opts in.
 */
export async function resolveCaller(
  req: NextRequest,
  requireOrg = true,
  allowDelegated = false,
): Promise<Caller> {
  const authz = req.headers.get('authorization') ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ')
    ? authz.slice(7).trim()
    : '';

  // ── API key path (MCP servers / agents) ──
  if (bearer.startsWith('sk_')) {
    const result = await auth.api.verifyApiKey({ body: { key: bearer } });
    if (!result.valid || !result.key) {
      throw new AuthError('invalid_api_key', 401, 'API key is invalid or expired');
    }
    // Org is derived solely from the waddling.agent row bound to this key — robust
    // regardless of whether the api-key plugin populates `organizationId`.
    const agent = await queryOne<AgentRow>(
      `SELECT id, org_id, status FROM waddling.agent WHERE api_key_id = $1`,
      [result.key.id],
    );
    if (!agent) {
      throw new AuthError('agent_not_found', 401, 'No agent bound to this API key');
    }
    if (agent.status !== 'active') {
      throw new AuthError('agent_suspended', 403, `Agent is ${agent.status}`);
    }
    return {
      kind: 'agent',
      orgId: agent.org_id,
      callerId: agent.id,
      agentId: agent.id,
      apiKeyId: result.key.id,
    };
  }

  // ── OAuth access-token path (delegated MCP agents — Claude via OAuth) ──
  // A non-sk_ bearer is an OAuth access token minted by our mcp plugin. The caller
  // is the consenting HUMAN; the delegated agent is provisioned in the sessions
  // route (it needs the endpoint to resolve the org). DATA-PLANE ONLY: management
  // routes use the default allowDelegated=false and refuse these tokens.
  if (bearer && !bearer.startsWith('sk_')) {
    if (!allowDelegated) {
      throw new AuthError(
        'delegated_not_allowed',
        403,
        'OAuth/delegated tokens may only open data sessions',
      );
    }
    let payload: { sub?: string; client_id?: string };
    try {
      payload = (await verifyAccessToken(bearer, {
        // SECURITY BOUNDARY (RFC 8707): the token MUST be audience-bound to our MCP
        // resource. mcp-external forwards the bearer blind, so this audience check is
        // the only chokepoint against token redirection — never widen it.
        verifyOptions: { issuer: getBetterAuthUrl(), audience: getMcpResourceUrl() },
        jwksUrl: `${getBetterAuthUrl()}/api/auth/jwks`,
      })) as { sub?: string; client_id?: string };
    } catch {
      throw new AuthError(
        'invalid_token',
        401,
        'OAuth access token is invalid, expired, or not bound to this resource',
      );
    }
    const userId = payload.sub;
    if (!userId) throw new AuthError('invalid_token', 401, 'OAuth token has no subject');
    // Org from first membership; the sessions route re-derives + checks membership
    // against the chosen endpoint's org (authoritative for tenant isolation).
    const member = await queryOne<{ organizationId: string }>(
      `SELECT "organizationId" FROM "member" WHERE "userId" = $1 ORDER BY "createdAt" ASC LIMIT 1`,
      [userId],
    ).catch(() => null);
    const orgId = member?.organizationId ?? '';
    if (requireOrg && !orgId) {
      throw new AuthError('no_organization', 403, 'Delegating user has no organization');
    }
    return { kind: 'user', orgId, callerId: userId, delegated: true, clientId: payload.client_id };
  }

  // ── Browser session path (dashboard) ──
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    throw new AuthError('unauthorized', 401, 'No session or API key');
  }
  const activeOrg =
    (session.session as { activeOrganizationId?: string } | undefined)
      ?.activeOrganizationId ?? undefined;
  let orgId = activeOrg;
  if (!orgId) {
    const member = await queryOne<{ organizationId: string }>(
      `SELECT "organizationId" FROM "member" WHERE "userId" = $1 ORDER BY "createdAt" ASC LIMIT 1`,
      [session.user.id],
    ).catch(() => null);
    orgId = member?.organizationId;
  }
  if (requireOrg && !orgId) {
    throw new AuthError('no_organization', 403, 'Caller has no organization');
  }
  return { kind: 'user', orgId: orgId ?? '', callerId: session.user.id };
}

/** Assert the caller's org matches an explicit orgId on a resource (tenant isolation). */
export function assertOrg(caller: Caller, resourceOrgId: string): void {
  if (caller.orgId !== resourceOrgId) {
    throw new AuthError('forbidden', 403, 'Resource belongs to another org');
  }
}

// ── Body parsing ────────────────────────────────────────────────────────────────

export async function parseBody<S extends z.ZodTypeAny>(
  req: NextRequest,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AuthError('invalid_body', 400, 'Request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AuthError('validation_failed', 400, r.error.message);
  }
  return r.data;
}

// ── Error → response funnel ──────────────────────────────────────────────────────

/** Wrap a handler so thrown AuthError/UpgradeRequiredError become structured responses. */
export async function handle(
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UpgradeRequiredError) {
      return err('upgrade_required', 402, e.message);
    }
    if (e instanceof AuthError) {
      return err(e.code, e.status, e.message);
    }
    const detail = e instanceof Error ? e.message : String(e);
    return err('internal_error', 500, detail);
  }
}
