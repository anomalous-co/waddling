import { createMDX } from 'fumadocs-mdx/next';

// PostHog reverse-proxy host (Stream C — FUNNEL).
// Default to us.i.posthog.com so the destination is never 'undefined/ingest/…'
// even when NEXT_PUBLIC_POSTHOG_HOST is unset. The /ingest routes are a
// passthrough — they only receive traffic when the client key is configured.
const POSTHOG_HOST =
  process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [
        // OAuth authorization-server discovery at the root path. The mcp plugin
        // serves it under /api/auth/.well-known/…; MCP clients (Claude) probe the
        // ROOT well-known, so map it through. (RFC 8414 / MCP authorization spec.)
        {
          source: '/.well-known/oauth-authorization-server',
          destination: '/api/auth/.well-known/oauth-authorization-server',
        },
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
