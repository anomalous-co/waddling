import { NextResponse, type NextRequest } from 'next/server';

/**
 * Host-based split of the single render plane across two custom domains:
 *   • getwaddling.com      — marketing (landing, docs, blog, customers, pricing,
 *                            enterprise, memory).
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

// Path prefixes that belong to the APP host. Everything else is marketing.
const APP_PREFIXES = ['/dashboard', '/sign-in', '/sign-up', '/link'];

function isAppPath(pathname: string): boolean {
  return APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest): NextResponse {
  // Host header without port; only the two prod hosts are split. Anything else
  // (localhost, *.workers.dev preview) passes through untouched — single origin.
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const { pathname, search } = req.nextUrl;
  const appPath = isAppPath(pathname);

  if (host === SITE_HOST && appPath) {
    return NextResponse.redirect(`https://${APP_HOST}${pathname}${search}`, 307);
  }

  if (host === APP_HOST && !appPath) {
    // The app host's root is not a real page — send it into the product. /dashboard
    // SSR-gates to /sign-in when unauthenticated.
    if (pathname === '/') {
      return NextResponse.redirect(`https://${APP_HOST}/dashboard`, 307);
    }
    return NextResponse.redirect(`https://${SITE_HOST}${pathname}${search}`, 307);
  }

  return NextResponse.next();
}

// Run on page routes only. Exclude Next internals, the PostHog proxy, API routes,
// and any path with a file extension (static assets) — those must serve from the
// host that requested them, never redirect.
export const config = {
  matcher: ['/((?!_next/|ingest/|api/|.*\\.[\\w]+$).*)'],
};
