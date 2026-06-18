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

/** A freshly-minted Postgres ROLE = the connection material (shown once). PlanetScale
 *  Postgres uses roles (NOT the MySQL/Vitess `passwords` endpoint, which 405s here). */
export interface PsRole {
  /** access_host_url — the Postgres host (port 5432, sslmode verify-full). */
  hostname: string;
  username: string;
  /** Plaintext password — returned ONLY on create; seal it immediately. */
  plainText: string;
  /** The Postgres database to connect to (database_name in the response). */
  database: string;
  /** PlanetScale role id (for later reset/deletion). */
  id: string;
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
    // Bounded — a slow/hung PlanetScale call must surface as an error, never hang the
    // Worker (the runtime cancels a hung request → opaque 1101).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(`${PS_API_BASE}${path}`, {
        method,
        headers: {
          // Colon-joined service token — PlanetScale's documented format (NOT Bearer).
          authorization: `${this.cfg.tokenId}:${this.cfg.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new PlanetScaleError(
        `PlanetScale ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
        0,
        '',
      );
    } finally {
      clearTimeout(t);
    }
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
   * Mint a Postgres ROLE = the connection material. The plaintext password is returned
   * ONLY here; the caller seals it at once. Inherits `postgres` so the gateway has the
   * CREATE/DDL privileges DuckLake needs to build its metadata catalog. Defaults to the
   * 'main' branch. (PlanetScale Postgres uses `/roles`, not the MySQL `/passwords`.)
   */
  async createRole(
    database: string,
    opts?: { branch?: string; name?: string; inheritedRoles?: string[] },
  ): Promise<PsRole> {
    const branch = opts?.branch ?? 'main';
    const raw = await this.call<Record<string, any>>(
      'POST',
      `/organizations/${enc(this.cfg.organization)}/databases/${enc(database)}/branches/${enc(branch)}/roles`,
      { name: opts?.name ?? 'waddling-gateway', inherited_roles: opts?.inheritedRoles ?? ['postgres'] },
    );
    return {
      hostname: String(raw.access_host_url ?? raw.hostname ?? ''),
      username: String(raw.username ?? ''),
      plainText: String(raw.password ?? raw.plain_text ?? ''),
      database: String(raw.database_name ?? 'postgres'),
      id: String(raw.id ?? ''),
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
    // PlanetScale's cert chains to a public CA. The gateway container has no libpq cert
    // file at the default /root/.postgresql/root.crt, so point verification at the system
    // trust store (libpq 16+ / DuckDB postgres extension support `sslrootcert=system`).
    // Without this the ducklake:postgres ATTACH fails: "root certificate file … does not exist".
    `sslrootcert=system`,
  ].join(' ');
}

const enc = (s: string): string => encodeURIComponent(s);
