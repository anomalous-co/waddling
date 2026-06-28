/**
 * Workerd-safe PostHog client.
 *
 * posthog-node is a Node-only library that does not bundle/run on workerd, which
 * is why every server-side call site in this Worker historically degraded to a
 * no-op. But PostHog's capture surface is just HTTP — a Worker can POST events to
 * the ingestion endpoint directly with `fetch`. This module is that client: the
 * authoritative, non-spoofable source for backend funnel events (signup_completed,
 * org_created, device-link, …) that the browser SDK must not be trusted to emit.
 *
 * Delivery is fire-and-forget via `executionCtx.waitUntil`: an un-awaited fetch is
 * cancelled the moment the handler returns its response, so the promise is handed
 * to the runtime to finish after the response. Telemetry never blocks nor breaks
 * the request — a failed POST is swallowed, and an absent project token degrades
 * the whole client to a no-op (so unconfigured envs behave exactly as before).
 */
import type { Env } from './env';

export interface PostHogClient {
  capture(args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    /** Group analytics, e.g. { organization: orgId }. */
    groups?: Record<string, string>;
  }): void;
  /**
   * Set person properties (and merge an anonymous distinct_id into this one when
   * PostHog already saw `distinctId` anonymously). Browsers do the anon→identified
   * merge themselves via posthog-js; this is for backend-only identity.
   */
  identify(args: { distinctId: string; properties?: Record<string, unknown> }): void;
  /** Link a second distinct_id (e.g. a pre-auth device id) to this person. */
  alias(args: { distinctId: string; alias: string }): void;
}

type ExecutionCtx = { waitUntil(p: Promise<unknown>): void } | undefined;

const NOOP: PostHogClient = { capture() {}, identify() {}, alias() {} };

const DEFAULT_HOST = 'https://us.i.posthog.com';

/**
 * Build a PostHog client bound to this request's env + executionCtx. Returns a
 * no-op when POSTHOG_KEY is unset, so call sites stay unconditional.
 */
export function makePostHog(env: Env, executionCtx?: ExecutionCtx): PostHogClient {
  const token = env.POSTHOG_KEY?.trim();
  if (!token) return NOOP;

  const host = (env.POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '');

  const send = (body: Record<string, unknown>): void => {
    const delivery = fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: token, ...body }),
    })
      .then(() => undefined)
      .catch(() => undefined);
    if (executionCtx) executionCtx.waitUntil(delivery);
    else void delivery;
  };

  return {
    capture({ distinctId, event, properties, groups }) {
      send({
        distinct_id: distinctId,
        event,
        properties: { ...properties, ...(groups ? { $groups: groups } : {}) },
        timestamp: new Date().toISOString(),
      });
    },
    identify({ distinctId, properties }) {
      send({
        distinct_id: distinctId,
        event: '$identify',
        $set: properties ?? {},
        timestamp: new Date().toISOString(),
      });
    },
    alias({ distinctId, alias }) {
      send({
        distinct_id: distinctId,
        event: '$create_alias',
        properties: { distinct_id: distinctId, alias },
        timestamp: new Date().toISOString(),
      });
    },
  };
}
