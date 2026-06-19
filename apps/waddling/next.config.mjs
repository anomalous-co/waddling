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

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
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
