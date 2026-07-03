/**
 * Gateway control-channel HTTP client.
 *
 * `initDataplane(url)` sets the base URL; send() issues plain HTTP requests to
 * `<baseUrl>/ctrl/...` (path prefix rewrite /gw/ → /ctrl/). Google Cloud Run
 * identity tokens are added automatically for https:// URLs.
 */
// ── Request payloads ────────────────────────────────────────────────────────────

// CONFIG-ONLY gateway boot (spec §13 pull model). The gateway no longer receives compiled
// grant tuples — birdshot PULLS literal GRANT/DENY SQL from the ATTACHed Postgres store and
// freshness-validates it itself. So the "snapshot" push carries only scalar config: auth
// (issuer/audience/JWKS), the lake catalog alias, and the read-only grant-store DSN + scope.
export interface SnapshotRequest {
  datalakeId: string;
  auth: { issuer: string; audience: string; mode: 'rs256'; jwks: BirdshotJwk[] };
  lakeCatalog?: string;
  /** Read-only Postgres DSN the gateway ATTACHes as the protected `__birdshot` catalog +
   *  points birdshot's grant store at (scoped to `datalakeId`). Undefined ⇒ no store ATTACH. */
  grantStoreDsn?: string;
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

export interface GovernedLoadResult {
  ok: boolean;
  phase?: string;
  authorizeDecision?: string;
  error?: string | null;
}

export interface GatewayQueryResult {
  ok: boolean;
  rows: Record<string, unknown>[] | null;
  rowCount: number | null;
  error?: string | null;
  authorizeDecision?: string | null;
  phase?: string;
}

export interface RelayQueryResult {
  ok: boolean;
  columns?: string[];
  rows: unknown[][] | null;
  rowCount: number | null;
  form?: 'A' | 'B' | null;
  error?: string | null;
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

// Identity-token clients cached PER AUDIENCE. Per-endpoint gateways each have their own URL
// (= audience), so a single shared client would mint a token for the wrong audience and the
// target gateway would 403. null value = a failed init for that audience (local, no creds).
const _idTokenClients = new Map<
  string,
  { getRequestHeaders(url: string): Promise<Record<string, string>> } | null
>();

async function getCloudRunAuthHeaders(
  audience: string,
  url: string,
): Promise<Record<string, string>> {
  let client = _idTokenClients.get(audience);
  if (client === undefined) {
    try {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth();
      client = await auth.getIdTokenClient(audience);
    } catch {
      client = null;
    }
    _idTokenClients.set(audience, client ?? null);
  }
  if (!client) return {};
  try {
    return await client.getRequestHeaders(url);
  } catch {
    return {};
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface GatewayClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class GatewayClient {
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: GatewayClientOptions) {
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
      if (this.baseUrl === undefined) {
        throw new GatewayError('gateway not initialized — call initDataplane before gatewayClientFor', 0);
      }
      // Rewrite /gw/ → /ctrl/ for the Cloud Run gateway HTTP surface.
      const ctrlPath = path.replace('/gw/', '/ctrl/');
      const url = `${this.baseUrl}${ctrlPath}`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (url.startsWith('https://')) {
        const authHeaders = await getCloudRunAuthHeaders(this.baseUrl, url);
        Object.assign(headers, authHeaders);
      }
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
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
    // The Cloud Run gateway serves /ctrl/catalog as GET (entrypoint.mjs); on a per-endpoint gateway
    // the URL already selects the endpoint, so endpointId rides as a query param (inert there, used
    // by the CF worker binding).
    return this.send<GatewayCatalog>(
      'GET',
      `/gw/catalog?endpointId=${encodeURIComponent(datalakeId)}`,
      undefined,
      45_000,
    );
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

  // ── Data-path methods ─────────────────────────────────────────────────────
  // These paths carry no '/gw/' segment, so send()'s /gw/→/ctrl/ rewrite leaves
  // them intact; per-audience Cloud Run OIDC headers are still applied. The
  // caller picks the target by constructing the client with the right baseUrl
  // via gatewayClientFor({ gateway_url }).

  governedLoad(token: string, sql: string): Promise<GovernedLoadResult> {
    return this.send<GovernedLoadResult>('POST', '/governed-load', { token, sql }, 60_000);
  }

  lakeQuery(token: string, sql: string): Promise<GatewayQueryResult> {
    return this.send<GatewayQueryResult>('POST', '/query', { token, sql }, 60_000);
  }

  // Quackboard gated query: authorize the agent's statement, then run it on the gateway's TRUSTED
  // connection (which owns the served quackboard db). Handles unqualified reads AND writes — unlike
  // /query, whose read-only quack-ATTACH-as-lake path can't resolve bare names or persist writes.
  qbGatedQuery(token: string, sql: string): Promise<GatewayQueryResult> {
    return this.send<GatewayQueryResult>('POST', '/qb-query', { token, sql }, 60_000);
  }

  relayQuery(sql: string): Promise<RelayQueryResult> {
    return this.send<RelayQueryResult>('POST', '/relay-query', { sql }, 60_000);
  }

  configureLake(args: { lakeProxy: string; lakeToken: string; disableSsl?: boolean }): Promise<{ ok: boolean; lakeAttached?: boolean; error?: string }> {
    return this.send('POST', '/ctrl/configure-lake', { lakeProxy: args.lakeProxy, lakeToken: args.lakeToken, disableSsl: args.disableSsl ?? false }, 45_000);
  }

  checkpointWorkspace(): Promise<{ ok: boolean; error?: string }> {
    return this.send('POST', '/ctrl/checkpoint', {}, 45_000);
  }

  qbRemember(body: unknown): Promise<any> {
    return this.send('POST', '/ctrl/qb-remember', body);
  }
  qbMine(body: unknown): Promise<any> {
    return this.send('POST', '/ctrl/qb-mine', body);
  }
  qbRecall(body: unknown): Promise<any> {
    return this.send('POST', '/ctrl/qb-recall', body);
  }

  // Generic escape hatch for any other /ctrl/* route without a dedicated method.
  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.send<T>('POST', path, body, timeoutMs);
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

let _baseUrl: string | undefined;

/**
 * Initialize the gateway transport. Idempotent — first call wins.
 *
 * Pass the base URL of the Cloud Run gateway (HTTP transport to /ctrl/* paths).
 */
export function initDataplane(input: string | undefined): void {
  if (_baseUrl !== undefined) return;
  if (input) _baseUrl = input.replace(/\/$/, '');
}

// Resolve the gateway for a given datalake. Per-endpoint gateways carry their own Cloud Run
// URL (datalake.gateway_url, set by the provisioner at create); when present it is the target
// (and its own identity-token audience). Falls back to the module GATEWAY_BASE_URL (single-
// gateway bring-up) for unprovisioned endpoints.
export function gatewayClientFor(_endpoint?: {
  server_token?: string;
  ctrl_port?: number | null;
  gateway_url?: string | null;
}): GatewayClient {
  const baseUrl = _endpoint?.gateway_url || _baseUrl;
  return new GatewayClient({ baseUrl });
}
