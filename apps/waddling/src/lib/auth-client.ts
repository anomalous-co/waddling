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
import { getBetterAuthUrl } from './env';

export const authClient = createAuthClient({
  baseURL: getBetterAuthUrl(),
  plugins: [
    organizationClient(),
    adminClient(),
    jwtClient(),
    apiKeyClient(),
    stripeClient({ subscription: true }),
  ],
});
