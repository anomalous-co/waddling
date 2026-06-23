/**
 * PostHog provider setup for Next.js App Router (Stream C — FUNNEL).
 *
 * @posthog/next v0.5.x ships PostHogProvider as an async React Server Component
 * and PostHogPageView as a 'use client' component — they must live in separate
 * files. When `bootstrapFlags` is enabled, the provider reads cookies() for
 * server-side flag evaluation, switching the route to dynamic rendering.
 *
 * PostHogSetup is a SERVER component (no 'use client' directive):
 *   - wraps @posthog/next's PostHogProvider so the SDK is initialised server-side
 *   - renders a plain passthrough when NEXT_PUBLIC_POSTHOG_KEY is absent (no-op safe)
 *   - embeds PhPageView (client component) for automatic SPA pageview capture
 *
 * Usage (layout.tsx — already a server component):
 *   import { PostHogSetup } from '@/lib/posthog-client'
 *   <PostHogSetup>{children}</PostHogSetup>
 *
 * NOTE: Do NOT add 'use client' to this file — PostHogProvider requires server context.
 */

import { PostHogProvider, PostHogPageView } from '@posthog/next';
import type { ReactNode } from 'react';

interface PostHogSetupProps {
  children: ReactNode;
}

const POSTHOG_KEY = process.env['NEXT_PUBLIC_POSTHOG_KEY'] ?? '';

/**
 * Wraps the app with PostHog instrumentation.
 * Falls back to a plain children passthrough when the key is absent.
 */
export function PostHogSetup({ children }: PostHogSetupProps) {
  if (!POSTHOG_KEY) {
    // No key configured — render children unmodified; zero PostHog activity.
    return <>{children}</>;
  }

  return (
    <PostHogProvider
      apiKey={POSTHOG_KEY}
      clientOptions={{
        api_host: '/ingest',
        capture_pageview: 'history_change',
        persistence: 'localStorage+cookie',
        // The render plane serves marketing (getwaddling.com) and the product
        // (app.getwaddling.com) as ONE app on TWO subdomains. The funnel only
        // connects if the anonymous distinct_id survives the getwaddling.com →
        // app.getwaddling.com hop: localStorage does NOT cross subdomains, so the
        // identity rides the cookie, which must be scoped to the registrable parent
        // (.getwaddling.com), not host-only. Explicit so the bridge can't silently
        // break (which would sever every landing → signup funnel into two persons).
        cross_subdomain_cookie: true,
        // Only create Person profiles once a user is identified (post sign-up).
        // Anonymous landing/blog events are still captured and get linked to the
        // person on identify() — the funnel works, without billing anonymous browsers.
        person_profiles: 'identified_only',
      }}
    >
      <PostHogPageView />
      {children}
    </PostHogProvider>
  );
}
