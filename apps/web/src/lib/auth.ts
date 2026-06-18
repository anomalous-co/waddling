// Better Auth control plane for birdshot.
//
// Better Auth owns user accounts, sign-in, sessions, and JWT issuance. It
// persists to the instance's isolated `authDb` PGlite store over its Postgres
// wire port (AUTH_PG_PORT) — the same store birdshot's host loader reads.
// birdshot only VERIFIES the tokens Better Auth mints (RS256, against the JWKS
// it publishes); it never calls the IdP. See docs/internal/duckdb/birdshot/.
//
// A peer/user obtains a token for quack with `authClient.token()` →
// `/api/auth/token`; that JWT is passed as the quack `TOKEN`.

import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Pool } from "pg";

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";

export const auth = betterAuth({
  baseURL, // = JWT issuer & default audience
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-birdshot-secret-change-me",
  database: new Pool({
    host: "127.0.0.1",
    port: Number(process.env.AUTH_PG_PORT ?? 5442),
    database: "postgres",
    user: "postgres",
  }),
  // Email/password enables headless account creation (and is a real credential
  // path). OAuth/social providers slot in here too once client creds are set.
  emailAndPassword: { enabled: true },
  socialProviders: process.env.GITHUB_CLIENT_ID
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
        },
      }
    : undefined,
  plugins: [
    jwt({
      jwks: {
        // RS256 so birdshot can verify with OpenSSL against the published RSA
        // JWKS (n/e). Better Auth's default is EdDSA, which birdshot doesn't read.
        keyPairConfig: { alg: "RS256", modulusLength: 2048 },
      },
      jwt: {
        // Identity-only payload; birdshot resolves roles LIVE from the pushed
        // snapshot, so revoking a grant needs no token re-issue.
        definePayload: ({ user }: { user: { id: string } }) => ({ id: user.id }),
        expirationTime: "15m",
      },
    }),
  ],
});

export type Auth = typeof auth;
