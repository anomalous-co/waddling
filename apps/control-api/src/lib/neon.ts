/**
 * Neon API client — per-org managed Postgres catalog provisioning.
 *
 * Each waddling org gets its OWN Neon PROJECT (an isolated, autoscaling Postgres that
 * scales to zero when idle). The project's database is the DuckLake metadata catalog the
 * gateway ATTACHes via `ducklake:postgres:<dsn>` on :5432 (raw PG wire, reachable from a
 * GatewayDO container with enableInternet=true). This is the thin REST client; the
 * provisioning state machine lives in catalog-provision.ts.
 *
 * createProject returns the `connection_uri` (WITH password) in the same response, so
 * provisioning is a single call. The connection_uri is shown ONCE; seal it immediately.
 *
 * Auth: `Authorization: Bearer <NEON_API_KEY>`. Base `https://console.neon.tech/api/v2`.
 * The API key is account-scoped (projects are created under that account). NEVER expose it
 * or any minted DSN to the browser.
 */

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

/** Neon connection inputs the client reads from env. */
export interface NeonApiConfig {
  /** Neon API key (account-scoped). */
  apiKey: string;
  /** Cloud region id, e.g. 'aws-us-east-1'. Omitted ⇒ Neon picks a default. */
  regionId?: string;
  /** Postgres major version, e.g. 17. Omitted ⇒ Neon's default. */
  pgVersion?: number;
}

/** The bits of a created Neon project we consume. */
export interface NeonCreateResult {
  /** Neon project id (e.g. 'dry-heart-13671059') — the durable handle for poll/delete. */
  projectId: string;
  /** Direct Postgres connection URI WITH password — returned ONLY on create; seal it. */
  connectionUri: string;
}

export class NeonError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'NeonError';
    this.status = status;
    this.body = body;
  }
}

export class NeonClient {
  constructor(private readonly cfg: NeonApiConfig) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    // Bounded — a hung Neon call must surface as an error, never hang the Worker (the
    // runtime cancels a hung request → opaque 1101).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(`${NEON_API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new NeonError(
        `Neon ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
        0,
        '',
      );
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new NeonError(`Neon ${method} ${path} → ${res.status}`, res.status, text.slice(0, 600));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Create an isolated Neon project (= the org's catalog Postgres). Returns the project id
   * AND the connection_uri (with password) in one shot — the endpoint warms within seconds
   * and the URI is connectable once the create operation settles (the gateway boot retries
   * a cold/suspended compute). Seal the URI immediately.
   */
  async createProject(name: string): Promise<NeonCreateResult> {
    const project: Record<string, unknown> = { name };
    if (this.cfg.regionId) project.region_id = this.cfg.regionId;
    if (this.cfg.pgVersion) project.pg_version = this.cfg.pgVersion;
    const raw = await this.call<{
      project: { id: string };
      connection_uris?: { connection_uri: string }[];
    }>('POST', '/projects', { project });
    const connectionUri = raw.connection_uris?.[0]?.connection_uri ?? '';
    if (!connectionUri) {
      throw new NeonError('Neon createProject returned no connection_uri', 0, JSON.stringify(raw).slice(0, 400));
    }
    return { projectId: raw.project.id, connectionUri };
  }

  /** Read a project (existence / readiness). Throws NeonError(404) if it's gone. */
  getProject(projectId: string): Promise<{ project: { id: string } }> {
    return this.call<{ project: { id: string } }>('GET', `/projects/${enc(projectId)}`);
  }

  /** Tear down an org's catalog project (decommission). Idempotent at the caller. */
  deleteProject(projectId: string): Promise<unknown> {
    return this.call('DELETE', `/projects/${enc(projectId)}`);
  }
}

/**
 * Parse a Neon `connection_uri` into a DuckLake-compatible libpq key=value DSN.
 * DuckLake ATTACHes `ducklake:postgres:<dsn>`; key=value (not URI) is the form the gateway
 * config interpolates. We force the DIRECT (non-`-pooler`) host — the gateway speaks the raw
 * PG wire on 5432, not the pgBouncer pooler. Neon's cert chains to a public CA, so
 * verify-full + the system trust store works; without sslrootcert=system the ATTACH fails
 * "root certificate file … does not exist" (the container has no libpq cert file).
 */
export function neonDsnFromUri(uri: string): string {
  const u = new URL(uri);
  const host = u.hostname.replace('-pooler', '');
  const dbname = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'neondb';
  return [
    `host=${host}`,
    `port=${u.port || '5432'}`,
    `dbname=${dbname}`,
    `user=${decodeURIComponent(u.username)}`,
    `password=${decodeURIComponent(u.password)}`,
    `sslmode=verify-full`,
    `sslrootcert=system`,
  ].join(' ');
}

const enc = (s: string): string => encodeURIComponent(s);
