/**
 * R2 "faucet" — per-org bucket provisioning + least-privilege scoped credentials.
 *
 * Each org gets its OWN R2 bucket for lake data (tenant-segregated, symmetric with the
 * per-org PlanetScale catalog). The gateway never holds a broad account credential: the
 * faucet mints SHORT-LIVED, bucket+prefix-scoped S3 creds (R2 temporary-access-credentials)
 * for exactly the org's bucket, injected into the gateway at boot. Least privilege + auto-
 * expiry — an exfiltrated key only reaches one org's lake data, and only briefly.
 *
 * Auth (one account-scoped R2 API token, created once in the dashboard → Manage R2 API
 * Tokens, Object Read & Write, All buckets):
 *   • R2_FAUCET_TOKEN          — the token VALUE (Cloudflare API Bearer) for the CF API.
 *   • R2_PARENT_ACCESS_KEY_ID  — that token's Access Key ID (the parent to scope down from).
 * Plus CF_ACCOUNT_ID. The parent SECRET is never needed (Cloudflare holds it). All trusted-
 * tier only; the scoped child creds are what cross into the gateway.
 */
import type { Env } from './env';

const CF_API = 'https://api.cloudflare.com/client/v4';

export type R2Permission =
  | 'object-read-write'
  | 'object-read-only'
  | 'admin-read-write'
  | 'admin-read-only';

export interface ScopedR2Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface R2FaucetConfig {
  accountId: string;
  apiToken: string;
  parentAccessKeyId: string;
}

/** Build the faucet config from env, or null when unconfigured (no R2 faucet token). */
export function getR2Faucet(env: Env): R2FaucetClient | null {
  if (!env.R2_FAUCET_TOKEN || !env.R2_PARENT_ACCESS_KEY_ID) return null;
  return new R2FaucetClient({
    accountId: env.CF_ACCOUNT_ID || '866403f7ed22a791871b45539ac6fbd7',
    apiToken: env.R2_FAUCET_TOKEN,
    parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
  });
}

/** Deterministic per-org bucket name (R2: lowercase, 3-63 chars, [a-z0-9-]). */
export function orgBucketName(orgSlug: string): string {
  const slug = orgSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `waddling-lake-${slug || 'org'}`.slice(0, 63);
}

export class R2FaucetError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'R2FaucetError';
    this.status = status;
  }
}

export class R2FaucetClient {
  constructor(private readonly cfg: R2FaucetConfig) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(`${CF_API}/accounts/${this.cfg.accountId}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.apiToken}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new R2FaucetError(`R2 faucet ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`, 0);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    if (!res.ok) throw new R2FaucetError(`R2 faucet ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`, res.status);
    const json = text ? JSON.parse(text) : {};
    return (json.result ?? json) as T;
  }

  /** Create an R2 bucket. Idempotent: a 409 "already exists" is treated as success. */
  async ensureBucket(name: string): Promise<void> {
    try {
      await this.call('POST', '/r2/buckets', { name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists|already owned|10004|409/i.test(msg)) throw e;
    }
  }

  /** Mint short-lived S3 creds scoped to one bucket (+ optional prefix). */
  async mintScopedCreds(
    bucket: string,
    opts?: { permission?: R2Permission; ttlSeconds?: number; prefixes?: string[] },
  ): Promise<ScopedR2Creds> {
    const body: Record<string, unknown> = {
      bucket,
      parentAccessKeyId: this.cfg.parentAccessKeyId,
      permission: opts?.permission ?? 'object-read-write',
      ttlSeconds: opts?.ttlSeconds ?? 3600,
    };
    if (opts?.prefixes && opts.prefixes.length) body.prefixes = opts.prefixes;
    return this.call<ScopedR2Creds>('POST', '/r2/temp-access-credentials', body);
  }
}
