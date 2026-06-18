/**
 * Envelope encryption for endpoint credentials at rest
 * (ported from apps/waddling/src/lib/secret-crypto.ts).
 *
 * AES-256-GCM via `node:crypto`. The 32-byte data key is SHA-256 of a caller-
 * supplied secret string. The original derived the key from an ambient env
 * accessor (`getSecretEncryptionKey()`); on workerd there is no ambient env, so
 * the secret is passed in explicitly — `makeCrypto(secret)` closes over it and
 * returns the `{sealJson, openJson}` pair. The caller passes
 * `env.WADDLING_SECRET_KEY ?? env.BETTER_AUTH_SECRET` to match the original
 * fallback. The sealed `{iv, authTag, ciphertext}` Buffer layout is byte-for-byte
 * identical to the original so secrets sealed by either codebase interoperate.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export interface SealedSecret {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export interface Crypto {
  sealJson(payload: unknown): SealedSecret;
  openJson<T>(sealed: SealedSecret): T;
}

/**
 * Per-isolate crypto singleton + throwing getter (mirrors db.ts's pool pattern).
 *
 * `makeCrypto(secret)` stays the explicit factory (used directly by the Stage-B
 * crypto probe). But `endpoint-secrets.ts` and `workspace-keys.ts` need the
 * seal/open pair WITHOUT taking a secret in their own signatures (the originals
 * imported a module-singleton `sealJson`/`openJson`). On workerd the secret arrives
 * per-request via `c.env`, so a middleware calls `initCrypto(secret)` once before
 * any handler — using `env.WADDLING_SECRET_KEY ?? env.BETTER_AUTH_SECRET` to match
 * the original getSecretEncryptionKey() fallback — and `getCrypto()` then returns
 * the already-built instance. This keeps every credential-seal callsite's signature
 * unchanged from the original while obeying the no-module-load-env rule.
 */
let _crypto: Crypto | undefined;

/** Idempotent per-isolate crypto initializer. First call wins; warm calls no-op. */
export function initCrypto(secret: string): Crypto {
  if (!_crypto) {
    _crypto = makeCrypto(secret);
  }
  return _crypto;
}

/** The initialized crypto pair. Throws if `initCrypto` has not run for this isolate. */
export function getCrypto(): Crypto {
  if (!_crypto) {
    throw new Error(
      'crypto not initialized — initCrypto(env.WADDLING_SECRET_KEY ?? env.BETTER_AUTH_SECRET) must run before seal/open',
    );
  }
  return _crypto;
}

/**
 * Build a seal/open pair bound to `secret`. The data key is `SHA256(secret)`,
 * mirroring how Better Auth symmetric-encrypts its JWKS private key.
 */
export function makeCrypto(secret: string): Crypto {
  const dataKey = createHash('sha256').update(secret).digest();

  return {
    /** Encrypt a JSON-serialisable payload into AES-256-GCM parts. */
    sealJson(payload: unknown): SealedSecret {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGO, dataKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
        cipher.final(),
      ]);
      return { iv, authTag: cipher.getAuthTag(), ciphertext };
    },

    /** Decrypt AES-256-GCM parts back into the original payload. Throws if tampered. */
    openJson<T>(sealed: SealedSecret): T {
      const decipher = createDecipheriv(ALGO, dataKey, sealed.iv);
      decipher.setAuthTag(sealed.authTag);
      const plain = Buffer.concat([
        decipher.update(sealed.ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8')) as T;
    },
  };
}
