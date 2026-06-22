'use client';

/**
 * Marketing/signup funnel events (client-side, render plane).
 *
 * These fire from the browser where the anonymous PostHog `distinct_id` lives, so
 * the funnel can connect "anonymous visitor" → "signed-up user". The terminal
 * `signup_completed` event is authoritative server-side (control-api, via PostHog's
 * HTTP API) — the browser only needs to call `identifyUser` after a successful
 * sign-up, which merges the anonymous person into the new user id (anon→identified).
 * Without that merge the funnel cannot answer "did the people who landed sign up".
 *
 * `usePostHog()` returns a safe no-op client when NEXT_PUBLIC_POSTHOG_KEY is unset
 * (PostHogSetup renders no provider), so every call site stays unconditional.
 */
import { usePostHog } from '@posthog/next';

export interface CtaClickProps {
  /** Where the CTA lives, e.g. 'nav', 'landing_footer', 'pricing'. */
  cta_location: string;
  /** The visible CTA label, e.g. 'start free'. */
  cta_text: string;
  /** Plan key for pricing CTAs, e.g. 'free' | 'pro' | 'enterprise'. */
  plan?: string;
}

export function useFunnel() {
  const posthog = usePostHog();
  return {
    /** A signup-intent CTA was clicked (funnel step before reaching /sign-up). */
    signupCtaClicked: (props: CtaClickProps) => posthog?.capture('signup_cta_clicked', props),
    /** The user began filling the sign-up form (first field interaction). */
    signupStarted: () => posthog?.capture('signup_started'),
    /**
     * Stitch the anonymous browser person to the new user. Call once, right after
     * a successful account creation. The authoritative `signup_completed` event is
     * emitted server-side against this same user id.
     */
    identifyUser: (userId: string, props: { email?: string; name?: string }) =>
      posthog?.identify(userId, props),
  };
}
