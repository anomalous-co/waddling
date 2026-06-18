/**
 * Envelope encryption for endpoint credentials at rest (migration 005).
 *
 * AES-256-GCM. The 32-byte data key is derived (SHA-256) from
 * WADDLING_SECRET_KEY, falling back to BETTER_AUTH_SECRET so local dev needs no
 * extra env. Mirrors how Better Auth symmetric-encrypts its JWKS private key.
 *
 * Used only server-side (endpoint-secrets.ts). Sealed parts are stored as BYTEA
 * in waddling.endpoint_secret; node-pg round-trips Buffer ↔ bytea directly.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { getSecretEncryptionKey } from './env';

const ALGO = 'aes-256-gcm';

function dataKey(): Buffer {
  return createHash('sha256').update(getSecretEncryptionKey()).digest();
}

export interface SealedSecret {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** Encrypt a JSON-serialisable payload into AES-256-GCM parts. */
export function sealJson(payload: unknown): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, dataKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

/** Decrypt AES-256-GCM parts back into the original payload. Throws if tampered. */
export function openJson<T>(sealed: SealedSecret): T {
  const decipher = createDecipheriv(ALGO, dataKey(), sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  const plain = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
