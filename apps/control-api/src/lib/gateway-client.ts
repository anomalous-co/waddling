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
 * Transport: the gateway now lives in the waddling-dataplane Worker's GatewayDO,
 * which is service-binding-only (no public route). So this client transports every
 * call through the DATAPLANE service binding (a Fetcher), initialized per-isolate
 * from env by middleware (see initDataplane). The data plane exposes /gw/snapshot,
 * /gw/status, /gw/revoke; it has NO /gw/describe (catalog introspection needs a real
 * per-endpoint lake — Stage D), so `describe` throws a structured GatewayError and
 * its one caller degrades to an empty catalog. `fetch` is workerd-native.
 */
import type { BirdshotSnapshot } from './types';

// ── Request payloads ────────────────────────────────────────────────────────────

export interface SnapshotRequest {
  datalakeId: string;
  /** birdshot auth config (RS256). */
  auth: { issuer: string; audience: string; mode: 'rs256'; jwks: BirdshotJwk[] };
  snapshot: BirdshotSnapshot;
  /**
   * Catalog name birdshot resolves agent table refs against (birdshot_set_lake_catalog).
   * Real lake ⇒ the lake ATTACH alias (e.g. 'lake'); the offline demo ⇒ 'memory'.
   * Omitted ⇒ the data plane defaults to 'memory' (the demo).
   */
  lakeCatalog?: string;
  /**
   * Per-endpoint gateway boot config (real lake). The data plane injects this as the
   * gateway container's per-process env on a COLD boot, so the gateway ATTACHes the
   * endpoint's real DuckLake (its own METADATA_SCHEMA in the org's Postgres catalog +
   * s3:// data) instead of the offline demo. Omitted ⇒ the demo seed. This carries lake
   * credentials to the TRUSTED gateway only — never to the locked workspace.
   */
  gatewayBoot?: GatewayBoot;
}

/** Per-endpoint gateway boot descriptor (mirrors the data plane's GatewayBoot). */
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
  /**
   * Quackboard endpoint: boot birdshot + serve quack but do NOT ATTACH any DuckLake — the
   * served database IS the durable store. `r2Key` is the object key under which the data
   * plane restores/persists the single .duckdb file. No catalogDsn/catalogFile/s3.
   */
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

// Pool runtime status from the dataplane GatewayPoolDO (derived without waking a sleeping
// pool). Replaces the old per-gateway birdshot counts.
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

// ── Client ───────────────────────────────────────────────────────────────────

export interface GatewayClientOptions {
  /** Service binding to the waddling-dataplane Worker (env.DATAPLANE). */
  fetcher: Fetcher;
  timeoutMs?: number;
}

export class GatewayClient {
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(opts: GatewayClientOptions) {
    this.fetcher = opts.fetcher;
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
      // The data plane is private (service-binding-only); the binding IS the trust
      // boundary, so no bearer token is sent. The host is ignored by the binding.
      const res = await this.fetcher.fetch(`https://dataplane${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
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

  /** Push a birdshot ACL snapshot + RS256 JWKS to the per-endpoint GatewayDO. The
   *  data plane boots `gw:<datalakeId>` if cold and applies the snapshot (a full
   *  reset → set_auth → grants → commit), so callers MUST push the endpoint's WHOLE
   *  compiled policy (all agents), not a single agent's — see sessions/acl. */
  pushSnapshot(req: SnapshotRequest): Promise<GatewayAck> {
    // WIRE CONTRACT: the deployed dataplane reads `endpointId` (value = the datalake id).
    // Keep the internal field `datalakeId`, remap to `endpointId` on the wire.
    const { datalakeId, ...rest } = req;
    // pushSnapshot can trigger a COLD gateway boot (image provision + DuckDB init + lake
    // ATTACH). Even with extensions pre-baked that exceeds the default 10s, so a too-short
    // timeout aborts mid-boot AND the abort kills the in-flight boot → it never warms (a
    // vicious cycle). Give the boot room to finish in one connect.
    return this.send<GatewayAck>('POST', '/gw/snapshot', { endpointId: datalakeId, ...rest }, 45_000);
  }

  /**
   * Introspect columns/types for granted tables. NOT available on the data-plane
   * gateway — catalog introspection needs the real per-endpoint DuckLake (Stage D),
   * and the GatewayDO image attaches only a demo lake. Throws a structured
   * GatewayError(501); the one caller (endpoints describe) degrades to an empty
   * catalog rather than failing the editor.
   */
  describe(
    _tables?: { schema: string; table: string }[],
  ): Promise<{ tables: GatewayTableInfo[] }> {
    return Promise.reject(
      new GatewayError('describe not available on the data-plane gateway (Stage D)', 501),
    );
  }

  revoke(req: RevokeRequest): Promise<GatewayAck> {
    // WIRE CONTRACT: dataplane reads `endpointId` (= datalake id) — remap on the wire.
    const { datalakeId, ...rest } = req;
    return this.send<GatewayAck>('POST', '/gw/revoke', { endpointId: datalakeId, ...rest });
  }

  status(datalakeId: string): Promise<GatewayStatus> {
    // WIRE CONTRACT: dataplane query param is `endpointId` (= datalake id).
    return this.send<GatewayStatus>(
      'GET',
      `/gw/status?endpointId=${encodeURIComponent(datalakeId)}`,
    );
  }

  /** Tear down a datalake's gateway pool + any abandoned legacy static gateway DO. */
  teardownGateways(datalakeId: string): Promise<{ ok: boolean; legacyDestroyed?: boolean; destroyed?: number }> {
    return this.send('POST', '/gw/teardown-legacy', { endpointId: datalakeId });
  }

  /**
   * Drain the per-endpoint gateway's birdshot audit log. Returns the authorize /
   * authenticate records logged on the quack/workspace path since the last drain
   * (DESTRUCTIVE — each record once). Cold gateway ⇒ empty. control-api persists
   * these as `source='gateway'` audit rows so queries show in the dashboard.
   */
  drainAudit(datalakeId: string): Promise<{ records: GatewayAuditRecord[]; count: number }> {
    return this.send<{ records: GatewayAuditRecord[]; count: number }>(
      'POST',
      '/gw/audit-drain',
      { endpointId: datalakeId }, // WIRE CONTRACT: dataplane reads `endpointId` (= datalake id)
    );
  }

  // ── per-replica lifecycle (Step 3) ──────────────────────────────────────────────
  // The client half of the /gw/replica/:n/{op} + /gw/replicas contract. Used by the
  // Internal MCP admin tools (Step 6) and the dashboard (Step 8). Each takes the
  // datalake id (remapped to `endpointId` on the wire, matching the other /gw routes).

  /** Force-boot + arm replica n with the current snapshot (creates the slot if missing). */
  wakeReplica(datalakeId: string, n: number): Promise<{ replicaKey: string; appliedVersion: number }> {
    return this.send('POST', `/gw/replica/${n}/wake`, { endpointId: datalakeId });
  }
  /** Stop replica n's container but keep its slot (next access cold-boots + re-arms). */
  sleepReplica(datalakeId: string, n: number): Promise<{ ok: boolean }> {
    return this.send('POST', `/gw/replica/${n}/sleep`, { endpointId: datalakeId });
  }
  /** Destroy replica n's container AND remove its slot from the pool (scale down). */
  destroyReplica(datalakeId: string, n: number): Promise<{ ok: boolean }> {
    return this.send('POST', `/gw/replica/${n}/destroy`, { endpointId: datalakeId });
  }
  /** Force re-apply the director's CACHED snapshot to replica n (warm or cold). */
  rearmReplica(datalakeId: string, n: number): Promise<{ ok: boolean; appliedVersion: number }> {
    return this.send('POST', `/gw/replica/${n}/rearm`, { endpointId: datalakeId });
  }
  /** Re-apply the replica CONTAINER's own last-cached snapshot (no control-plane round
   *  trip). Recovers a hot replica with a corrupted in-memory birdshot policy. 409 if
   *  the container has never received a snapshot (cold boot). `force` defaults true. */
  reapplyReplica(datalakeId: string, n: number, force = true): Promise<{ ok: boolean; reapplied: boolean; grants?: number; reason?: string }> {
    return this.send('POST', `/gw/replica/${n}/reapply`, { endpointId: datalakeId, force });
  }
  /** Per-replica detail (index, appliedVersion, current, lastActiveAt, inFlight, warm). */
  replicaStatus(datalakeId: string): Promise<{
    version: number;
    replicas: Array<{ index: number; appliedVersion: number; current: boolean; lastActiveAt: number; inFlight: number; warm: boolean }>;
  }> {
    return this.send('GET', `/gw/replicas?endpointId=${encodeURIComponent(datalakeId)}`);
  }

  // ── pool-director reset (Step 4) ───────────────────────────────────────────────
  /** Drop the cached snapshot + zero currentVersion (fail-closed until the next push). */
  resetPool(datalakeId: string): Promise<{ ok: boolean; clearedReplicas: number }> {
    return this.send('POST', '/gw/pool/reset', { endpointId: datalakeId });
  }
  /** Keep the cache but mark every replica stale so the next pick re-applies it. */
  clearSnapshot(datalakeId: string): Promise<{ ok: boolean; markedStale: number; version: number }> {
    return this.send('POST', '/gw/pool/clear-snapshot', { endpointId: datalakeId });
  }
}

/** One drained birdshot audit record (free-text fields already b64-decoded by the gateway). */
export interface GatewayAuditRecord {
  /** birdshot NowUs() — epoch MICROSECONDS. */
  tsUs: number;
  /** 'authorize' | 'authenticate'. */
  event: string;
  /** quack per-connection session id (NOT the control-plane jti). */
  sid: string;
  /** JWT `sub` — 'agent:<agentId>'. */
  user: string;
  /** 'allow' | 'deny' | ''. */
  decision: string;
  reason: string;
  query: string;
}

/**
 * Per-isolate DATAPLANE service-binding singleton + throwing getter (mirrors db.ts's
 * pool pattern). A middleware calls `initDataplane(env.DATAPLANE)` once before any
 * handler, and `gatewayClientFor` reads it via the getter — keeping that function's
 * signature unchanged from the original (callers still pass the endpoint row).
 */
let _dataplane: Fetcher | undefined;

/** Idempotent per-isolate DATAPLANE binding initializer. First call wins. */
export function initDataplane(fetcher: Fetcher): void {
  if (_dataplane === undefined) {
    _dataplane = fetcher;
  }
}

function getDataplane(): Fetcher {
  if (_dataplane === undefined) {
    throw new Error(
      'DATAPLANE binding not initialized — initDataplane(env.DATAPLANE) must run before gatewayClientFor',
    );
  }
  return _dataplane;
}

/**
 * Build a gateway control-channel client. The `endpoint` row is accepted for
 * call-site compatibility (and to make the per-endpoint intent legible) but its
 * fields are no longer used for transport: every endpoint's control channel is
 * routed through the single DATAPLANE binding, and the GatewayDO is keyed per
 * endpoint INSIDE the data plane by the `datalakeId` carried in each request body.
 */
export function gatewayClientFor(_endpoint?: {
  server_token: string;
  ctrl_port?: number | null;
}): GatewayClient {
  return new GatewayClient({ fetcher: getDataplane() });
}
