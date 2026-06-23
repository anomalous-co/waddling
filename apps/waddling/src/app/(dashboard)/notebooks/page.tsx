'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, Pin, Trash2, Plus } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { StatusDot } from '@/components/dashboard/status';
import { DataTable } from '@/components/dashboard/data-table';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { useGatewayConnection } from '@/components/dashboard/use-connection';
import { toast } from 'sonner';
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

// ── PinDialog ────────────────────────────────────────────────────────────────

function PinDialog({
  cell,
  onCancel,
  onConfirm,
}: {
  cell: NotebookCell | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [viewName, setViewName] = useState('');

  useEffect(() => {
    if (cell) setViewName(cell.title ?? '');
  }, [cell]);

  return (
    <Dialog open={cell !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pin as view</DialogTitle>
          <DialogDescription>
            Save this query as a named view. Views run through a chosen agent on the Views page.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={viewName}
          onChange={(e) => setViewName(e.target.value)}
          placeholder="View name"
          aria-label="View name"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && viewName.trim()) onConfirm(viewName.trim());
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!viewName.trim()}
            onClick={() => onConfirm(viewName.trim())}
          >
            Pin view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── CellCard ────────────────────────────────────────────────────────────────

function CellCard({
  cell,
  index,
  state,
  onSqlChange,
  onRun,
  onPin,
  onDelete,
}: {
  cell: NotebookCell;
  index: number;
  state: CellState;
  onSqlChange: (sql: string) => void;
  onRun: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Cell {index + 1}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={onRun}
              disabled={state.pending ?? !cell.sql.trim()}
            >
              {state.pending ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Play data-icon="inline-start" />
              )}
              Run
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onPin}
              disabled={!cell.sql.trim()}
            >
              <Pin data-icon="inline-start" />
              Pin as view
            </Button>
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          value={cell.sql}
          onChange={(e) => onSqlChange(e.target.value)}
          placeholder="SELECT ..."
          className="min-h-[120px] font-mono text-sm"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onRun();
            }
          }}
        />

        {state.denial ? (
          <Alert>
            <AlertTitle>Authorization denied</AlertTitle>
            <AlertDescription>
              {state.denial.table ? (
                <span className="font-mono text-xs">{state.denial.table} · </span>
              ) : null}
              {state.denial.reason}
            </AlertDescription>
          </Alert>
        ) : null}

        {state.error ? (
          <Alert variant="destructive">
            <AlertTitle>Query error</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        {state.result ? (
          <div>
            {state.result.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rows returned.</p>
            ) : (
              <>
                <DataTable columns={state.result.columns} rows={state.result.rows} />
                {state.result.truncated ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Results truncated by row limit.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── NotebooksPage ────────────────────────────────────────────────────────────

export default function NotebooksPage() {
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
        const last =
          typeof window !== 'undefined' ? localStorage.getItem(LAST_NB_KEY) : null;
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
  // leaves autocomplete unavailable (it never blocks queries).
  useEffect(() => {
    if (!gw.conn) {
      setSchema([]);
      return;
    }
    let active = true;
    void (async () => {
      const res = await fetchCp<{ datalakeId: string; tables: TableInfo[] }>(
        `/api/cp/datalakes/${gw.conn!.endpointId}/describe?agentId=${encodeURIComponent(gw.conn!.agentId)}`,
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
    else toast.error((res as { ok: false; error: string }).error);
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

  function patchCellState(id: string, patch: CellState) {
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
    patchCellState(cell.id, {
      pending: true,
      error: undefined,
      denial: undefined,
      result: undefined,
    });
    const outcome = await gw.run(cell.sql);
    if (outcome.kind === 'result') {
      patchCellState(cell.id, { pending: false, result: outcome.result });
    } else if (outcome.kind === 'denial') {
      patchCellState(cell.id, { pending: false, denial: outcome.denial });
    } else {
      patchCellState(cell.id, { pending: false, error: outcome.error });
    }
  }

  async function pinAsView(viewName: string) {
    if (!pinTarget) return;
    const res = await cpPost('/api/cp/views', { name: viewName, sql: pinTarget.sql });
    setPinTarget(null);
    if (res.ok) toast.success(`Pinned "${viewName}" to Views`);
    else toast.error((res as { ok: false; error: string }).error);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notebooks</h1>
        <p className="text-sm text-muted-foreground">
          Write governed SQL and run it as any agent through its ACL.
        </p>
      </div>

      {/* Notebook picker + actions */}
      <div className="flex flex-wrap items-center gap-3">
        {loadingList ? (
          <Skeleton className="h-8 w-64" />
        ) : (
          <Select
            value={selectedId || undefined}
            onValueChange={(v) => setSelectedId(v)}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select a notebook…" />
            </SelectTrigger>
            <SelectContent>
              {notebooks.map((nb) => (
                <SelectItem key={nb.id} value={nb.id}>
                  {nb.name} ({nb.cellCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="secondary" onClick={() => void createNotebook()}>
          <Plus data-icon="inline-start" />
          New notebook
        </Button>
        {selectedId ? (
          <Button variant="ghost" onClick={() => void deleteNotebook()}>
            <Trash2 data-icon="inline-start" />
            Delete
          </Button>
        ) : null}
      </div>

      {selectedId ? (
        <div className="flex flex-col gap-5">
          {/* Name + save */}
          <div className="flex items-center gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Notebook name"
              className="max-w-sm"
            />
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              Save
            </Button>
          </div>

          {/* Run context */}
          <Card>
            <CardHeader>
              <CardTitle>Run context</CardTitle>
              <CardDescription>
                Cells execute as this agent, through its ACL — exactly what the agent may touch.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Data Lake</label>
                  <Select
                    value={gw.endpointId || undefined}
                    onValueChange={(v) => gw.setEndpointId(v)}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="Select data lake…" />
                    </SelectTrigger>
                    <SelectContent>
                      {gw.endpoints.map((ep) => (
                        <SelectItem key={ep.id} value={ep.id}>
                          {ep.name}
                          {ep.status !== 'running' ? ` (${ep.status})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Run as agent</label>
                  <Select
                    value={gw.agentId || undefined}
                    onValueChange={(v) => gw.setAgentId(v)}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="Select agent…" />
                    </SelectTrigger>
                    <SelectContent>
                      {gw.agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={() => void gw.connect()}
                  disabled={
                    gw.connecting ||
                    !gw.endpointId ||
                    !gw.agentId ||
                    gw.selectedEndpoint?.status !== 'running'
                  }
                >
                  {gw.connecting ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {gw.conn ? 'Reconnect' : 'Connect'}
                </Button>

                {gw.conn ? (
                  <div className="flex items-center gap-1.5 text-sm">
                    <StatusDot status="active" />
                    <span>
                      connected as{' '}
                      <span className="font-medium">
                        {gw.selectedAgent?.name ?? 'agent'}
                      </span>
                      {' · '}
                      {gw.conn.grantedTables.length} table
                      {gw.conn.grantedTables.length === 1 ? '' : 's'}
                    </span>
                  </div>
                ) : gw.connectError ? (
                  <div className="flex items-center gap-1.5 text-sm text-destructive">
                    <StatusDot status="error" />
                    <span>{gw.connectError}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <StatusDot status="idle" />
                    <span>not connected</span>
                  </div>
                )}
              </div>

              {gw.conn && gw.conn.grantedTables.length > 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Granted:{' '}
                  <span className="font-mono">{gw.conn.grantedTables.join(', ')}</span>
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Cells */}
          {cells.map((cell, i) => (
            <CellCard
              key={cell.id}
              cell={cell}
              index={i}
              state={cellState[cell.id] ?? {}}
              onSqlChange={(sql) => patchCell(cell.id, { sql })}
              onRun={() => void runCell(cell)}
              onPin={() => setPinTarget(cell)}
              onDelete={() => deleteCell(cell.id)}
            />
          ))}

          <div>
            <Button variant="secondary" onClick={addCell}>
              <Plus data-icon="inline-start" />
              Add cell
            </Button>
          </div>
        </div>
      ) : (
        !loadingList ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No notebook open</EmptyTitle>
              <EmptyDescription>
                Create a notebook or pick one above to start writing governed SQL.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null
      )}

      <PinDialog
        cell={pinTarget}
        onCancel={() => setPinTarget(null)}
        onConfirm={(n) => void pinAsView(n)}
      />
    </div>
  );
}
