import { createMDX } from 'fumadocs-mdx/next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// Makes Cloudflare bindings (env, Hyperdrive, etc.) available under `next dev`
// via getCloudflareContext(), matching the workerd runtime the OpenNext build
// targets. No-op for the production build/preview path.
initOpenNextCloudflareForDev();

// PostHog reverse-proxy host (Stream C — FUNNEL).
// Default to us.i.posthog.com so the destination is never 'undefined/ingest/…'
// even when NEXT_PUBLIC_POSTHOG_HOST is unset. The /ingest routes are a
// passthrough — they only receive traffic when the client key is configured.
const POSTHOG_HOST =
  process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com';

const CONTROL_API_ORIGIN =
  process.env['NEXT_PUBLIC_CONTROL_API_URL'] ?? '';

// ── Content Security Policy ────────────────────────────────────────────────
//
// Blocks third-party script injection at the browser level, preventing rogue
// CDN-injected scripts (e.g. Cloudflare Insights beacon with stale SRI hashes)
// from crashing the app. The policy is deliberately permissive enough to work
// with Next.js hydration scripts ('unsafe-inline') while locking down external
// origins to the known set.
//
// • script-src  — 'self' + 'unsafe-inline' (required by Next.js inline hydration
//   scripts). NO 'unsafe-eval' in production; dev-only via conditional below.
// • connect-src — same-origin + api.getwaddling.com (cross-origin control plane)
//   + PostHog analytics. This is where the agent-access CORS requests land.
// • form-action  — same-origin + api.getwaddling.com (Better Auth sign-in POSTs
//   go cross-origin to the control API).
// • style-src    — 'self' + 'unsafe-inline' (styled-jsx / CSS-in-JS).
// • font-src     — 'self' only (Geist + Coiny are self-hosted local fonts).
// • img-src      — 'self' + data: + blob: (avatar uploads, inline previews).
// • frame-src    — 'self' only.
// • object-src   — 'none' (no Flash / Java).
//
// ⚠️  IMPORTANT: This CSP does NOT include static.cloudflareinsights.com —
// the rogue Cloudflare beacon with the stale SRI hash will be BLOCKED by the
// browser, preventing the `__name is not defined` crash. Remove this exclusion
// only after fixing the SRI hash in the Cloudflare dashboard.
//
function buildCsp(dev) {
  const eval_ = dev ? " 'unsafe-eval'" : ''; // Next.js Fast Refresh + dev sourcemaps
  const controlApi = CONTROL_API_ORIGIN
    ? ` ${CONTROL_API_ORIGIN.replace(/\/$/, '')}`
    : '';
  const posthog = POSTHOG_HOST ? ` ${POSTHOG_HOST.replace(/\/$/, '')}` : '';
  // Allow leading/trailing whitespace; browsers normalise.
  return [
    `default-src 'self';`,
    `script-src 'self' 'unsafe-inline'${eval_};`,
    `connect-src 'self'${controlApi}${posthog};`,
    `style-src 'self' 'unsafe-inline';`,
    `img-src 'self' data: blob:;`,
    `font-src 'self';`,
    `frame-src 'self';`,
    `form-action 'self'${controlApi};`,
    `base-uri 'self';`,
    `object-src 'none';`,
  ].join(' ');
}

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // ── Security headers for ALL navigated page routes ─────────────────────
  // CSP applies to every HTML page the render plane serves. Assets (/_next/static)
  // are excluded — the CSP is irrelevant for JS/CSS/fonts served with correct MIME
  // types, and including it on every asset adds ~160 bytes of header overhead per
  // request with zero security benefit.
  async headers() {
    const dev = process.env.NODE_ENV === 'development';
    const csp = buildCsp(dev);
    return [
      {
        source: '/((?!_next/static|_next/image|favicon\\.ico).*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        // NOTE: the root /.well-known/oauth-authorization-server rewrite was
        // removed — Better Auth's /api/auth surface (incl. its MCP OAuth
        // discovery) now lives in the control-api Worker, so MCP clients probe
        // the API origin's well-known, not this render plane.
        {
          source: '/ingest/static/:path*',
          destination: `${POSTHOG_HOST}/static/:path*`,
        },
        {
          source: '/ingest/:path*',
          destination: `${POSTHOG_HOST}/ingest/:path*`,
        },
      ],
    };
  },
};

const withMDX = createMDX();
export default withMDX(config);
