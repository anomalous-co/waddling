/**
 * Worker environment shape.
 *
 * On workerd, env is NOT ambient (`process.env` does not exist at module load).
 * It arrives per-request as `c.env`. This interface is the single source of truth
 * for the bindings + vars the control plane reads; `auth.ts` and `index.ts` both
 * type against it. Secrets (BETTER_AUTH_SECRET) are Worker secrets set out of band
 * and never appear in wrangler `vars`.
 */

// `SecretsStoreSecret` may not exist in older @cloudflare/workers-types; fall
// back to a minimal local shape. The runtime binding always has an async `.get()`.
export type SecretBinding = { get(): Promise<string> };

export interface Env {
  // ── Bindings ────────────────────────────────────────────────────────────
  HYPERDRIVE: Hyperdrive;
  MASTER_KEY: SecretBinding;
  R2_ACCESS_KEY_ID: SecretBinding;
  R2_SECRET_ACCESS_KEY: SecretBinding;

  // ── Worker secret (set via `wrangler secret put`, NOT in vars) ───────────
  BETTER_AUTH_SECRET: string;
  // Optional dedicated key for endpoint-credential encryption. Falls back to
  // BETTER_AUTH_SECRET (mirrors the original getSecretEncryptionKey()).
  WADDLING_SECRET_KEY?: string;

  // ── Better Auth / JWT / MCP construction vars (non-secret) ───────────────
  BETTER_AUTH_URL: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE_PREFIX: string;
  MCP_RESOURCE_URL: string;
  // Public app URL the device-link verify URL is built from (original read
  // NEXT_PUBLIC_APP_URL). Optional — falls back to BETTER_AUTH_URL, the app's
  // own base URL in this deployment.
  APP_URL?: string;

  // One-key-per-agent session policy (original read process.env at module load;
  // there is no ambient env on workerd, so it moves to a per-request c.env read).
  // 'reject' refuses a second concurrent connect; anything else ⇒ 'supersede'.
  WADDLING_AGENT_SESSION_POLICY?: string;

  // Node env equivalent for the dev-only provision stand-in. The original gated
  // on getNodeEnv()==='production'; workerd has no NODE_ENV, so this var carries
  // it. Original default (unset ⇒ 'development') keeps the route ENABLED, so the
  // dev-provision route is open unless WADDLING_ENV is explicitly 'production'.
  WADDLING_ENV?: string;

  // ── Stripe (placeholder values in B1; real keys are Worker secrets later) ─
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_PRO: string;
  STRIPE_PRICE_ENTERPRISE: string;

  // ── R2 (Model B: presigned URLs, no native binding) ──────────────────────
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_REGION: string;

  // ── Gateway control channel (lib/gateway-client) ─────────────────────────
  // Base URL of the EXISTING Rivet/GCP DuckDB gateway's control port. The control
  // plane tunnels every endpoint's snapshot/revoke/describe/status call here until
  // Stage D repoints to the gateway Durable Object. Non-secret (the per-endpoint
  // server_token authorizes the call).
  GATEWAY_INTERNAL_URL: string;
}
