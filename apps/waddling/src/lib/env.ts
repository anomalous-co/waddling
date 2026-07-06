/**
 * Environment variable accessor.
 *
 * Uses lazy evaluation so module import never throws at build time
 * (next build runs with no real env). Set SKIP_ENV_VALIDATION=1 to
 * bypass all runtime validation (useful in CI / Docker build steps).
 *
 * W1 (auth.ts, db.ts, etc.) calls the typed accessors below.
 */

function required(key: string): string {
  const v = process.env[key];
  if (!v && process.env['SKIP_ENV_VALIDATION'] !== '1') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v ?? '';
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

// ── Database ────────────────────────────────────────────────────────────────
export const getDatabaseUrl = (): string => required('DATABASE_URL');

// ── Better Auth ─────────────────────────────────────────────────────────────
export const getBetterAuthSecret = (): string => required('BETTER_AUTH_SECRET');

// ── Endpoint credential encryption (migration 005) ───────────────────────────
// Data key for envelope-encrypting BYO storage creds + managed catalog DSNs at
// rest (secret-crypto.ts). Dedicated key in prod; falls back to the Better Auth
// secret so local dev works with no extra env. Rotating it orphans existing
// sealed secrets — re-encrypt on rotation.
export const getSecretEncryptionKey = (): string =>
  optional('WADDLING_SECRET_KEY') || getBetterAuthSecret();

// Base directory for managed-local DuckLake catalog files (local-first; the
// production gateway uses a postgres catalog). One dir per endpoint id.
export const getLocalLakeDir = (): string =>
  optional('WADDLING_LOCAL_LAKE_DIR', '/tmp/waddling-lakes');
export const getBetterAuthUrl = (): string =>
  optional('BETTER_AUTH_URL', 'http://localhost:3100');

// ── JWT / Session ───────────────────────────────────────────────────────────
export const getJwtIssuer = (): string =>
  optional('JWT_ISSUER', 'https://app.getwaddling.com');
export const getJwtAudience = (): string =>
  optional('JWT_AUDIENCE_PREFIX', 'gw'); // full aud = `gw:<endpoint_id>`

// ── MCP / OAuth (delegated agent auth) ───────────────────────────────────────
// The public URL of the External MCP server (the OAuth *resource*). Claude binds
// its access token's audience to this (RFC 8707), so the control plane verifies
// delegated tokens against EXACTLY this value — it is the security boundary, not a
// convenience knob. Must match what mcp-external advertises in its
// /.well-known/oauth-protected-resource document.
export const getMcpResourceUrl = (): string =>
  optional('WADDLING_MCP_RESOURCE', 'http://localhost:8810');

// ── Stripe ──────────────────────────────────────────────────────────────────
// During `next build` (SKIP_ENV_VALIDATION=1) the Stripe client is constructed
// eagerly at module load by lib/auth. The Stripe SDK throws on an empty key, so
// fall back to a harmless placeholder when validation is skipped; real requests
// in a configured deployment still require the env var via `required`.
export const getStripeSecretKey = (): string =>
  process.env['SKIP_ENV_VALIDATION'] === '1'
    ? process.env['STRIPE_SECRET_KEY'] ?? 'sk_test_placeholder_build'
    : required('STRIPE_SECRET_KEY');
export const getStripeWebhookSecret = (): string =>
  process.env['SKIP_ENV_VALIDATION'] === '1'
    ? process.env['STRIPE_WEBHOOK_SECRET'] ?? 'whsec_placeholder_build'
    : required('STRIPE_WEBHOOK_SECRET');
export const getStripePricePro = (): string =>
  optional('STRIPE_PRICE_PRO', 'price_pro');
export const getStripePriceMax = (): string =>
  optional('STRIPE_PRICE_MAX', 'price_max');
export const getStripePriceScale = (): string =>
  optional('STRIPE_PRICE_SCALE', 'price_scale');

// ── App ─────────────────────────────────────────────────────────────────────
export const getAppUrl = (): string =>
  optional('NEXT_PUBLIC_APP_URL', 'http://localhost:3100');
export const getNodeEnv = (): string =>
  optional('NODE_ENV', 'development');

// ── PostHog (Stream C — FUNNEL) ──────────────────────────────────────────────
// All four are optional — missing key disables telemetry entirely (no-op safe).
// NEXT_PUBLIC_POSTHOG_KEY is read by posthog-client (browser); POSTHOG_KEY by
// posthog-server (server routes). They are typically the same project key.
export const getPostHogPublicKey = (): string =>
  optional('NEXT_PUBLIC_POSTHOG_KEY');
export const getPostHogPublicHost = (): string =>
  optional('NEXT_PUBLIC_POSTHOG_HOST', 'https://us.i.posthog.com');
export const getPostHogServerKey = (): string =>
  optional('POSTHOG_KEY');
export const getPostHogServerHost = (): string =>
  optional('POSTHOG_HOST', 'https://us.i.posthog.com');
