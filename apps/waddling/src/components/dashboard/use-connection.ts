'use client';

/**
 * Shared "run-as-agent" gateway connection used by the Notebooks and Views
 * pages. Both need the same thing: pick an endpoint + an agent, open a governed
 * session, and run SQL through that agent's ACL (the gateway query proxy), where
 * a denial is a first-class outcome rather than an error.
 *
 * Extracted verbatim from the original Notebooks page so behavior is unchanged:
 * lazy connect on first run, transparent reconnect once on a 401 (15-min session
 * TTL), and structured denial/error mapping.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchCp, cpPost } from './fetch';
import { cpUrl } from '@/lib/control-api';
import type {
  EndpointSummary,
  AgentSummary,
  ConnectResult,
  QueryResult,
  SessionGrant,
} from '@/lib/types';

/** Live gateway session opened "as" a chosen agent. */
export interface Connection {
  sessionId: string;
  endpointId: string;
  agentId: string;
  /** "schema.table" refs the agent may touch — used for autocomplete + status. */
  grantedTables: string[];
  /** Full per-table grant (verbs + column allow-lists) from the connect payload. */
  grants: SessionGrant['tables'];
}

/** Outcome of running one statement. A denial is not an error. */
export type RunOutcome =
  | { kind: 'result'; result: QueryResult }
  | { kind: 'denial'; denial: { table?: string; reason: string } }
  | { kind: 'error'; error: string };

export interface GatewayConnection {
  endpoints: EndpointSummary[];
  agents: AgentSummary[];
  endpointId: string;
  agentId: string;
  setEndpointId: (id: string) => void;
  setAgentId: (id: string) => void;
  conn: Connection | null;
  connecting: boolean;
  connectError: string | null;
  selectedEndpoint: EndpointSummary | undefined;
  selectedAgent: AgentSummary | undefined;
  /** Open (or reopen) a session as the current selection. */
  connect: (epId?: string, agId?: string) => Promise<Connection | null>;
  /** Run SQL, connecting first if needed and reconnecting once on session expiry. */
  run: (sql: string) => Promise<RunOutcome>;
}

export function useGatewayConnection(): GatewayConnection {
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [endpointId, setEndpointIdState] = useState('');
  const [agentId, setAgentIdState] = useState('');
  const [conn, setConn] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Changing the endpoint or agent invalidates the open session.
  const setEndpointId = useCallback((id: string) => {
    setEndpointIdState(id);
    setConn(null);
  }, []);
  const setAgentId = useCallback((id: string) => {
    setAgentIdState(id);
    setConn(null);
  }, []);

  useEffect(() => {
    void (async () => {
      const [e, a] = await Promise.all([
        fetchCp<{ endpoints: EndpointSummary[] }>('/api/cp/endpoints'),
        fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      ]);
      if (e.ok) {
        setEndpoints(e.data.endpoints);
        const running = e.data.endpoints.find((x) => x.status === 'running');
        if (running) setEndpointIdState(running.id);
      }
      if (a.ok) {
        setAgents(a.data.agents);
        if (a.data.agents[0]) setAgentIdState(a.data.agents[0].id);
      }
    })();
  }, []);

  const connect = useCallback(
    async (epId?: string, agId?: string): Promise<Connection | null> => {
      const ep = epId ?? endpointId;
      const ag = agId ?? agentId;
      if (!ep || !ag) {
        setConnectError('Pick an endpoint and an agent, then Connect.');
        return null;
      }
      setConnecting(true);
      setConnectError(null);
      const res = await cpPost<ConnectResult>('/api/cp/sessions', {
        endpointId: ep,
        agentId: ag,
      });
      setConnecting(false);
      if (!res.ok) {
        setConnectError(res.error);
        setConn(null);
        return null;
      }
      const c: Connection = {
        sessionId: res.data.sessionId,
        endpointId: ep,
        agentId: ag,
        grantedTables: res.data.granted.tables.map((t) => `${t.schema}.${t.table}`),
        grants: res.data.granted.tables,
      };
      setConn(c);
      return c;
    },
    [endpointId, agentId],
  );

  /** Raw query call so we keep the structured denial body (reason/table). */
  async function execQuery(
    c: Connection,
    sql: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // The session JWT lives only in the data plane now; the server routes by the
    // sessionId in the path. The browser sends just the SQL.
    const r = await fetch(cpUrl(`/api/cp/sessions/${c.sessionId}/query`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  const run = useCallback(
    async (sql: string): Promise<RunOutcome> => {
      let c = conn;
      if (!c) {
        if (!endpointId || !agentId) {
          return { kind: 'error', error: 'Pick an endpoint and an agent, then Connect.' };
        }
        c = await connect(endpointId, agentId);
        if (!c) {
          return { kind: 'error', error: connectError ?? 'Could not open a session.' };
        }
      }

      let res = await execQuery(c, sql);
      // Session expired (15-min TTL) → transparently reconnect once and retry.
      if (res.status === 401) {
        const fresh = await connect(c.endpointId, c.agentId);
        if (fresh) {
          c = fresh;
          res = await execQuery(fresh, sql);
        }
      }

      if (res.status === 200) {
        return { kind: 'result', result: res.body as unknown as QueryResult };
      }
      if (res.body?.error === 'authorization_denied') {
        return {
          kind: 'denial',
          denial: {
            table: typeof res.body.table === 'string' ? res.body.table : undefined,
            reason:
              typeof res.body.reason === 'string'
                ? res.body.reason
                : 'Access denied by policy',
          },
        };
      }
      const reason =
        (typeof res.body?.reason === 'string' && res.body.reason) ||
        (typeof res.body?.detail === 'string' && res.body.detail) ||
        (typeof res.body?.error === 'string' && res.body.error) ||
        `Query failed (HTTP ${res.status})`;
      return { kind: 'error', error: reason };
    },
    [conn, endpointId, agentId, connect, connectError],
  );

  return {
    endpoints,
    agents,
    endpointId,
    agentId,
    setEndpointId,
    setAgentId,
    conn,
    connecting,
    connectError,
    selectedEndpoint: endpoints.find((e) => e.id === endpointId),
    selectedAgent: agents.find((a) => a.id === agentId),
    connect,
    run,
  };
}
