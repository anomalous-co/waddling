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

function construct(env: Env) {
  // Stripe MUST use the fetch HTTP client on workerd — the default Node http
  // client relies on `node:http`, which is not available in the Workers runtime.
  // A placeholder key constructs fine; Stripe only validates on a real request.
  const stripeClientInstance = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // Better Auth owns this Pool (separate from db.ts's pool against the same
    // Hyperdrive binding). Cap at 5 — see db.ts for the two-pool rationale.
    database: new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 }),
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
        createCustomerOnSignup: true,
        subscription: {
          enabled: true,
          // Subscriptions bound to organization — referenceId = org id.
          plans: stripePlans(env),
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof construct>;

// Per-isolate cache. Keyed on the auth secret so a secret rotation rebuilds.
let cached: { key: string; auth: Auth } | undefined;

/**
 * Get the cached Better Auth instance for this isolate, constructing it on first
 * use. Caching is essential: each instance owns a pg.Pool, so a per-request
 * instance would leak connections.
 */
export function buildAuth(env: Env): Auth {
  if (!cached || cached.key !== env.BETTER_AUTH_SECRET) {
    cached = { key: env.BETTER_AUTH_SECRET, auth: construct(env) };
  }
  return cached.auth;
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
