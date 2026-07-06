/**
 * Node.js entry point for control-api on GCP Cloud Run.
 *
 * Reads all configuration from process.env, initializes module-level singletons
 * (pool, auth, crypto, gateway transport), then starts @hono/node-server.
 *
 * The AVATARS R2 binding is stubbed as a no-op on Node (avatar upload/serve is a
 * CF-only route) — the rest of the API works normally.
 */
import { serve } from '@hono/node-server';
import { app, startupInit, scheduledHandler } from './index.js';
import type { Env } from './lib/env.js';

const noopExCtx: ExecutionContext = {
  waitUntil(_p: Promise<unknown>) {},
  passThroughOnException() {},
  props: {},
};

function makeSecret(val: string | undefined): { get(): Promise<string> } {
  return { get: () => Promise.resolve(val ?? '') };
}

// CF R2 AVATARS binding stub — avatar reads return null; writes are silent no-ops.
const avatarsStub: R2Bucket = {
  get(_key: string) { return Promise.resolve(null); },
  put(_key: string, _value: ArrayBuffer | string) { return Promise.resolve(); },
};

const config: Env = {
  DATABASE_URL: process.env.DATABASE_URL,

  // CF binding stubs — unused on Node, but required by the Env type.
  HYPERDRIVE: undefined,
  AVATARS: avatarsStub,

  // SecretBinding stubs that read from process.env.
  MASTER_KEY: makeSecret(process.env.MASTER_KEY),
  R2_ACCESS_KEY_ID: makeSecret(process.env.R2_ACCESS_KEY_ID),
  R2_SECRET_ACCESS_KEY: makeSecret(process.env.R2_SECRET_ACCESS_KEY),

  EMAIL: undefined,

  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? '',
  BETTER_AUTH_URL:
    process.env.BETTER_AUTH_URL ??
    `http://localhost:${process.env.PORT ?? '8799'}`,
  JWT_ISSUER: process.env.JWT_ISSUER ?? '',
  JWT_AUDIENCE_PREFIX: process.env.JWT_AUDIENCE_PREFIX ?? '',
  MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL ?? '',
  APP_URL: process.env.APP_URL,

  NEON_API_KEY: process.env.NEON_API_KEY,
  R2_FAUCET_TOKEN: process.env.R2_FAUCET_TOKEN,
  WADDLING_SECRET_KEY: process.env.WADDLING_SECRET_KEY,

  POSTHOG_KEY: process.env.POSTHOG_KEY,
  POSTHOG_HOST: process.env.POSTHOG_HOST,

  WEB_ORIGIN: process.env.WEB_ORIGIN,
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
  WADDLING_AGENT_SESSION_POLICY: process.env.WADDLING_AGENT_SESSION_POLICY,
  WADDLING_ENV: process.env.WADDLING_ENV,

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  STRIPE_PRICE_STARTER: process.env.STRIPE_PRICE_STARTER ?? '',
  STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO ?? '',
  STRIPE_PRICE_SCALE: process.env.STRIPE_PRICE_SCALE ?? '',
  STRIPE_PRICE_CREDIT_10: process.env.STRIPE_PRICE_CREDIT_10 ?? '',
  STRIPE_PRICE_CREDIT_25: process.env.STRIPE_PRICE_CREDIT_25 ?? '',
  STRIPE_PRICE_CREDIT_100: process.env.STRIPE_PRICE_CREDIT_100 ?? '',

  NEON_REGION_ID: process.env.NEON_REGION_ID,
  NEON_PG_VERSION: process.env.NEON_PG_VERSION,
  R2_PARENT_ACCESS_KEY_ID: process.env.R2_PARENT_ACCESS_KEY_ID,
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,

  R2_ENDPOINT: process.env.R2_ENDPOINT ?? '',
  R2_BUCKET: process.env.R2_BUCKET ?? '',
  R2_REGION: process.env.R2_REGION ?? 'auto',

  GATEWAY_BASE_URL: process.env.GATEWAY_BASE_URL,
  GATEWAY_INTERNAL_URL: process.env.GATEWAY_INTERNAL_URL,
  // Read-only DSN the gateway ATTACHes as the `__birdshot` grant store (grants are pulled +
  // freshness-checked from it). On Cloudflare this was a workerd binding; the Node port must map
  // it from process.env or EVERY snapshot ships grantStoreDsn=undefined and birdshot enforces
  // nothing (the store is never attached → default-deny for every agent, board and lake alike).
  BIRDSHOT_STORE_DSN: process.env.BIRDSHOT_STORE_DSN,
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,

  PG_HOST: process.env.PG_HOST,
  PG_PORT: process.env.PG_PORT,

  PROVISIONER_URL: process.env.PROVISIONER_URL,
  ROUTER_HOST_SUFFIX: process.env.ROUTER_HOST_SUFFIX,
  CLOUD_RUN_URL_SUFFIX: process.env.CLOUD_RUN_URL_SUFFIX,
  WORKSPACE_FS_JAIL: process.env.WORKSPACE_FS_JAIL,

  CF_EMAIL_BRIDGE_URL: process.env.CF_EMAIL_BRIDGE_URL,
  CF_EMAIL_BRIDGE_TOKEN: process.env.CF_EMAIL_BRIDGE_TOKEN,
};

startupInit(config);

const port = parseInt(process.env.PORT ?? '8799', 10);
serve({ fetch: (req) => app.fetch(req, config, noopExCtx), port });
console.log(`control-api (Node) listening on port ${port}`);

if (process.env.ENABLE_CRON === '1') {
  const interval = parseInt(process.env.CRON_INTERVAL_MS ?? '60000', 10);
  setInterval(() => {
    scheduledHandler(config).catch((e: unknown) => {
      console.log(`[cron] error: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, interval);
  console.log(`control-api cron enabled (every ${interval}ms)`);
}
