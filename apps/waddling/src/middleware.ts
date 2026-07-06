import { NextResponse, type NextRequest } from 'next/server';

/**
 * Host-based split of the single render plane across two custom domains:
 *   • getwaddling.com      — marketing (landing, docs, blog, pricing; retired
 *                            paths like /customers stay marketing-owned so they
 *                            404 here instead of bouncing to the app host).
 *   • app.getwaddling.com  — the product (sign-in/up, dashboard, /link).
 *
 * One worker is bound to both domains; this middleware redirects any request that
 * hits the wrong host to the right one. It is the backstop for hard navigations
 * (direct URL, bookmarks); cross-boundary in-app links are absolute (see lib/site)
 * so they hard-navigate and never rely on a cross-origin RSC redirect.
 *
 * 307 (temporary) on purpose: a wrong permanent redirect gets cached hard by
 * browsers and is painful to undo. Switch app→site marketing routes to 308 only
 * once the topology is settled (SEO consolidation).
 */
const SITE_HOST = 'getwaddling.com';
const APP_HOST = 'app.getwaddling.com';

// MARKETING owns a small, stable set of public paths; EVERYTHING ELSE is the app.
// We allowlist marketing (not the app) because the product surface is large and grows
// often (every dashboard section now lives at its own top-level path, e.g. /agents,
// /acl, /datalakes, /settings) — enumerating app paths would silently bounce any new
// section to marketing. Marketing routes are the (marketing) group + /docs + /duck-lab;
// the apex `/` is the marketing landing.
const MARKETING_PREFIXES = [
  '/blog',
  '/customers',
  '/enterprise',
  '/memory',
  '/pricing',
  '/docs',
  '/duck-lab',
];

function isMarketingPath(pathname: string): boolean {
  if (pathname === '/') return true; // apex landing
  return MARKETING_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest): NextResponse {
  // Host header without port; only the two prod hosts are split. Anything else
  // (localhost, *.workers.dev preview) passes through untouched — single origin.
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const { pathname, search } = req.nextUrl;
  const marketing = isMarketingPath(pathname);

  if (host === APP_HOST) {
    // The app host's root is not a real page — send it into the product. /dashboard
    // SSR-gates to /sign-in when unauthenticated. This MUST precede the marketing
    // bounce: `/` is a marketing path, but on the app host we want the dashboard.
    if (pathname === '/') {
      return NextResponse.redirect(`https://${APP_HOST}/dashboard`, 307);
    }
    // A genuine marketing path requested on the app host → send it to marketing.
    if (marketing) {
      return NextResponse.redirect(`https://${SITE_HOST}${pathname}${search}`, 307);
    }
    return NextResponse.next();
  }

  if (host === SITE_HOST && !marketing) {
    // A non-marketing (i.e. app) path on the marketing host → send it to the app.
    return NextResponse.redirect(`https://${APP_HOST}${pathname}${search}`, 307);
  }

  return NextResponse.next();
}

// Run on page routes only. Exclude Next internals, the PostHog proxy, API routes,
// and any path with a file extension (static assets) — those must serve from the
// host that requested them, never redirect.
export const config = {
  matcher: ['/((?!_next/|ingest/|api/|.*\\.[\\w]+$).*)'],
};
