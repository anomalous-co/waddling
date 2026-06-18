# Better Auth Reference

## Packages & Versions
```
better-auth: ^1.6.18
pg: ^8.21.0
@better-auth/api-key: *
@better-auth/stripe: * (beta)
```

## Server Setup (PostgreSQL + JWT)

Better Auth stores users, sessions, OAuth apps in PostgreSQL via `pg.Pool`. Mint RS256 JWTs for agent API clients.

```ts
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Pool } from "pg";

export const auth = betterAuth({
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: new Pool({
    host: "127.0.0.1",
    port: Number(process.env.AUTH_PG_PORT ?? 5442),
    database: "postgres",
    user: "postgres",
  }),
  emailAndPassword: { enabled: true },
  socialProviders: process.env.GITHUB_CLIENT_ID ? {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  } : undefined,
  plugins: [
    jwt({
      jwks: {
        keyPairConfig: { alg: "RS256", modulusLength: 2048 },
      },
      jwt: {
        definePayload: ({ user }: { user: { id: string } }) => ({ id: user.id }),
        expirationTime: "15m",
      },
    }),
  ],
});
```

**Key points:**
- RS256 (not EdDSA default) so agents verify tokens via published JWKS with OpenSSL
- Identity-only payload; roles resolved live from access control snapshot
- Publish JWKS at `/api/auth/jwks` for agent verification

## Next.js Integration

### API Route Handler
```ts
// app/api/auth/[...all]/route.ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

Exposes `/api/auth/*` routes:
- `/api/auth/sign-up/email`, `/api/auth/sign-in/email`
- `/api/auth/token` — mint JWT for headless agents
- `/api/auth/jwks` — public RS256 keys for verification
- OAuth callbacks if configured

### Session Middleware (Optional)
Use `betterAuth` instance with request headers for user context in API routes.

### Migrations
Run Better Auth schema on first boot:
```ts
import { getMigrations } from "better-auth/db/migration";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
```

## Organization Plugin

Multi-tenant support with role-based access control.

```ts
import { organization } from "better-auth/plugins";

// Define roles with statements (e.g., "admin", "member", "owner")
const org = organization({
  allowUserToCreateOrganization: true, // or function(user) => boolean
  organizationLimit: 10, // max orgs per user
  membershipLimit: 100, // max members per org
  creatorRole: "owner", // role for org creator
  invitationExpiresIn: 48 * 60 * 60 * 1000, // 48h default
  cancelPendingInvitationsOnReInvite: false,
  async sendInvitationEmail(data) {
    // Send email with org invite link
  },
});

export const auth = betterAuth({
  plugins: [org],
});
```

**Org Endpoints:**
- `POST /organization/create` — create org
- `POST /organization/invite-member` — invite user with email, role(s), org ID
- `POST /organization/update-member-role` — update member's role(s)
- `GET /organization/list` — list user's orgs
- `DELETE /organization/remove-member` — remove member

**Schema:** `organization` table + `organizationMember` (userId, orgId, role, status).

## API Key Plugin

Agents authenticate via API keys (created in UI/CLI, used in MCP bearer token).

```ts
import { apiKey } from "@better-auth/api-key";

const auth = betterAuth({
  plugins: [
    apiKey([
      {
        configId: "agent-keys",
        defaultPrefix: "sk_agent_",
        references: "organization", // bind to org
        enableMetadata: true,
        rateLimit: {
          enabled: true,
          maxRequests: 10000,
          timeWindow: 1000 * 60 * 60, // 1h
        },
      },
    ]),
  ],
});
```

**Create API Key:**
```ts
const apiKey = await auth.api.createApiKey({
  body: {
    name: "agent-prod",
    organizationId: "org-123",
    expiresIn: 365 * 24 * 60 * 60, // 1 year
    metadata: { agent: "llm-analyst", env: "prod" },
    rateLimitEnabled: true,
    rateLimitMax: 1000,
    rateLimitTimeWindow: 1000 * 60 * 60,
  },
  headers: sessionHeaders, // authenticated session
});
// Returns { key: "sk_agent_...", id, expiresAt, ... }
```

**Verify API Key:**
```ts
const result = await auth.api.verifyApiKey({
  body: {
    key: "sk_agent_...",
    permissions: { duckdb: ["query", "attach"] }, // optional
  },
});

if (result.valid) {
  const keyData = result.key; // { id, organizationId, metadata, ... }
}
```

**Schema:** `apiKey` table (key, name, expiresAt, organizationId/userId, metadata, rateLimit*).

## Admin Plugin

Internal ops: impersonate users, revoke sessions, manage accounts.

```ts
import { admin } from "better-auth/plugins";

const auth = betterAuth({
  plugins: [
    admin({
      requiredRole: "admin", // who can call admin ops
    }),
  ],
});
```

**Endpoints:**
- `POST /admin/impersonate-user` — create session as another user
- `POST /admin/revoke-session` — revoke user session
- `DELETE /admin/delete-user` — delete account
- Access checks against `admin` role in user table.

## Stripe Plugin (Beta)

Payment and subscription management tied to users.

```ts
import { stripe } from "@better-auth/stripe";

const auth = betterAuth({
  plugins: [
    stripe({
      createCustomerOnSignup: true,
      onCustomerCreate: async ({ stripeCustomer, user }, ctx) => {
        console.log(`Customer ${stripeCustomer.id} created for ${user.id}`);
      },
      getCustomerCreateParams: async (user, ctx) => ({
        metadata: { userId: user.id },
      }),
      subscription: {
        enabled: true,
        plans: [
          { name: "free", priceId: "" },
          { name: "pro", priceId: "price_xxx" },
          { name: "enterprise", priceId: "price_yyy" },
        ],
      },
    }),
  ],
});
```

**Webhooks:**
- Register webhook endpoint: `POST https://your-domain/api/auth/stripe/webhook`
- Listens to: `customer.created`, `invoice.payment_succeeded`, `customer.subscription.*`
- Updates subscription status in Better Auth user metadata

**Schema:** `stripeCustomer` table (userId, customerId, subscriptionId).

## Integration Pattern (Agents → API Keys → DuckDB)

1. Agent obtains API key via `/api-key/create` (org admin API)
2. Agent passes key in MCP Bearer token: `Authorization: Bearer sk_agent_...`
3. waddling API verifies key with `/api-key/verify`, extracts org & user context
4. waddling mints ephemeral DuckDB session token, agent attaches to org endpoint
5. Birdshot ACL gates queries using org, user, role from Better Auth snapshot
