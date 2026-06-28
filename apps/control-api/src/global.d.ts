// Minimal shims for Cloudflare Worker globals that apps/control-api types reference.
// On CF these come from @cloudflare/workers-types; on Node this file provides the
// equivalent structural declarations so the code type-checks unchanged.

// Matches Hono's ExecutionContext (hono/dist/types/context.d.ts) exactly — `props`
// and `exports` are required by Hono internals and must be present for compatibility.
declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  // Wrangler 4.x compat fields (required by Hono's type)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exports?: any;
}

declare interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

declare interface Fetcher {
  fetch(url: string | Request, init?: RequestInit): Promise<Response>;
}

// Expanded R2Object to cover the fields account.ts reads from a CF R2 get() result.
declare interface R2Object {
  readonly body: ReadableStream;
  readonly httpEtag: string;
  readonly httpMetadata?: { contentType?: string; cacheControl?: string };
  writeHttpMetadata(headers: Headers): void;
  arrayBuffer(): Promise<ArrayBuffer>;
}

declare interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string | Blob,
    opts?: {
      httpMetadata?: { contentType?: string; cacheControl?: string; [k: string]: string | undefined };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void>;
}

declare interface Hyperdrive {
  readonly connectionString: string;
}

// Web Crypto API — not available as a global in @types/node (it's under node:crypto/webcrypto).
// Declare the interface so session-jwt.ts / quackboard.ts can use `as CryptoKey` casts.
declare interface KeyAlgorithm {
  name: string;
}
type KeyType = 'private' | 'public' | 'secret';
type KeyUsage = 'decrypt' | 'deriveBits' | 'deriveKey' | 'encrypt' | 'sign' | 'unwrapKey' | 'verify' | 'wrapKey';
declare interface CryptoKey {
  readonly algorithm: KeyAlgorithm;
  readonly extractable: boolean;
  readonly type: KeyType;
  readonly usages: readonly KeyUsage[];
}
