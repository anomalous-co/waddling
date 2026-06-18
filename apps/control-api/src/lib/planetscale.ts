/**
 * PlanetScale API client — per-org managed Postgres catalog provisioning.
 *
 * Each waddling org gets its OWN PlanetScale Postgres database (the DuckLake metadata
 * catalog the gateway ATTACHes via `ducklake:postgres:<dsn>` on :5432 — proven reachable
 * from a GatewayDO container with enableInternet=true). This is the thin REST client; the
 * provisioning state machine lives in catalog-provision.ts.
 *
 * Auth: service token, header `Authorization: <TOKEN_ID>:<TOKEN>` (colon-joined, NOT
 * Bearer). Base `https://api.planetscale.com/v1/`. The token + org come from env
 * (PLANETSCALE_*). The service token needs create_databases + the branch/password
 * scopes. NEVER expose any of this to the browser.
 */

const PS_API_BASE = 'https://api.planetscale.com/v1';

/** PlanetScale connection inputs the client reads from env. */
export interface PlanetScaleApiConfig {
  /** Service token id (the public half). */
  tokenId: string;
  /** Service token secret (the private half). */
  token: string;
  /** PlanetScale organization slug that owns the provisioned databases. */
  organization: string;
  /** Postgres cluster size, e.g. 'PS-10'. Single-node when replicas:0. */
  clusterSize: string;
  /** Region slug, e.g. 'us-east'. Omitted ⇒ PlanetScale picks the org default. */
  region?: string;
}

/** A database as returned by the PlanetScale API (subset we consume). */
export interface PsDatabase {
  id: string;
  name: string;
  /** Lifecycle state. 'ready' once the cluster is up; otherwise still provisioning. */
  state: string;
  kind?: string;
}

/** A freshly-minted branch password = the Postgres connection material (shown once). */
export interface PsPassword {
  /** access_host_url — the Postgres host (port 5432, sslmode verify-full). */
  hostname: string;
  username: string;
  /** Plaintext password — returned ONLY on create; seal it immediately. */
  plainText: string;
  /** PlanetScale password public id (for later rotation/deletion). */
  publicId: string;
}

export class PlanetScaleError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'PlanetScaleError';
    this.status = status;
    this.body = body;
  }
}

export class PlanetScaleClient {
  constructor(private readonly cfg: PlanetScaleApiConfig) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${PS_API_BASE}${path}`, {
      method,
      headers: {
        // Colon-joined service token — PlanetScale's documented format (NOT Bearer).
        authorization: `${this.cfg.tokenId}:${this.cfg.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PlanetScaleError(
        `PlanetScale ${method} ${path} → ${res.status}`,
        res.status,
        text.slice(0, 600),
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Create a Postgres database in the org. Returns immediately; the cluster then
   *  warms up to state 'ready' asynchronously (poll {@link getDatabase}). */
  createDatabase(name: string): Promise<PsDatabase> {
    const body: Record<string, unknown> = {
      name,
      kind: 'postgresql',
      cluster_size: this.cfg.clusterSize,
      replicas: 0, // single-node — the catalog is small metadata, not a serving DB
    };
    if (this.cfg.region) body.region = this.cfg.region;
    return this.call<PsDatabase>(
      'POST',
      `/organizations/${enc(this.cfg.organization)}/databases`,
      body,
    );
  }

  /** Read a database's current state ('ready' ⇒ the cluster is up and connectable). */
  getDatabase(name: string): Promise<PsDatabase> {
    return this.call<PsDatabase>(
      'GET',
      `/organizations/${enc(this.cfg.organization)}/databases/${enc(name)}`,
    );
  }

  /**
   * Mint a branch password = the Postgres connection material. The plaintext is
   * returned ONLY here; the caller seals it at once. Defaults to the 'main' branch
   * and an admin-capable role (the gateway needs DDL to create the DuckLake catalog).
   */
  async createPassword(
    database: string,
    opts?: { branch?: string; role?: string; name?: string },
  ): Promise<PsPassword> {
    const branch = opts?.branch ?? 'main';
    const raw = await this.call<Record<string, any>>(
      'POST',
      `/organizations/${enc(this.cfg.organization)}/databases/${enc(database)}/branches/${enc(branch)}/passwords`,
      { role: opts?.role ?? 'admin', name: opts?.name ?? `waddling-gateway` },
    );
    // The API uses access_host_url for the connectable host; older shapes expose
    // `hostname`. Accept either.
    const hostname = String(raw.access_host_url ?? raw.hostname ?? '');
    return {
      hostname,
      username: String(raw.username ?? ''),
      plainText: String(raw.plain_text ?? raw.plainText ?? ''),
      publicId: String(raw.id ?? raw.public_id ?? ''),
    };
  }
}

/** Assemble a DuckLake-compatible libpq key=value DSN from minted password material.
 *  DuckLake ATTACHes `ducklake:postgres:<dsn>`; key=value (not URI) is the form the
 *  gateway config interpolates. verify-full TLS is PlanetScale's required mode. */
export function buildCatalogDsn(p: { hostname: string; username: string; password: string; database: string }): string {
  return [
    `host=${p.hostname}`,
    `port=5432`,
    `dbname=${p.database}`,
    `user=${p.username}`,
    `password=${p.password}`,
    `sslmode=verify-full`,
  ].join(' ');
}

const enc = (s: string): string => encodeURIComponent(s);
