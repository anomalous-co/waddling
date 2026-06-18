'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Card,
  CardHeader,
  Button,
  Input,
  Select,
  Badge,
  Spinner,
  SectionTitle,
  EmptyState,
  Modal,
} from '@/components/dashboard/ui';
import { MonacoSql } from '@/components/dashboard/monaco-sql';
import { DataTable } from '@/components/dashboard/data-table';
import { useToast } from '@/components/dashboard/toast';
import { useGatewayConnection } from '@/components/dashboard/use-connection';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type { QueryResult, TableInfo } from '@/lib/types';

interface NotebookCell {
  id: string;
  sql: string;
  title?: string;
}
interface NotebookSummary {
  id: string;
  name: string;
  cellCount: number;
  updatedAt: string;
}
interface Notebook {
  id: string;
  name: string;
  cells: NotebookCell[];
  updatedAt: string;
}

/** Per-cell run state. A denial is a first-class outcome, not an error. */
interface CellState {
  pending?: boolean;
  result?: QueryResult;
  denial?: { table?: string; reason: string };
  error?: string;
}

// Remember the last-opened notebook across visits (per browser).
const LAST_NB_KEY = 'waddling:lastNotebookId';

const STARTER_SQL = 'SELECT * FROM sales.orders LIMIT 10';
let cellSeq = 0;
function newCell(sql = STARTER_SQL): NotebookCell {
  cellSeq += 1;
  return { id: `cell-${Date.now()}-${cellSeq}`, sql };
}

export default function NotebooksPage() {
  const toast = useToast();
  const gw = useGatewayConnection();

  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [name, setName] = useState('');
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [cellState, setCellState] = useState<Record<string, CellState>>({});
  const [saving, setSaving] = useState(false);
  const [loadingList, setLoadingList] = useState(true);

  // Schema for autocomplete: columns + types of the connected agent's granted
  // tables, fetched via the governed describe endpoint after connect.
  const [schema, setSchema] = useState<TableInfo[]>([]);

  // Pin-as-view dialog target (a cell whose SQL should be saved as a view).
  const [pinTarget, setPinTarget] = useState<NotebookCell | null>(null);

  // Restore the last-opened notebook exactly once, after the first list load.
  const restoredRef = useRef(false);

  const refreshList = useCallback(async () => {
    const res = await fetchCp<{ notebooks: NotebookSummary[] }>('/api/cp/notebooks');
    if (res.ok) {
      setNotebooks(res.data.notebooks);
      if (!restoredRef.current) {
        restoredRef.current = true;
        const last = typeof window !== 'undefined' ? localStorage.getItem(LAST_NB_KEY) : null;
        // Only restore if it still exists in this org's notebooks.
        if (last && res.data.notebooks.some((nb) => nb.id === last)) {
          setSelectedId(last);
        }
      }
    }
    setLoadingList(false);
  }, []);

  // Persist the current selection so it reopens next visit.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (selectedId) localStorage.setItem(LAST_NB_KEY, selectedId);
  }, [selectedId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Probe the connected agent's schema (columns + types) for autocomplete.
  // Scoped to the agent's grants by the describe endpoint; a failed probe just
  // leaves autocomplete on table names + keywords (it never blocks queries).
  useEffect(() => {
    if (!gw.conn) {
      setSchema([]);
      return;
    }
    let active = true;
    void (async () => {
      const res = await fetchCp<{ endpointId: string; tables: TableInfo[] }>(
        `/api/cp/endpoints/${gw.conn!.endpointId}/describe?agentId=${encodeURIComponent(gw.conn!.agentId)}`,
      );
      if (active && res.ok) setSchema(res.data.tables);
    })();
    return () => {
      active = false;
    };
  }, [gw.conn]);

  // Load a selected notebook's cells.
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void (async () => {
      const res = await fetchCp<{ notebook: Notebook }>(`/api/cp/notebooks/${selectedId}`);
      if (!active) return;
      if (res.ok) {
        const nb = res.data.notebook;
        setName(nb.name);
        setCells(nb.cells?.length ? nb.cells : [newCell()]);
        setCellState({});
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedId]);

  async function createNotebook() {
    const res = await cpPost<{ notebook: Notebook }>('/api/cp/notebooks', {
      name: `Notebook ${notebooks.length + 1}`,
      cells: [newCell()],
    });
    if (res.ok) {
      await refreshList();
      setSelectedId(res.data.notebook.id);
      toast.success('Notebook created');
    } else {
      toast.error(res.error);
    }
  }

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    const res = await fetchCp(`/api/cp/notebooks/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, cells }),
    });
    await refreshList();
    setSaving(false);
    if (res.ok) toast.success('Notebook saved');
    else toast.error(res.error);
  }

  async function deleteNotebook() {
    if (!selectedId) return;
    await fetchCp(`/api/cp/notebooks/${selectedId}`, { method: 'DELETE' });
    if (typeof window !== 'undefined') localStorage.removeItem(LAST_NB_KEY);
    setSelectedId('');
    setName('');
    setCells([]);
    await refreshList();
    toast.success('Notebook deleted');
  }

  function patchCell(id: string, patch: Partial<NotebookCell>) {
    setCells((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function setState(id: string, patch: CellState) {
    setCellState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  }
  function addCell() {
    setCells((cs) => [...cs, newCell('')]);
  }
  function deleteCell(id: string) {
    setCells((cs) => cs.filter((c) => c.id !== id));
    setCellState((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  }

  async function runCell(cell: NotebookCell) {
    if (!cell.sql.trim()) return;
    setState(cell.id, { pending: true, error: undefined, denial: undefined, result: undefined });
    const outcome = await gw.run(cell.sql);
    if (outcome.kind === 'result') {
      setState(cell.id, { pending: false, result: outcome.result });
    } else if (outcome.kind === 'denial') {
      setState(cell.id, { pending: false, denial: outcome.denial });
    } else {
      setState(cell.id, { pending: false, error: outcome.error });
    }
  }

  async function pinAsView(viewName: string) {
    if (!pinTarget) return;
    const res = await cpPost('/api/cp/views', { name: viewName, sql: pinTarget.sql });
    setPinTarget(null);
    if (res.ok) toast.success(`Pinned "${viewName}" to Views`);
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      <SectionTitle>Notebooks</SectionTitle>

      {/* Notebook picker + actions */}
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-64"
        >
          <option value="">Select a notebook…</option>
          {notebooks.map((nb) => (
            <option key={nb.id} value={nb.id}>
              {nb.name} ({nb.cellCount})
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={createNotebook}>
          + New notebook
        </Button>
        {selectedId && (
          <Button variant="ghost" onClick={deleteNotebook}>
            Delete
          </Button>
        )}
      </div>

      {!selectedId ? (
        loadingList ? (
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : (
          <EmptyState
            title="No notebook open"
            description="Create a notebook or pick one above to start writing governed SQL."
          />
        )
      ) : (
        <div className="space-y-5">
          {/* Name + save */}
          <div className="flex items-center gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Notebook name"
              className="max-w-sm"
            />
            <Button variant="primary" onClick={save} loading={saving}>
              Save
            </Button>
          </div>

          {/* Run-as context */}
          <Card>
            <CardHeader
              title="Run context"
              subtitle="Cells execute AS this agent, through its ACL — exactly what the agent may touch."
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
                disabled={
                  !gw.endpointId || !gw.agentId || gw.selectedEndpoint?.status !== 'running'
                }
              >
                {gw.conn ? 'Reconnect' : 'Connect'}
              </Button>
              {gw.conn ? (
                <Badge variant="green">
                  connected as {gw.selectedAgent?.name ?? 'agent'} · {gw.conn.grantedTables.length}{' '}
                  table{gw.conn.grantedTables.length === 1 ? '' : 's'}
                </Badge>
              ) : gw.connectError ? (
                <Badge variant="red">{gw.connectError}</Badge>
              ) : (
                <Badge variant="neutral">not connected</Badge>
              )}
            </div>
            {gw.conn && gw.conn.grantedTables.length > 0 && (
              <p className="mt-2 text-xs text-neutral-500">
                Granted:{' '}
                <span className="font-mono text-neutral-400">
                  {gw.conn.grantedTables.join(', ')}
                </span>
              </p>
            )}
          </Card>

          {/* Cells */}
          {cells.map((cell, i) => {
            const st = cellState[cell.id] ?? {};
            return (
              <Card key={cell.id}>
                <CardHeader
                  title={`Cell ${i + 1}`}
                  action={
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => runCell(cell)}
                        loading={st.pending}
                        disabled={!cell.sql.trim()}
                      >
                        ▶ Run
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPinTarget(cell)}
                        disabled={!cell.sql.trim()}
                      >
                        ⊕ Pin as view
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteCell(cell.id)}>
                        Delete
                      </Button>
                    </div>
                  }
                />
                <MonacoSql
                  value={cell.sql}
                  onChange={(sql) => patchCell(cell.id, { sql })}
                  tables={gw.conn?.grantedTables ?? []}
                  schema={schema}
                  onRun={() => runCell(cell)}
                />

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

          <Button variant="secondary" onClick={addCell}>
            + Add cell
          </Button>
        </div>
      )}

      <PinDialog
        cell={pinTarget}
        onCancel={() => setPinTarget(null)}
        onConfirm={pinAsView}
      />
    </div>
  );
}

function PinDialog({
  cell,
  onCancel,
  onConfirm,
}: {
  cell: NotebookCell | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState('');

  useEffect(() => {
    if (cell) setName(cell.title ?? '');
  }, [cell]);

  return (
    <Modal title="Pin as view" open={cell !== null} onClose={onCancel}>
      <p className="mb-3 text-xs text-neutral-500">
        Save this query as a named view. Views run through a chosen agent on the Views page.
      </p>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="View name"
        aria-label="View name"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) onConfirm(name.trim());
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim()} onClick={() => onConfirm(name.trim())}>
          Pin view
        </Button>
      </div>
    </Modal>
  );
}
