/**
 * Public origins for the two-host split (browser-safe).
 *
 * The render plane is a single Next app served on TWO custom domains:
 *   • SITE  (getwaddling.com)     — marketing: landing, docs, blog, customers,
 *                                   pricing, enterprise, memory.
 *   • APP   (app.getwaddling.com) — the product: sign-in/up, dashboard, /link.
 *
 * middleware.ts redirects any request that lands on the wrong host. But a Next
 * `<Link>` across the host boundary issues an RSC prefetch to the CURRENT origin,
 * which the middleware would have to redirect cross-origin (flaky). So every
 * cross-boundary link uses these helpers to emit an ABSOLUTE href → a hard
 * navigation, no RSC prefetch. Same-host links stay plain `<Link>`.
 *
 * Baked at build by cf:build (NEXT_PUBLIC_*, inlined). Empty ⇒ relative (single-
 * origin local dev, where both surfaces share one origin and no split applies).
 */
export const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL ?? '';
export const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? '';

/** Absolute URL on the APP host (app.getwaddling.com). Relative when unset. */
export const appUrl = (path: string): string => `${APP_ORIGIN}${path}`;

/** Absolute URL on the SITE host (getwaddling.com). Relative when unset. */
export const siteUrl = (path: string): string => `${SITE_ORIGIN}${path}`;
