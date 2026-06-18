'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  CardHeader,
  Button,
  Select,
  Badge,
  Spinner,
  SectionTitle,
  EmptyState,
} from '@/components/dashboard/ui';
import { DataTable } from '@/components/dashboard/data-table';
import { useToast } from '@/components/dashboard/toast';
import { useGatewayConnection, type RunOutcome } from '@/components/dashboard/use-connection';
import { fetchCp } from '@/components/dashboard/fetch';
import type { SavedView, QueryResult } from '@/lib/types';

/** Per-view run state. A denial is a first-class outcome, not an error. */
interface ViewState {
  pending?: boolean;
  result?: QueryResult;
  denial?: { table?: string; reason: string };
  error?: string;
}

export default function ViewsPage() {
  const toast = useToast();
  const gw = useGatewayConnection();

  const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<Record<string, ViewState>>({});

  const refresh = useCallback(async () => {
    const res = await fetchCp<{ views: SavedView[] }>('/api/cp/views');
    if (res.ok) setViews(res.data.views);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function applyOutcome(id: string, outcome: RunOutcome) {
    if (outcome.kind === 'result') {
      setState((s) => ({ ...s, [id]: { pending: false, result: outcome.result } }));
    } else if (outcome.kind === 'denial') {
      setState((s) => ({ ...s, [id]: { pending: false, denial: outcome.denial } }));
    } else {
      setState((s) => ({ ...s, [id]: { pending: false, error: outcome.error } }));
    }
  }

  async function runView(view: SavedView) {
    setState((s) => ({
      ...s,
      [view.id]: { pending: true, result: undefined, denial: undefined, error: undefined },
    }));
    applyOutcome(view.id, await gw.run(view.sql));
  }

  async function deleteView(view: SavedView) {
    const res = await fetchCp(`/api/cp/views/${view.id}`, { method: 'DELETE' });
    if (res.ok) {
      setState((s) => {
        const next = { ...s };
        delete next[view.id];
        return next;
      });
      await refresh();
      toast.success(`Removed "${view.name}"`);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle>Views</SectionTitle>

      {/* Run-as context — shared with Notebooks. */}
      <Card>
        <CardHeader
          title="Run context"
          subtitle="Views execute AS this agent, through its ACL — exactly what the agent may read."
        />
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-neutral-500 block mb-1">Endpoint</label>
            <Select
              value={gw.endpointId}
              onChange={(e) => gw.setEndpointId(e.target.value)}
              className="w-52"
            >
              {gw.endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name} {ep.status === 'running' ? '' : `(${ep.status})`}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs text-neutral-500 block mb-1">Run as agent</label>
            <Select
              value={gw.agentId}
              onChange={(e) => gw.setAgentId(e.target.value)}
              className="w-52"
            >
              {gw.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="primary"
            onClick={() => gw.connect()}
            loading={gw.connecting}
            disabled={!gw.endpointId || !gw.agentId || gw.selectedEndpoint?.status !== 'running'}
          >
            {gw.conn ? 'Reconnect' : 'Connect'}
          </Button>
          {gw.conn ? (
            <Badge variant="green">
              connected as {gw.selectedAgent?.name ?? 'agent'} · {gw.conn.grantedTables.length} table
              {gw.conn.grantedTables.length === 1 ? '' : 's'}
            </Badge>
          ) : gw.connectError ? (
            <Badge variant="red">{gw.connectError}</Badge>
          ) : (
            <Badge variant="neutral">not connected</Badge>
          )}
        </div>
      </Card>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : views.length === 0 ? (
        <EmptyState
          title="No views yet"
          description="Open a notebook, write a query, and choose “Pin as view”."
        />
      ) : (
        <div className="space-y-5">
          {views.map((view) => {
            const st = state[view.id] ?? {};
            return (
              <Card key={view.id}>
                <CardHeader
                  title={view.name}
                  action={
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => runView(view)}
                        loading={st.pending}
                      >
                        {st.result || st.denial || st.error ? '↻ Refresh' : '▶ Run'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteView(view)}>
                        Delete
                      </Button>
                    </div>
                  }
                />
                <pre className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-green-300 whitespace-pre-wrap break-all">
                  {view.sql}
                </pre>

                {st.denial && (
                  <div className="mt-3 rounded-md border border-yellow-800 bg-yellow-900/30 px-3 py-2 text-sm">
                    <span className="font-medium text-yellow-300">Authorization denied</span>
                    {st.denial.table && (
                      <span className="text-yellow-400/80"> · {st.denial.table}</span>
                    )}
                    <p className="mt-0.5 text-yellow-200/80">{st.denial.reason}</p>
                  </div>
                )}
                {st.error && (
                  <div className="mt-3 rounded-md border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-300">
                    {st.error}
                  </div>
                )}
                {st.result && (
                  <div className="mt-3">
                    {st.result.rows.length === 0 ? (
                      <p className="text-sm text-neutral-500">No rows returned.</p>
                    ) : (
                      <>
                        <DataTable columns={st.result.columns} rows={st.result.rows} />
                        {st.result.truncated && (
                          <p className="mt-1 text-xs text-neutral-600">
                            Results truncated by row limit.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
