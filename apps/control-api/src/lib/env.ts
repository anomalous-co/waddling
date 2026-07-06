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

// Cloudflare Email Service `send_email` binding shape. May not exist in older
// @cloudflare/workers-types, so declare the minimal surface we use locally (mirrors
// the SecretBinding fallback above). See docs/cloudflare-email-service.md.
export interface EmailAddress {
  email: string;
  name?: string;
}
export interface EmailMessage {
  to: string | EmailAddress | (string | EmailAddress)[];
  from: string | EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | EmailAddress;
  headers?: Record<string, string>;
}
export interface SendEmailBinding {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export interface Env {
  // ── Bindings ────────────────────────────────────────────────────────────
  // Optional on Node/Cloud Run — provided by CF Hyperdrive in CF deploy.
  HYPERDRIVE?: Hyperdrive;
  // Direct Postgres connection string (Node/Cloud Run path). Fallback when HYPERDRIVE absent.
  DATABASE_URL?: string;
  MASTER_KEY: SecretBinding;
  R2_ACCESS_KEY_ID: SecretBinding;
  R2_SECRET_ACCESS_KEY: SecretBinding;
  // Native R2 binding for user avatars (upload + public serve). Distinct from the
  // credential-based R2 path used for lake/workspace buckets.
  AVATARS: R2Bucket;
  // Cloudflare Email Service (Email Sending) — transactional mail (verification,
  // password reset, org invites, billing dunning). Optional so a deploy without the
  // binding still types; lib/email.sendEmail no-ops + logs when it is absent.
  EMAIL?: SendEmailBinding;

  // ── Worker secret (set via `wrangler secret put`, NOT in vars) ───────────
  BETTER_AUTH_SECRET: string;
  // Neon API key (account-scoped) for per-org managed Postgres catalog provisioning.
  // Unset ⇒ the managed-postgres catalog path is disabled (getNeonClient → null).
  NEON_API_KEY?: string;
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

  // ── PostHog (server-side funnel capture via HTTP, workerd-safe) ──────────
  // The PostHog project token — the SAME value the render plane ships as
  // NEXT_PUBLIC_POSTHOG_KEY (project tokens are public/write-only). Unset ⇒ the
  // server-side PostHog client (lib/posthog.ts) degrades to a no-op.
  POSTHOG_KEY?: string;
  // Ingestion host. Unset ⇒ https://us.i.posthog.com. Set to the EU host
  // (https://eu.i.posthog.com) or a self-hosted instance as needed. The render
  // plane proxies through /ingest; the Worker calls this host directly.
  POSTHOG_HOST?: string;

  // The render-plane (UI) Worker's browser origin, e.g. https://app.getwaddling.com.
  // The dashboard now runs on its own origin and calls /api/cp/* + /api/auth/* here
  // cross-origin, so this origin must be echoed in CORS Access-Control-Allow-Origin
  // (credentialed CORS forbids `*`) and added to Better Auth's trustedOrigins.
  // Comma-separated to allow more than one (e.g. a preview origin). Unset ⇒ no
  // cross-origin CORS is emitted (same-origin / service-binding only).
  WEB_ORIGIN?: string;

  // Registrable parent domain for the session cookie, e.g. ".getwaddling.com", so
  // the cookie set by this API origin is also sent to the UI origin (same-site,
  // first-party). Set ONLY when the UI + API are subdomains of one registrable
  // domain. Unset ⇒ host-only cookie (correct for single-origin or service-binding
  // SSR, where the cookie is forwarded explicitly and domain scoping is moot).
  COOKIE_DOMAIN?: string;

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
  // 'starter' is the $15/mo entry tier (3-day trial; see auth.ts stripePlans).
  STRIPE_PRICE_STARTER: string;
  STRIPE_PRICE_PRO: string;
  // 'scale' is the self-serve $199/mo tier (formerly labelled enterprise). The
  // sales-led `enterprise` tier has no self-serve price, hence no var here.
  STRIPE_PRICE_SCALE: string;
  // One-time credit-pack Prices (ANO-64 fills these). Unset/placeholder ⇒ pack hidden.
  STRIPE_PRICE_CREDIT_10: string;
  STRIPE_PRICE_CREDIT_25: string;
  STRIPE_PRICE_CREDIT_100: string;

  // ── Neon (per-org managed Postgres catalog) — non-secret vars ────────────
  // The cloud region id (e.g. 'aws-us-east-1') new org catalog projects are created in, and
  // the Postgres major version. Both optional: unset ⇒ Neon picks defaults. The API key is a
  // Worker secret above.
  NEON_REGION_ID?: string;
  NEON_PG_VERSION?: string;

  // ── R2 faucet (per-org lake bucket) — non-secret ─────────────────────────
  // The parent R2 Access Key ID (the account-scoped token's S3 key id) to scope temp
  // creds down from, and the CF account id. Optional: unset ⇒ R2 faucet disabled.
  R2_PARENT_ACCESS_KEY_ID?: string;
  CF_ACCOUNT_ID?: string;

  // ── R2 (Model B: presigned URLs, no native binding) ──────────────────────
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_REGION: string;

  // ── Data plane ─────────────────────────────────────────────────────────────
  // Base URL of the GCP Cloud Run gateway service. gateway-client sends /ctrl/*
  // HTTP requests here (per-endpoint gateways override it with their own URL).
  GATEWAY_BASE_URL?: string;

  // Legacy: kept so an old wrangler var doesn't break typing.
  GATEWAY_INTERNAL_URL?: string;

  // Gateway provisioner service URL (Node/Cloud Run). control-api POSTs /provision here over OIDC
  // to deploy a per-datalake private gateway at create. Unset ⇒ no per-endpoint provisioning
  // (datalakes fall back to the single GATEWAY_BASE_URL bring-up gateway).
  PROVISIONER_URL?: string;

  // Private embeddings service URL (Qwen3-Embedding-4B on Cloud Run L4 GPU, us-central1).
  // Passed to the QB gateway in /ctrl/qb-embed-batch|qb-graph-agent bodies; the gateway mints an
  // OIDC token for it. Unset ⇒ the context-graph embed pipeline is a no-op.
  EMBEDDINGS_URL?: string;

  // Cloud Tasks queue that drives the async embedding drain. EMBED_QUEUE is the full resource path
  // (projects/<p>/locations/<r>/queues/embed-drain); EMBED_DRAIN_SA is the OIDC identity the task
  // presents to the private board gateway (control-api-run@, which holds run.invoker). Either unset
  // ⇒ enqueue is a no-op (local dev) and the backstop sweep is the only trigger.
  EMBED_QUEUE?: string;
  EMBED_DRAIN_SA?: string;

  // Public router host suffix (e.g. 'getwaddling.com'). A workspace ATTACHes the lake via quack at
  // gw-<lakeslug>.<ROUTER_HOST_SUFFIX>:443 — the public router forwards /quack to the private lake
  // gateway (quack carries no OIDC header; the router mints it). Default 'getwaddling.com'.
  ROUTER_HOST_SUFFIX?: string;

  // Cloud Run URL suffix (project-constant '-<hash>-<region>.a.run.app'). Lets control-api address a
  // per-(workspace,agent) workspace service by deterministic name without persisting its URL.
  CLOUD_RUN_URL_SUFFIX?: string;

  // Workspace filesystem-jail rollout gate. When a workspace is provisioned, control-api injects
  // WORKSPACE_FS_JAIL=1 into its env (confining DuckDB file access to the workspace dir) iff this
  // matches: a global toggle ('1'/'true'/'all') jails every workspace; otherwise a comma-separated
  // list of agentIds jails only those agents (staged rollout / canary). Unset ⇒ no jail.
  WORKSPACE_FS_JAIL?: string;

  // SendGrid API key (Node/Cloud Run transactional email path). When set, email.ts
  // sends via SendGrid HTTP before falling back to the CF EMAIL binding.
  SENDGRID_API_KEY?: string;

  // CF email bridge (Node/Cloud Run): URL + shared secret of the tiny Cloudflare Worker that holds
  // the send_email binding. When both are set, email.ts delivers transactional mail through it
  // (keeping Cloudflare Email Sending after the GCP cutover). Unset ⇒ falls through to EMAIL/no-op.
  CF_EMAIL_BRIDGE_URL?: string;
  CF_EMAIL_BRIDGE_TOKEN?: string;

  // Shared Cloud SQL instance coordinates for per-org catalog provisioning (cloudsql.ts).
  // PG_HOST is the instance host the GATEWAY dials over mTLS for the org's DuckLake catalog
  // (the Cloud SQL public IP); it is baked into the DSN minted by provisionOrgDatabase, never
  // used by control-api itself (control-api reaches Cloud SQL via its own unix socket).
  // Unset ⇒ cloudSqlConfigured() is false and managed-catalog provisioning degrades.
  PG_HOST?: string;
  PG_PORT?: string;

  // Read-only, narrowly-scoped Postgres DSN the GATEWAY uses to ATTACH the birdshot grant
  // store (`public.__birdshot_grants` / `__birdshot_meta` in the control DB). Plumbed
  // through the config-only gateway boot payload; the login is provisioned separately
  // (see credops.sh) — control-api only forwards the value. Unset ⇒ no grant-store ATTACH
  // is pushed (the gateway keeps whatever store it has / stays in-memory).
  BIRDSHOT_STORE_DSN?: string;
}
