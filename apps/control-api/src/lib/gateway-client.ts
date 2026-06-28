/**
 * Gateway control-channel HTTP client — dual-transport.
 *
 * CF deploy: `initDataplane(fetcher)` wires the DATAPLANE service binding; send()
 * routes through `fetcher.fetch('https://dataplane/gw/...')`.
 *
 * Node/Cloud Run: `initDataplane(url)` sets a base URL; send() issues plain HTTP
 * requests to `<baseUrl>/ctrl/...` (path prefix rewrite /gw/ → /ctrl/). Google
 * Cloud Run identity tokens are added automatically for https:// URLs.
 */
import type { BirdshotSnapshot } from './types';

// ── Request payloads ────────────────────────────────────────────────────────────

export interface SnapshotRequest {
  datalakeId: string;
  auth: { issuer: string; audience: string; mode: 'rs256'; jwks: BirdshotJwk[] };
  snapshot: BirdshotSnapshot;
  lakeCatalog?: string;
  gatewayBoot?: GatewayBoot;
}

export interface GatewayBoot {
  serverToken?: string;
  catalogDsn?: string;
  catalogFile?: string;
  dataPath?: string;
  metadataSchema?: string;
  alias?: string;
  encrypted?: boolean;
  s3?: {
    endpoint?: string; keyId?: string; secret?: string; sessionToken?: string;
    region?: string; useSsl?: boolean; urlStyle?: 'path' | 'vhost';
  };
  quackboard?: boolean;
  r2Key?: string;
}

export interface BirdshotJwk {
  kid: string;
  n: string;
  e: string;
}

export interface RevokeRequest {
  datalakeId: string;
  kind: 'user' | 'jti' | 'session';
  id: string;
  reason: string;
  expiresUs?: number;
}

// ── Responses ─────────────────────────────────────────────────────────────────

export interface GatewayAck {
  ok: boolean;
  snapshotVersion?: string;
}

export interface GatewayTableInfo {
  schema: string;
  table: string;
  columns: { name: string; type: string; nullable?: boolean }[];
}

export interface GatewayCatalogColumn {
  name: string;
  type: string;
  nullable: boolean;
}
export interface GatewayCatalogTable {
  name: string;
  columns: GatewayCatalogColumn[];
}
export interface GatewayCatalogSchema {
  name: string;
  tables: GatewayCatalogTable[];
}
export interface GatewayCatalog {
  schemas: GatewayCatalogSchema[];
}

export interface GatewayStatus {
  state: 'running' | 'asleep' | 'unconfigured';
  replicas: number;
  inFlightTotal: number;
  version: number;
}

export class GatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

// ── Google Cloud Run identity-token helper ─────────────────────────────────────

// Cached on first successful init; null after a failed init (running locally without creds).
let _idTokenClient:
  | { getRequestHeaders(url: string): Promise<Record<string, string>> }
  | null
  | undefined;

async function getCloudRunAuthHeaders(
  audience: string,
  url: string,
): Promise<Record<string, string>> {
  if (_idTokenClient === null) return {};
  if (_idTokenClient === undefined) {
    try {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth();
      _idTokenClient = await auth.getIdTokenClient(audience);
    } catch {
      _idTokenClient = null;
      return {};
    }
  }
  try {
    return await _idTokenClient.getRequestHeaders(url);
  } catch {
    return {};
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface GatewayClientOptions {
  fetcher?: Fetcher;
  baseUrl?: string;
  timeoutMs?: number;
}

export class GatewayClient {
  private readonly fetcher: Fetcher | undefined;
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: GatewayClientOptions) {
    this.fetcher = opts.fetcher;
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs);
    try {
      let res: Response;
      if (this.baseUrl !== undefined) {
        // Node/Cloud Run HTTP path: rewrite /gw/ → /ctrl/
        const ctrlPath = path.replace('/gw/', '/ctrl/');
        const url = `${this.baseUrl}${ctrlPath}`;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (url.startsWith('https://')) {
          const authHeaders = await getCloudRunAuthHeaders(this.baseUrl, url);
          Object.assign(headers, authHeaders);
        }
        res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      } else {
        const f = this.fetcher;
        if (!f) {
          throw new GatewayError('gateway not initialized — call initDataplane before gatewayClientFor', 0);
        }
        // CF service-binding path: host is ignored by the binding.
        res = await f.fetch(`https://dataplane${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new GatewayError(
          `gateway ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError(
        `gateway ${method} ${path} failed: ${(err as Error).message}`,
        0,
      );
    } finally {
      clearTimeout(t);
    }
  }

  pushSnapshot(req: SnapshotRequest): Promise<GatewayAck> {
    const { datalakeId, ...rest } = req;
    return this.send<GatewayAck>('POST', '/gw/snapshot', { endpointId: datalakeId, ...rest }, 45_000);
  }

  describe(
    _tables?: { schema: string; table: string }[],
  ): Promise<{ tables: GatewayTableInfo[] }> {
    return Promise.reject(
      new GatewayError('describe not available on the data-plane gateway (Stage D)', 501),
    );
  }

  catalog(datalakeId: string): Promise<GatewayCatalog> {
    return this.send<GatewayCatalog>('POST', '/gw/catalog', { endpointId: datalakeId }, 45_000);
  }

  revoke(req: RevokeRequest): Promise<GatewayAck> {
    const { datalakeId, ...rest } = req;
    return this.send<GatewayAck>('POST', '/gw/revoke', { endpointId: datalakeId, ...rest });
  }

  status(datalakeId: string): Promise<GatewayStatus> {
    return this.send<GatewayStatus>(
      'GET',
      `/gw/status?endpointId=${encodeURIComponent(datalakeId)}`,
    );
  }

  teardownGateways(datalakeId: string): Promise<{ ok: boolean; legacyDestroyed?: boolean; destroyed?: number }> {
    return this.send('POST', '/gw/teardown-legacy', { endpointId: datalakeId });
  }

  drainAudit(datalakeId: string): Promise<{ records: GatewayAuditRecord[]; count: number }> {
    return this.send<{ records: GatewayAuditRecord[]; count: number }>(
      'POST',
      '/gw/audit-drain',
      { endpointId: datalakeId },
    );
  }

  wakeReplica(datalakeId: string, n: number): Promise<{ replicaKey: string; appliedVersion: number }> {
    return this.send('POST', `/gw/replica/${n}/wake`, { endpointId: datalakeId });
  }
  sleepReplica(datalakeId: string, n: number): Promise<{ ok: boolean }> {
    return this.send('POST', `/gw/replica/${n}/sleep`, { endpointId: datalakeId });
  }
  destroyReplica(datalakeId: string, n: number): Promise<{ ok: boolean }> {
    return this.send('POST', `/gw/replica/${n}/destroy`, { endpointId: datalakeId });
  }
  rearmReplica(datalakeId: string, n: number): Promise<{ ok: boolean; appliedVersion: number }> {
    return this.send('POST', `/gw/replica/${n}/rearm`, { endpointId: datalakeId });
  }
  reapplyReplica(datalakeId: string, n: number, force = true): Promise<{ ok: boolean; reapplied: boolean; grants?: number; reason?: string }> {
    return this.send('POST', `/gw/replica/${n}/reapply`, { endpointId: datalakeId, force });
  }
  replicaStatus(datalakeId: string): Promise<{
    version: number;
    replicas: Array<{ index: number; appliedVersion: number; current: boolean; lastActiveAt: number; inFlight: number; warm: boolean }>;
  }> {
    return this.send('GET', `/gw/replicas?endpointId=${encodeURIComponent(datalakeId)}`);
  }

  resetPool(datalakeId: string): Promise<{ ok: boolean; clearedReplicas: number }> {
    return this.send('POST', '/gw/pool/reset', { endpointId: datalakeId });
  }
  clearSnapshot(datalakeId: string): Promise<{ ok: boolean; markedStale: number; version: number }> {
    return this.send('POST', '/gw/pool/clear-snapshot', { endpointId: datalakeId });
  }
}

export interface GatewayAuditRecord {
  tsUs: number;
  event: string;
  sid: string;
  user: string;
  decision: string;
  reason: string;
  query: string;
}

// ── Module-level singleton transport ─────────────────────────────────────────

let _fetcher: Fetcher | undefined;
let _baseUrl: string | undefined;

/**
 * Initialize the gateway transport. Idempotent — first call wins.
 *
 * Pass a URL string for Node/Cloud Run (HTTP transport to /ctrl/* paths).
 * Pass a Fetcher for CF workerd (service-binding transport to /gw/* paths).
 */
export function initDataplane(input: Fetcher | string): void {
  if (_fetcher !== undefined || _baseUrl !== undefined) return;
  if (typeof input === 'string') {
    if (input) _baseUrl = input.replace(/\/$/, '');
  } else {
    _fetcher = input;
  }
}

export function gatewayClientFor(_endpoint?: {
  server_token: string;
  ctrl_port?: number | null;
}): GatewayClient {
  return new GatewayClient({ fetcher: _fetcher, baseUrl: _baseUrl });
}
