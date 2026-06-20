/**
 * Session JWT minting — the data-plane lakeToken (the quack TOKEN birdshot verifies
 * against the pushed JWKS). Shared by the connect path (routes/sessions.ts) and the
 * workspace reconfigure lifecycle route (routes/workspaces.ts), so the wire contract
 * (claims, kid, audience) lives in exactly one place.
 *
 *   id  = agent:<agentId>   ← birdshot reads THIS as the principal
 *   sub = agent:<agentId>
 *   iss = JWT_ISSUER, aud = gw:<datalakeId>, exp = now+ttl, jti = <uuid>
 *   header.kid = jwks row id (matches /api/auth/jwks → birdshot_add_jwk)
 *
 * The private key is the plaintext private JWK from the `jwks` table (the jwt plugin
 * runs with disablePrivateKeyEncryption:true — see lib/auth). Extracted verbatim from
 * routes/sessions.ts so the two paths cannot drift.
 */
import { importJWK, SignJWT, type JWK } from 'jose';
import { queryOne } from './db';
import { AuthError } from './cp-shared';
import { CAPABILITY } from './agent-identity';
import type { Env } from './env';

export const SESSION_TTL_SECONDS = 15 * 60; // 15m (spec default; max 1h)

interface JwksRow {
  id: string;
  publicKey: string;
  privateKey: string;
}

/** Newest jwks row → { kid, publicJwk, privateJwk }. Throws AuthError('no_signing_key')
 *  if Better Auth's jwt plugin has not yet minted a key (run the jwt plugin first). */
export async function loadSigningKey(): Promise<{
  kid: string;
  publicJwk: { n: string; e: string; kty: string };
  privateJwk: JWK;
}> {
  // Better Auth's jwks schema has no expiresAt column (keys are rotated, not
  // TTL'd), so just take the newest key by createdAt.
  const row = await queryOne<JwksRow>(
    `SELECT id, "publicKey", "privateKey" FROM "jwks"
      ORDER BY "createdAt" DESC LIMIT 1`,
  );
  if (!row) {
    throw new AuthError(
      'no_signing_key',
      500,
      'No JWKS key found — Better Auth jwt plugin must mint one first',
    );
  }
  return {
    kid: row.id,
    publicJwk: JSON.parse(row.publicKey),
    privateJwk: JSON.parse(row.privateKey),
  };
}

/**
 * Mint a fresh RS256 session JWT (same agent principal) to use as the gateway lakeToken.
 * Mirrors the connect mint: `id`/`sub` = agent:<id> is birdshot's principal; the gateway
 * verifies it against the JWKS pushed at connect. `mode` is the AAP agent mode
 * ('autonomous' | 'delegated'); `cap` defaults to the connect capability.
 */
export async function mintLakeToken(
  env: Env,
  agentId: string,
  datalakeId: string,
  mode: string,
): Promise<string> {
  const { kid, privateJwk } = await loadSigningKey();
  const key = (await importJWK(privateJwk, 'RS256')) as CryptoKey;
  const principal = `agent:${agentId}`;
  return new SignJWT({ id: principal, mode, cap: CAPABILITY.connect })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(principal)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(`gw:${datalakeId}`)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}
