'use client';

/**
 * Better Auth React client (browser-safe). Split out of `lib/auth.ts` so that
 * client components can import the client without pulling the server instance
 * (and its `pg` / `stripe` Node deps) into the browser bundle.
 */
import { createAuthClient } from 'better-auth/react';
import {
  organizationClient,
  adminClient,
  jwtClient,
} from 'better-auth/client/plugins';
import { apiKeyClient } from '@better-auth/api-key/client';
import { stripeClient } from '@better-auth/stripe/client';
import { CONTROL_API_BASE } from './control-api';

// Better Auth's HTTP surface (/api/auth/*) was lifted into the control-api Worker.
// Point the client at that origin; it appends the default `/api/auth` basePath.
// Empty ⇒ undefined ⇒ Better Auth falls back to the current origin (single-origin
// local dev). The session cookie is shared cross-subdomain (configured server-side
// in control-api: crossSubDomainCookies + SameSite=None; Secure).
export const authClient = createAuthClient({
  baseURL: CONTROL_API_BASE || undefined,
  plugins: [
    organizationClient(),
    adminClient(),
    jwtClient(),
    apiKeyClient(),
    stripeClient({ subscription: true }),
  ],
});
