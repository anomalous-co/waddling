/**
 * Gateway control-channel HTTP client
 * (ported from apps/waddling/src/lib/gateway-client.ts, W1 → W3 contract).
 *
 * The per-org DuckDB gateway (`packages/gateway`, W3) exposes a control port that
 * the control plane drives:
 *
 *   POST /gw/snapshot     — atomic birdshot policy snapshot (reset→set_auth→grants→constraints→commit)
 *   POST /gw/revoke        — birdshot_revoke (instant denylist)
 *   POST /gw/describe      — introspect lake columns/types (control plane filters to grants)
 *   GET  /gw/status        — birdshot_status() + DuckLake snapshot lag
 *
 * There is NO agent data path on the control channel. Column/row/window ACLs are
 * carried in the snapshot (`roleConstraints`) and enforced by birdshot's bind-walk;
 * the old POST /gw/constraints + /gw/query proxy were retired (the trusted-conn
 * bypass). Agent SQL reaches the lake only via the birdshot-gated quack path.
 *
 * W3 implements the server side to THESE EXACT request/response shapes. Types are
 * defined locally (re-using ./types where a shared shape exists) because they are a
 * control-channel wire contract, not a domain model.
 *
 * Workers difference vs the original: the original derived the control-channel base
 * URL from the endpoint row's `gateway_host`/`quack_port`. On Cloudflare the control
 * plane tunnels to the EXISTING Rivet/GCP gateway at a single internal URL
 * (env.GATEWAY_INTERNAL_URL), so `gatewayClientFor` reads that via the per-isolate
 * getter (initialized from env by middleware — see initGatewayBaseUrl). The
 * endpoint's `server_token` still authorizes the call. `fetch` is workerd-native;
 * no node:http is used.
 */
import type { BirdshotSnapshot } from './types';

// ── Request payloads ────────────────────────────────────────────────────────────

export interface SnapshotRequest {
  endpointId: string;
  /** birdshot auth config (RS256). */
  auth: { issuer: string; audience: string; mode: 'rs256'; jwks: BirdshotJwk[] };
  snapshot: BirdshotSnapshot;
}

export interface BirdshotJwk {
  kid: string;
  n: string;
  e: string;
}

export interface RevokeRequest {
  endpointId: string;
  kind: 'user' | 'jti' | 'session';
  id: string;
  reason: string;
  /** Microseconds-from-now until the revocation expires; 0/undefined ⇒ forever. */
  expiresUs?: number;
}

// ── Responses ─────────────────────────────────────────────────────────────────

export interface GatewayAck {
  ok: boolean;
  snapshotVersion?: string;
}

/** A table's columns/types as introspected by the gateway (/gw/describe). */
export interface GatewayTableInfo {
  schema: string;
  table: string;
  columns: { name: string; type: string; nullable?: boolean }[];
}

export interface GatewayStatus {
  ok: boolean;
  authMode: string;
  policySize: number;
  sessionCount: number;
  auditRingDepth: number;
  snapshotLag?: number;
}

export class GatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface GatewayClientOptions {
  /** Control-channel base URL, e.g. `http://gw-prod-lake.getwaddling.com:9510`. */
  baseUrl: string;
  /** Shared secret authorizing control-plane → gateway calls (endpoint.server_token). */
  serverToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GatewayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.serverToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
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
    return this.send<GatewayAck>('POST', '/gw/snapshot', req);
  }

  /**
   * Introspect columns/types for the given tables (the gateway returns FULL
   * schema; the caller filters to the agent's grants). Pass the agent's granted
   * table refs to avoid shipping the whole catalog.
   */
  describe(
    tables?: { schema: string; table: string }[],
  ): Promise<{ tables: GatewayTableInfo[] }> {
    return this.send<{ tables: GatewayTableInfo[] }>('POST', '/gw/describe', { tables });
  }

  revoke(req: RevokeRequest): Promise<GatewayAck> {
    return this.send<GatewayAck>('POST', '/gw/revoke', req);
  }

  status(endpointId: string): Promise<GatewayStatus> {
    return this.send<GatewayStatus>(
      'GET',
      `/gw/status?endpoint=${encodeURIComponent(endpointId)}`,
    );
  }
}

/**
 * Per-isolate gateway base-URL singleton + throwing getter (mirrors db.ts's pool
 * pattern). On workerd the control plane reaches a single internal gateway URL
 * sourced from env; a middleware calls `initGatewayBaseUrl(env.GATEWAY_INTERNAL_URL)`
 * once before any handler, and `gatewayClientFor` reads it via the getter. This keeps
 * `gatewayClientFor`'s signature unchanged from the original.
 */
let _gatewayBaseUrl: string | undefined;

/** Idempotent per-isolate gateway base-URL initializer. First call wins. */
export function initGatewayBaseUrl(baseUrl: string): void {
  if (_gatewayBaseUrl === undefined) {
    _gatewayBaseUrl = baseUrl;
  }
}

function getGatewayBaseUrl(): string {
  if (_gatewayBaseUrl === undefined) {
    throw new Error(
      'gateway base URL not initialized — initGatewayBaseUrl(env.GATEWAY_INTERNAL_URL) must run before gatewayClientFor',
    );
  }
  return _gatewayBaseUrl;
}

/** Build a client from an endpoint row's gateway runtime fields. */
export function gatewayClientFor(endpoint: {
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
  /** Control port; defaults to quack_port + 10 (demo: 9500 quack / 9510 ctrl). */
  ctrl_port?: number | null;
}): GatewayClient {
  // Stage D: repoint from GATEWAY_INTERNAL_URL to the gateway Durable Object. The
  // original derived the base URL per-endpoint from `gateway_host`/`quack_port`;
  // on Cloudflare every endpoint's control channel tunnels to one internal gateway
  // URL (the existing Rivet/GCP gateway) until the gateway moves to a CF Container/
  // Durable Object in Stage D. The endpoint's `server_token` still authorizes.
  return new GatewayClient({
    baseUrl: getGatewayBaseUrl(),
    serverToken: endpoint.server_token,
  });
}
