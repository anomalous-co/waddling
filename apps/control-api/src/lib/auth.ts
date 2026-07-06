/**
 * Better Auth server instance — module-level singleton.
 *
 * On Node/Cloud Run: call initAuth(env) at startup before serving; buildAuth()
 * then returns the singleton unconditionally.
 * On CF workerd: the `*` middleware calls initAuth(c.env) on the first request;
 * subsequent requests reuse the same instance (idempotent).
 *
 * The singleton pattern replaces the per-request pool + AsyncLocalStorage approach
 * that was required on CF to avoid the 1101 connection-reuse bug. A module-level
 * Pool persists for the process lifetime; Hyperdrive (CF) and pg Pool (Node) both
 * support this correctly.
 *
 * Plugins (unchanged): jwt (RS256/2048), organization, apiKey (sk_agent_), admin,
 * mcp (OAuth 2.1 / consent), stripe.
 */
import { betterAuth } from 'better-auth';
import { jwt, organization, admin, mcp } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { stripe } from '@better-auth/stripe';
import { Pool } from 'pg';
import Stripe from 'stripe';
import type { Env } from './env';
import { makePostHog } from './posthog';
import { resetTierCreditsForOrg, currentBillingPeriod } from './credits';
import {
  sendEmail,
  verificationEmail,
  resetPasswordEmail,
  invitationEmail,
  paymentFailedEmail,
} from './email';
import { queryOne } from './db';
import { fulfillCreditPackEvent } from './credit-packs';
import { captureCheckoutCompletedEvent } from './funnel-stripe';

function stripePlans(
  env: Env,
): { name: string; priceId: string; freeTrial?: { days: number } }[] {
  return [
    // Starter carries a short card-required trial: value lands in the first
    // session (connect → remember → recall), so the trial converts fast; the
    // plugin marks the subscription `trialing`, which getActivePlanName treats
    // as active and /billing/status counts as paid.
    { name: 'starter', priceId: env.STRIPE_PRICE_STARTER, freeTrial: { days: 3 } },
    { name: 'pro', priceId: env.STRIPE_PRICE_PRO },
    { name: 'scale', priceId: env.STRIPE_PRICE_SCALE },
  ].filter((p) => p.priceId);
}

// Module-level executionCtx is always undefined; posthog waitUntil fire-and-forgets.
function authExecutionCtx(): { waitUntil(p: Promise<unknown>): void } | undefined {
  return undefined;
}

function construct(env: Env, pool: Pool) {
  const stripeClientInstance = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  const stripeConfigured = !!env.STRIPE_SECRET_KEY && !/placeholder/i.test(env.STRIPE_SECRET_KEY);

  const webOrigins = (env.WEB_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieDomain = env.COOKIE_DOMAIN?.trim() || undefined;
  const crossOrigin = webOrigins.length > 0;
  const uiOrigin = webOrigins[0] ?? env.BETTER_AUTH_URL;

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: webOrigins,
    advanced: crossOrigin
      ? {
          crossSubDomainCookies: cookieDomain
            ? { enabled: true, domain: cookieDomain }
            : { enabled: false },
          defaultCookieAttributes: cookieDomain
            ? { sameSite: 'lax', secure: true }
            : { sameSite: 'none', secure: true },
        }
      : undefined,
    database: pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({
        user,
        url,
      }: {
        user: { email: string; name?: string };
        url: string;
      }) => {
        await sendEmail(env, { email: user.email, name: user.name }, resetPasswordEmail(url, user.name));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string; name?: string };
        url: string;
      }) => {
        await sendEmail(env, { email: user.email, name: user.name }, verificationEmail(url, user.name));
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; email?: string; name?: string }) => {
            try {
              makePostHog(env, authExecutionCtx()).capture({
                distinctId: user.id,
                event: 'signup_completed',
                properties: { $set: { email: user.email, name: user.name } },
              });
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
          disablePrivateKeyEncryption: true,
        },
        jwt: {
          definePayload: ({ user }: { user: { id: string } }) => ({ id: user.id }),
          expirationTime: '15m',
        },
      }),
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: 'owner',
        sendInvitationEmail: async (data: {
          id: string;
          email: string;
          role: string;
          organization: { name?: string };
          inviter?: { user?: { name?: string } };
        }) => {
          await sendEmail(
            env,
            data.email,
            invitationEmail({
              acceptUrl: `${uiOrigin}/accept-invitation/${data.id}`,
              orgName: data.organization?.name ?? 'your team',
              role: data.role,
              inviterName: data.inviter?.user?.name,
            }),
          );
        },
        organizationHooks: {
          afterCreateOrganization: async (args: {
            organization: { id: string; name?: string };
            user: { id: string };
          }) => {
            try {
              makePostHog(env, authExecutionCtx()).capture({
                distinctId: args.user.id,
                event: 'org_created',
                properties: { org_id: args.organization.id, org_name: args.organization.name },
                groups: { organization: args.organization.id },
              });
            } catch {
              // swallow — telemetry must never break org creation.
            }
            try {
              await resetTierCreditsForOrg(
                args.organization.id,
                currentBillingPeriod(),
                args.user.id,
              );
            } catch (e) {
              console.log(
                `[credits] TIER SEED FAILED for org ${args.organization.id} — reconcile on next cron reset: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          },
        },
      }),
      apiKey({
        defaultPrefix: 'sk_agent_',
        enableMetadata: true,
        rateLimit: {
          enabled: false,
          maxRequests: 10000,
          timeWindow: 1000 * 60 * 60,
        },
      }),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      mcp({
        loginPage: `${uiOrigin}/sign-in`,
        oidcConfig: { loginPage: `${uiOrigin}/sign-in`, consentPage: `${uiOrigin}/oauth/consent` },
      }),
      stripe({
        stripeClient: stripeClientInstance,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        onEvent: async (event) => {
          await fulfillCreditPackEvent(event);
          await captureCheckoutCompletedEvent(env, event, authExecutionCtx());
          if (event.type === 'invoice.payment_failed') {
            const inv = event.data.object as {
              customer_email?: string | null;
              customer_name?: string | null;
            };
            if (inv.customer_email) {
              await sendEmail(
                env,
                { email: inv.customer_email, name: inv.customer_name ?? undefined },
                paymentFailedEmail({ name: inv.customer_name ?? undefined }),
              );
            }
          }
        },
        createCustomerOnSignup: stripeConfigured,
        createCustomerOnSignUp: stripeConfigured,
        subscription: {
          enabled: stripeConfigured,
          authorizeReference: async ({ user, referenceId }: { user: { id: string }; referenceId: string }) => {
            try {
              const row = await queryOne<{ role: string }>(
                `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
                [user.id, referenceId],
              );
              return !!row && (row.role === 'owner' || row.role === 'admin');
            } catch {
              return false;
            }
          },
          plans: stripeConfigured ? stripePlans(env) : [],
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof construct>;

let _auth: Auth | undefined;
let _authPool: Pool | undefined;

/** Initialize the module-level auth singleton. Idempotent — first call wins. */
export function initAuth(env: Env): void {
  if (_auth !== undefined) return;
  const connStr = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? '';
  _authPool = new Pool({ connectionString: connStr, max: 10 });
  _auth = construct(env, _authPool);
}

/** Return the initialized auth singleton. Throws if initAuth has not run. */
export function buildAuth(_env?: Env): Auth {
  if (!_auth) {
    throw new Error(
      'auth not initialized — call initAuth(env) before buildAuth()',
    );
  }
  return _auth;
}

/** Passthrough for backward compat — no per-request scope needed with singleton pool. */
export async function runInAuthScope(
  _executionCtx: unknown,
  next: () => Promise<void>,
): Promise<void> {
  await next();
}

/** Bootstrap Better Auth's own schema. Idempotent. */
export async function runMigrations(env: Env): Promise<void> {
  initAuth(env);
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations: run } = await getMigrations(buildAuth().options);
  await run();
}
