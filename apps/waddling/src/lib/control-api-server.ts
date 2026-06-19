/**
 * Server-side (RSC) reads against the control-plane API.
 *
 * The `/api/auth/*` + `/api/cp/*` surfaces no longer live in this app — they were
 * lifted into the control-api Worker. A handful of server components still need
 * the *session* at render time (dashboard layout gate, /link claim page). Rather
 * than reopen a `pg.Pool` + Better Auth instance inside THIS worker (the old
 * `@/lib/auth` shape eager-loads `new Pool()`/`new Stripe()` at import, which is
 * impossible on workerd), we forward the incoming request's `Cookie` header to
 * control-api and let the authoritative auth plane resolve it.
 *
 * Transport preference:
 *   1. A `CONTROL_API` **service binding** (worker-to-worker, no public hop) —
 *      domain-independent: we forward the raw Cookie explicitly, so this works
 *      regardless of how the browser-facing cookie domain is configured.
 *   2. Fallback to the public `NEXT_PUBLIC_CONTROL_API_URL` origin (single-origin
 *      local dev, or before the service binding is wired).
 *
 * This file is server-only (it reads `next/headers` + the Cloudflare context).
 * Never import it from a client component.
 */
import { headers } from 'next/headers';
import { CONTROL_API_BASE } from './control-api';

/** Minimal shape the render plane reads off Better Auth's get-session. */
export interface ServerSession {
  user: { id: string; name?: string | null; email: string; image?: string | null };
  session: { activeOrganizationId?: string } & Record<string, unknown>;
}

export interface OrgOption {
  id: string;
  name: string;
}

/**
 * Fetch a path on the control-api, forwarding the inbound Cookie. Uses the
 * service binding when present; otherwise the public origin. Returns the raw
 * Response so callers can branch on status.
 */
async function cpFetch(path: string, cookie: string): Promise<Response> {
  const init: RequestInit = {
    headers: { cookie, accept: 'application/json' },
    // SSR call — no browser cookie jar involved; the Cookie header is explicit.
    redirect: 'manual',
  };

  // Prefer a worker-to-worker service binding when running on Cloudflare.
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const env = (await getCloudflareContext({ async: true })).env as {
      CONTROL_API?: { fetch: (req: Request) => Promise<Response> };
    };
    if (env?.CONTROL_API) {
      // Host is arbitrary for a service binding; the bound worker ignores it.
      return env.CONTROL_API.fetch(new Request(`https://control-api${path}`, init));
    }
  } catch {
    // getCloudflareContext throws off-platform (e.g. `next dev` without the
    // OpenNext shim) — fall through to the public origin.
  }

  return fetch(`${CONTROL_API_BASE}${path}`, init);
}

/** The inbound request's Cookie header (empty string if none). */
async function inboundCookie(): Promise<string> {
  const h = await headers();
  return h.get('cookie') ?? '';
}

/**
 * Resolve the current session via control-api's Better Auth get-session,
 * forwarding the inbound cookie. Returns null when unauthenticated.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookie = await inboundCookie();
  if (!cookie) return null;
  try {
    const res = await cpFetch('/api/auth/get-session', cookie);
    if (!res.ok) return null;
    const body = (await res.json()) as ServerSession | null;
    return body && body.user ? body : null;
  } catch {
    return null;
  }
}

/**
 * List the signed-in user's organizations via the Better Auth organization
 * plugin endpoint (forwarding the inbound cookie). Empty array on any failure —
 * the /link page treats "no orgs" as "create one first".
 */
export async function listOrgs(): Promise<OrgOption[]> {
  const cookie = await inboundCookie();
  if (!cookie) return [];
  try {
    const res = await cpFetch('/api/auth/organization/list', cookie);
    if (!res.ok) return [];
    const body = (await res.json()) as Array<{ id: string; name: string }> | null;
    if (!Array.isArray(body)) return [];
    return body
      .map((o) => ({ id: o.id, name: o.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
