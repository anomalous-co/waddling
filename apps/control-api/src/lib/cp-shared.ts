/**
 * Shared helpers for all /api/cp/* control-plane routes — Hono-native port of
 * apps/waddling/src/app/api/cp/_shared.ts.
 *
 * The original was NextRequest/NextResponse + a module-singleton `auth`/`queryOne`.
 * On workerd there is no module-load env, so:
 *   - `auth` is built per-isolate via `buildAuth(c.env)` (cached; see lib/auth.ts).
 *   - env reads go through `c.env.*`, NOT the old getBetterAuthUrl()/getMcpResourceUrl()
 *     accessors (those read process.env at call time, which does not exist here).
 *   - request/response use the Hono `Context`; bodies via `c.req.json()`, headers via
 *     `c.req.raw.headers`, responses via `c.json(...)`.
 *
 * Behavior of all three auth paths is preserved verbatim from the original:
 *   - `sk_…` API key  → verifyApiKey → waddling.agent row (must be active)
 *   - non-`sk_` bearer → OAuth delegated (verifyAccessToken, audience-bound)
 *   - browser session  → getSession → active org else first membership
 */
import { z } from 'zod';
import { verifyAccessToken } from 'better-auth/oauth2';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { buildAuth } from './auth';
import { queryOne } from './db';
import { UpgradeRequiredError } from './entitlements';
import type { Env } from './env';

type Ctx = Context<{ Bindings: Env }>;

// ── Structured errors ───────────────────────────────────────────────────────────

export interface CpError {
  error: string;
  detail?: string;
}

/** Structured error response `{error, detail}` with an explicit status. */
export function err(
  c: Ctx,
  error: string,
  status: ContentfulStatusCode,
  detail?: string,
) {
  return c.json<CpError>({ error, detail }, status);
}

/** Structured success response. */
export function ok<T>(c: Ctx, body: T, status: ContentfulStatusCode = 200) {
  return c.json(body, status);
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
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(code: string, status: ContentfulStatusCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

// UpgradeRequiredError — plan-gate sentinel mapped to 402 by `handle`. The
// canonical class is now ported in lib/entitlements.ts (constructor: required,
// current). handle() only does `instanceof` + reads `.message`, and cp-shared
// never constructs it (routes throw it via requirePlan), so the import is a clean
// reconciliation of B2's former inline copy.

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
  c: Ctx,
  requireOrg = true,
  allowDelegated = false,
): Promise<Caller> {
  const authz = c.req.header('authorization') ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ')
    ? authz.slice(7).trim()
    : '';

  // ── API key path (MCP servers / agents) ──
  if (bearer.startsWith('sk_')) {
    const result = await buildAuth(c.env).api.verifyApiKey({ body: { key: bearer } });
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
        verifyOptions: { issuer: c.env.BETTER_AUTH_URL, audience: c.env.MCP_RESOURCE_URL },
        jwksUrl: `${c.env.BETTER_AUTH_URL}/api/auth/jwks`,
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
  const session = await buildAuth(c.env).api.getSession({ headers: c.req.raw.headers });
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
  c: Ctx,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
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

/**
 * Wrap a handler so thrown AuthError/UpgradeRequiredError become structured
 * responses. Returns a Hono `Response`. Unknown errors map to 500 internal_error
 * with the raw message (matches the original's funnel).
 */
export async function handle(
  c: Ctx,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UpgradeRequiredError) {
      return err(c, 'upgrade_required', 402, e.message);
    }
    if (e instanceof AuthError) {
      return err(c, e.code, e.status, e.message);
    }
    const detail = e instanceof Error ? e.message : String(e);
    return err(c, 'internal_error', 500, detail);
  }
}
