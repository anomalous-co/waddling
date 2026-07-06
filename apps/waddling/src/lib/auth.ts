/**
 * Better Auth server instance + React client (W1).
 *
 * Plugins (§2a, §6):
 *  - jwt          → RS256 keypair in the `jwks` table; published at /api/auth/jwks
 *                   for gateway JWT verification. `disablePrivateKeyEncryption: true`
 *                   so policy-compiler/sessions can read the private JWK and sign
 *                   custom-claim session JWTs with `jose` (see lib/policy-compiler +
 *                   api/cp/sessions). Without it the private key is symmetric-encrypted
 *                   and jose can't import it.  [DEVIATION — documented in report]
 *  - organization → orgs/members/invitations (tenants).
 *  - apiKey       → org-bound agent API keys (`sk_agent_…`).
 *  - admin        → internal ops (impersonate/revoke).
 *  - stripe       → plans from lib/plans (subscription bound to organization).
 *
 * Exports:
 *  - `auth`        → server instance (route handlers, server components, REST).
 *  - `authClient`  → better-auth/react client (W2 dashboard imports this).
 *  - `runMigrations` → one-shot Better Auth schema bootstrap (Docker seed / first boot).
 */
import { betterAuth } from 'better-auth';
import { jwt, organization, admin, mcp } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { stripe } from '@better-auth/stripe';
import { Pool } from 'pg';
import Stripe from 'stripe';
import {
  getDatabaseUrl,
  getBetterAuthSecret,
  getBetterAuthUrl,
  getStripeSecretKey,
  getStripeWebhookSecret,
} from './env';
import { stripePlans } from './plans';
import { getPostHogServer } from './posthog-server';

// Stripe Node client — omit a pinned apiVersion to dodge SDK/type drift (v18).
const stripeClientInstance = new Stripe(getStripeSecretKey());

export const auth = betterAuth({
  baseURL: getBetterAuthUrl(),
  secret: getBetterAuthSecret(),
  database: new Pool({ connectionString: getDatabaseUrl() }),
  emailAndPassword: { enabled: true },

  // ── PostHog funnel hooks (Stream C) ────────────────────────────────────────
  // signup_completed: fires after every new user row is committed by Better Auth.
  // The hook receives only the user object — no request context, so we cannot
  // read ?device= here. Web-signup device alias TODO: the /link claim flow
  // (Stream B) owns device_link_claimed + alias(device → userId). For plain
  // signup arriving via ?device=, the alias must be done client-side via
  // posthog-js .alias() or deferred to a dedicated /api/cp/device-alias route.
  databaseHooks: {
    user: {
      create: {
        after: async (user: { id: string; email?: string }) => {
          const ph = getPostHogServer();
          ph.identify({
            distinctId: user.id,
            properties: {
              $set: { email: user.email },
              $set_once: { signup_date: new Date().toISOString() },
            },
          });
          ph.capture({ distinctId: user.id, event: 'signup_completed' });
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
        // Identity-only browser/agent token; roles resolved live from the snapshot.
        definePayload: ({ user }: { user: { id: string } }) => ({ id: user.id }),
        expirationTime: '15m',
      },
    }),
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: 'owner',
      organizationHooks: {
        afterCreateOrganization: async ({
          organization: org,
          user,
        }: {
          organization: { id: string; name?: string };
          user: { id: string };
        }) => {
          const ph = getPostHogServer();
          ph.groupIdentify({
            groupType: 'organization',
            groupKey: org.id,
            properties: { name: org.name },
          });
          ph.capture({
            distinctId: user.id,
            event: 'org_created',
            groups: { organization: org.id },
          });
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
    // MCP / OAuth provider (§ agent-auth.md — delegated mode). Turns this Better
    // Auth instance into the OAuth 2.1 authorization server Claude Desktop/Code
    // drive: dynamic client registration, PKCE authorize/token, and discovery
    // metadata, all under /api/auth/*. Unauthenticated authorize requests are sent
    // to the dashboard sign-in page, then the human consents. Tokens are RS256 and
    // verified by the resource server (api/cp delegated path) via verifyAccessToken.
    // Adds the oauthApplication / oauthAccessToken / oauthConsent tables (created by
    // getMigrations — re-run Better Auth migrations after adding this plugin).
    mcp({ loginPage: '/sign-in' }),
    stripe({
      stripeClient: stripeClientInstance,
      stripeWebhookSecret: getStripeWebhookSecret(),
      createCustomerOnSignup: true,
      // Org-scoped billing: adds organization.stripeCustomerId (created by
      // getMigrations) and lets the customer.subscription.* webhooks resolve a
      // Stripe customer back to its org (findReferenceByStripeCustomerId). Required
      // for subscriptions created outside the plugin's own hosted-Checkout upgrade
      // (the embedded Elements flow in control-api) to reconcile into entitlements.
      organization: { enabled: true },
      subscription: {
        enabled: true,
        // Subscriptions bound to organization (§6) — referenceId = org id.
        plans: stripePlans(),
      },
    }),
  ],
});

export type Auth = typeof auth;

/**
 * Bootstrap Better Auth's own schema (auth.* tables). Idempotent. Call from the
 * Docker seed / first boot AFTER the waddling schema migration. App routes never
 * call this.
 */
export async function runMigrations(): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations: run } = await getMigrations(auth.options);
  await run();
}
