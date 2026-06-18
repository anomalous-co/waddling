/**
 * Better Auth server instance — workerd factory
 * (ported from apps/waddling/src/lib/auth.ts).
 *
 * The original built the betterAuth instance at MODULE LOAD, reading env eagerly
 * (`new Stripe(getStripeSecretKey())`, `new Pool({connectionString: getDatabaseUrl()})`,
 * `secret: getBetterAuthSecret()`). That is impossible on workerd: env arrives
 * per-request, not at import. So construction moves into `buildAuth(env)`.
 *
 * Construction is non-trivial (it opens a pg.Pool that Better Auth owns), so a
 * fresh instance per request would leak connections. We cache ONE instance per
 * isolate, keyed on the auth secret — if a redeploy changes the secret the cache
 * rebuilds. This mirrors how the original got a single module-level instance.
 *
 * Plugins (unchanged from the original): jwt (RS256/2048, plaintext private JWK),
 * organization, apiKey (`sk_agent_`), admin, mcp, stripe.
 */
import { betterAuth } from 'better-auth';
import { jwt, organization, admin, mcp } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { stripe } from '@better-auth/stripe';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Env } from './env';

/**
 * Shape the @better-auth/stripe plugin wants: `{ name, priceId }`. The free plan
 * has no Stripe price and is omitted. Inlined from the original lib/plans.ts —
 * full plan/entitlement table is not needed for auth construction.
 */
function stripePlans(env: Env): { name: string; priceId: string }[] {
  return [
    { name: 'pro', priceId: env.STRIPE_PRICE_PRO },
    { name: 'enterprise', priceId: env.STRIPE_PRICE_ENTERPRISE },
  ].filter((p) => p.priceId);
}

function construct(env: Env, pool: Pool) {
  // Stripe MUST use the fetch HTTP client on workerd — the default Node http
  // client relies on `node:http`, which is not available in the Workers runtime.
  // A placeholder key constructs fine; Stripe only validates on a real request.
  const stripeClientInstance = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  // Real Stripe config vs the Stage-B placeholders (all contain "placeholder"). Gates
  // the plugin's external-call side-effects so they never hang auth/org flows when
  // billing isn't set up yet. Flips to true automatically when real keys are deployed.
  const stripeConfigured = !!env.STRIPE_SECRET_KEY && !/placeholder/i.test(env.STRIPE_SECRET_KEY);

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // Better Auth owns this Pool (separate from db.ts's pool against the same
    // Hyperdrive binding). Built fresh PER REQUEST and closed after (see buildAuth) —
    // a Pool cached across requests makes Better Auth's Kysely connection wrapper hang
    // on workerd (the runtime cancels a request whose code awaits I/O on a connection
    // owned by a prior request → opaque 1101). Per-request is Better Auth's own
    // documented Cloudflare pattern. Cap at 5; Hyperdrive pools server-side.
    database: pool,
    emailAndPassword: { enabled: true },

    // PostHog funnel hooks. The original called posthog-node (`getPostHogServer()`),
    // which is a Node-only library that does not bundle/run on workerd. Real
    // analytics is a later stage; here the hooks are guarded no-ops so signup/
    // org-create still succeed and the constructed shape matches prod. A thrown
    // hook would fail the operation, hence the try/catch around the (empty) body.
    databaseHooks: {
      user: {
        create: {
          after: async (_user: { id: string; email?: string }) => {
            try {
              // no-op: analytics deferred; never import posthog-node on workerd.
            } catch {
              // swallow — telemetry must never break sign-up.
            }
          },
        },
      },
    },

    plugins: [
      jwt({
        jwks: {
          keyPairConfig: { alg: 'RS256', modulusLength: 2048 },
          // Plaintext private JWK → jose can import it to mint session JWTs.
          disablePrivateKeyEncryption: true,
        },
        jwt: {
          // Identity-only token; roles resolved live from the snapshot.
          definePayload: ({ user }: { user: { id: string } }) => ({ id: user.id }),
          expirationTime: '15m',
        },
      }),
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        organizationHooks: {
          afterCreateOrganization: async (_args: {
            organization: { id: string; name?: string };
            user: { id: string };
          }) => {
            try {
              // no-op: analytics deferred (see user.create hook above).
            } catch {
              // swallow — telemetry must never break org creation.
            }
          },
        },
      }),
      apiKey({
        defaultPrefix: 'sk_agent_',
        enableMetadata: true,
        rateLimit: {
          enabled: true,
          maxRequests: 10000,
          timeWindow: 1000 * 60 * 60,
        },
      }),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      // MCP / OAuth provider (delegated mode). Turns this Better Auth instance
      // into the OAuth 2.1 authorization server Claude Desktop/Code drive:
      // dynamic client registration, PKCE authorize/token, discovery metadata,
      // all under /api/auth/*. Unauthenticated authorize requests go to the
      // dashboard sign-in page. Adds the oauthApplication / oauthAccessToken /
      // oauthConsent tables (created by getMigrations).
      mcp({ loginPage: '/sign-in' }),
      stripe({
        stripeClient: stripeClientInstance,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        // Stripe's customer/subscription side-effects make external Stripe API calls
        // during auth + org-create flows. With PLACEHOLDER keys those calls don't
        // return cleanly and hang the request (the org-create timeout we hit). Better
        // Auth treats these as OPT-IN, so gate them on real Stripe config: when keys
        // are placeholders, construct the plugin (so the billing surface still exists)
        // but disable the side-effecting hooks. Flips on automatically once real keys
        // are set. Both casings are set because the option was renamed across versions
        // (createCustomerOnSignUp in current @better-auth/stripe) — the inactive one is
        // ignored, and either way it is false while unconfigured.
        createCustomerOnSignup: stripeConfigured,
        createCustomerOnSignUp: stripeConfigured,
        subscription: {
          enabled: stripeConfigured,
          // Subscriptions bound to organization — referenceId = org id.
          plans: stripeConfigured ? stripePlans(env) : [],
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof construct>;

/**
 * Per-REQUEST Better Auth instance, scoped via AsyncLocalStorage so every
 * `buildAuth(c.env)` call site stays unchanged while each request gets its own
 * instance + pg.Pool. This is mandatory on workerd: a Better Auth instance cached
 * across requests reuses a Kysely connection bound to an earlier request's I/O
 * context, and the runtime then cancels the new request as "hung" (the opaque
 * 1101 that broke org-create / agent-create). Matches Better Auth's official
 * Cloudflare example (createAuth(c.env) per request). The pool is created lazily
 * (only when a request actually touches auth) and closed after the response by
 * runInAuthScope, so non-auth requests pay nothing and nothing leaks.
 */
interface AuthSlot {
  auth?: Auth;
  pool?: Pool;
}
const authScope = new AsyncLocalStorage<AuthSlot>();

export function buildAuth(env: Env): Auth {
  const slot = authScope.getStore();
  if (slot) {
    if (!slot.auth) {
      const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
      slot.auth = construct(env, pool);
      slot.pool = pool;
    }
    return slot.auth;
  }
  // Outside a request scope (rare — e.g. an out-of-band migration). Construct a
  // throwaway; its pool isn't tracked for cleanup, so only use off the request path.
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  return construct(env, pool);
}

/**
 * Run `next` inside a fresh per-request auth scope and close any Better Auth pool it
 * opened, after the response (via waitUntil). Wrap the whole request with this so every
 * buildAuth() call within it shares ONE instance + pool, torn down when the request ends.
 */
export async function runInAuthScope(
  executionCtx: { waitUntil(p: Promise<unknown>): void } | undefined,
  next: () => Promise<void>,
): Promise<void> {
  const slot: AuthSlot = {};
  await authScope.run(slot, next);
  if (slot.pool) {
    const pool = slot.pool;
    const closing = pool.end().catch(() => {});
    if (executionCtx) executionCtx.waitUntil(closing);
    else await closing;
  }
}

/**
 * Bootstrap Better Auth's own schema (auth.* tables + plugin tables). Idempotent.
 * Not called by request handlers — exposed so a probe/admin route can bootstrap a
 * fresh database. DDL flows through Hyperdrive (it proxies the wire protocol).
 */
export async function runMigrations(env: Env): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations: run } = await getMigrations(buildAuth(env).options);
  await run();
}
