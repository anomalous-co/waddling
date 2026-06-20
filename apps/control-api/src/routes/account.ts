/**
 * /api/cp/account — per-user account operations that are NOT org-scoped.
 *
 * POST /avatar          → upload the signed-in user's avatar image to R2 (native
 *                         AVATARS binding, key `u/<userId>`). Returns a public,
 *                         cache-busted URL the client stores on the user profile.
 * GET  /avatar/:userId  → PUBLIC: stream the stored avatar from R2 so <img> tags
 *                         can load it cross-origin. No auth — avatars aren't secret.
 *                         (The per-request DB pool is lazy, so this read never
 *                          opens a Postgres connection.)
 */
import { Hono } from 'hono';
import type { Env } from '../lib/env';
import { buildAuth } from '../lib/auth';
import { ok, err } from '../lib/cp-shared';

const account = new Hono<{ Bindings: Env }>();

const MAX_BYTES = 1_000_000; // 1 MB

account.get('/avatar/:userId', async (c) => {
  const userId = c.req.param('userId');
  const obj = await c.env.AVATARS.get(`u/${userId}`);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', 'image/png');
  headers.set('cache-control', 'public, max-age=300');
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
});

account.post('/avatar', async (c) => {
  const auth = buildAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = session?.user?.id;
  if (!userId) return err(c, 'unauthorized', 401, 'Sign in to upload an avatar');

  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) {
    return err(c, 'no_file', 400, 'Expected a file field named "file"');
  }
  if (!file.type.startsWith('image/')) {
    return err(c, 'bad_type', 400, 'Avatar must be an image');
  }
  if (file.size > MAX_BYTES) {
    return err(c, 'too_large', 413, 'Avatar must be under 1 MB');
  }

  await c.env.AVATARS.put(`u/${userId}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  // Cache-busted public URL — overwriting the object reuses the key, so the
  // `?v=` token forces browsers to refetch the new image.
  const base = (c.env.BETTER_AUTH_URL ?? '').replace(/\/$/, '');
  const ver = crypto.randomUUID().slice(0, 8);
  return ok(c, { url: `${base}/api/cp/account/avatar/${userId}?v=${ver}` });
});

export { account };
