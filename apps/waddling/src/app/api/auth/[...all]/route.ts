/**
 * Better Auth catch-all handler (W1).
 *
 * Exposes /api/auth/* — sign-up/sign-in, /token, /jwks, organization, api-key,
 * admin, and the Stripe webhook (/api/auth/stripe/webhook).
 */
import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
