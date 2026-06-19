/**
 * Control-plane API origin (browser-safe).
 *
 * The `/api/cp/*` and `/api/auth/*` surfaces used to live in THIS Next app. They
 * were lifted out into the standalone control-plane API Worker (apps/control-api,
 * a Hono app on Cloudflare). The render plane now runs as its own OpenNext Worker,
 * so the browser must reach those routes at the API Worker's origin, not its own.
 *
 * `NEXT_PUBLIC_CONTROL_API_URL` is the API origin (e.g. https://api.getwaddling.com).
 * It is a NEXT_PUBLIC_ var so Next inlines it into the client bundle. Empty ⇒
 * same-origin (local single-origin dev, or when a proxy fronts both on one host).
 *
 * The auth cookie must be readable across the UI origin ↔ API origin (cross-
 * subdomain). That is configured server-side in control-api (crossSubDomainCookies
 * + SameSite=None; Secure) — see the cookie-integration note from the UI port.
 */
export const CONTROL_API_BASE = process.env.NEXT_PUBLIC_CONTROL_API_URL ?? '';

/** Prefix a control-plane API path (e.g. `/api/cp/agents`) with the API origin. */
export function cpUrl(path: string): string {
  return `${CONTROL_API_BASE}${path}`;
}
