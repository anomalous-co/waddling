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
  // PlanetScale API service token SECRET half (per-org managed Postgres catalog
  // provisioning). The id half + org/cluster/region are non-secret vars below.
  // Unset ⇒ the managed-postgres catalog path is disabled (getPlanetScaleClient → null).
  PLANETSCALE_SERVICE_TOKEN?: string;
  // R2 faucet (per-org lake bucket provisioning + scoped temp creds). The account-scoped
  // R2 API token VALUE (Cloudflare API Bearer); its Access Key ID is the parent below.
  // Unset ⇒ the R2 faucet is disabled (getR2Faucet → null).
  R2_FAUCET_TOKEN?: string;
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

  // ── PlanetScale (per-org managed Postgres catalog) — non-secret vars ──────
  // The service-token id half (public), the org slug that owns provisioned DBs, the
  // Postgres cluster size, and an optional region. The token SECRET half is a Worker
  // secret above. All optional: unset ⇒ managed-postgres catalog disabled.
  PLANETSCALE_SERVICE_TOKEN_ID?: string;
  PLANETSCALE_ORG?: string;
  PLANETSCALE_CLUSTER_SIZE?: string;
  PLANETSCALE_REGION?: string;

  // ── R2 faucet (per-org lake bucket) — non-secret ─────────────────────────
  // The parent R2 Access Key ID (the account-scoped token's S3 key id) to scope temp
  // creds down from, and the CF account id. Optional: unset ⇒ R2 faucet disabled.
  R2_PARENT_ACCESS_KEY_ID?: string;
  CF_ACCOUNT_ID?: string;

  // ── R2 (Model B: presigned URLs, no native binding) ──────────────────────
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_REGION: string;

  // ── Data plane (service binding) ─────────────────────────────────────────
  // The waddling-dataplane Worker (apps/dataplane): one private worker hosting the
  // GatewayDO + WorkspaceSandbox Container DOs. It is service-binding-only (no
  // public route), so the control plane reaches it ONLY through this Fetcher:
  //   • gateway control channel — POST /gw/snapshot, GET /gw/status, POST /gw/revoke
  //     (lib/gateway-client transports through here);
  //   • workspace lifecycle — POST /configure (connect) + POST /query (the revived
  //     /:id/query forwarder). Agent SQL still reaches the lake only via the
  //     workspace sidecar's birdshot-gated quack ATTACH — never a trusted conn.
  DATAPLANE: Fetcher;

  // Legacy: base URL of the EXISTING Rivet/GCP DuckDB gateway's control port. The
  // gateway now lives in the DATAPLANE worker's GatewayDO, so gateway-client no
  // longer reads this. Kept OPTIONAL so an old wrangler var doesn't break typing.
  GATEWAY_INTERNAL_URL?: string;
}
