'use client';

import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/dashboard/data-table';
import { StatusDot } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { useGatewayConnection, type RunOutcome } from '@/components/dashboard/use-connection';
import type { SavedView, QueryResult } from '@/lib/types';
import { cn } from '@/lib/utils';

// ── Per-view run state ────────────────────────────────────────────────────────
interface ViewState {
  pending?: boolean;
  result?: QueryResult;
  denial?: { table?: string; reason: string };
  error?: string;
}

// ── ViewsSkeleton ─────────────────────────────────────────────────────────────
function ViewsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ── EditDialog ────────────────────────────────────────────────────────────────
function EditDialog({
  view,
  open,
  onOpenChange,
  onSaved,
}: {
  view: SavedView | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [sql, setSql] = useState('');
  const [saving, setSaving] = useState(false);

  // Seed form when view changes
  useEffect(() => {
    if (view) {
      setName(view.name);
      setSql(view.sql);
    } else {
      setName('');
      setSql('');
    }
  }, [view]);

  async function handleSave() {
    if (!name.trim() || !sql.trim()) return;
    setSaving(true);
    const res = view
      ? await fetchCp(`/api/cp/views/${view.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim(), sql: sql.trim() }),
        })
      : await cpPost('/api/cp/views', { name: name.trim(), sql: sql.trim() });
    setSaving(false);
    if (res.ok) {
      toast.success(view ? `Saved "${name.trim()}"` : `Created "${name.trim()}"`);
      onOpenChange(false);
      onSaved();
    } else {
      toast.error(res.error);
    }
  }

  const title = view ? 'Edit view' : 'New view';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {view
              ? 'Update the name or SQL for this saved view.'
              : 'Save a SQL query as a reusable view.'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="py-2">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly active users"
            />
          </Field>
          <Field>
            <FieldLabel>SQL</FieldLabel>
            <Textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder="SELECT ..."
              className="font-mono text-xs"
              rows={6}
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim() || !sql.trim()}
          >
            {saving ? 'Saving…' : 'Save view'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── DeleteDialog ──────────────────────────────────────────────────────────────
function DeleteDialog({
  view,
  open,
  onOpenChange,
  onDeleted,
}: {
  view: SavedView | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!view) return;
    setDeleting(true);
    const res = await fetchCp(`/api/cp/views/${view.id}`, { method: 'DELETE' });
    setDeleting(false);
    if (res.ok) {
      toast.success(`Removed "${view.name}"`);
      onOpenChange(false);
      onDeleted(view.id);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete view</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete{' '}
            <span className="font-medium text-foreground">
              {view?.name ?? 'this view'}
            </span>
            ? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── RunContextCard ────────────────────────────────────────────────────────────
function RunContextCard({
  gw,
}: {
  gw: ReturnType<typeof useGatewayConnection>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run context</CardTitle>
        <CardDescription>
          Views execute as this agent, through its ACL — exactly what the agent
          may read.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Data Lake</Label>
            <Select
              value={gw.endpointId}
              onValueChange={gw.setEndpointId}
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Select data lake" />
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
            <Label className="text-xs text-muted-foreground">Run as agent</Label>
            <Select
              value={gw.agentId}
              onValueChange={gw.setAgentId}
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Select agent" />
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
            <RefreshCw
              data-icon="inline-start"
              className={cn(gw.connecting && 'animate-spin')}
            />
            {gw.conn ? 'Reconnect' : 'Connect'}
          </Button>

          {gw.conn ? (
            <Badge variant="outline" className="flex items-center gap-1.5">
              <StatusDot status="active" />
              connected as {gw.selectedAgent?.name ?? 'agent'} &middot;{' '}
              {gw.conn.grantedTables.length} table
              {gw.conn.grantedTables.length === 1 ? '' : 's'}
            </Badge>
          ) : gw.connectError ? (
            <Badge variant="destructive">{gw.connectError}</Badge>
          ) : (
            <Badge variant="outline" className="flex items-center gap-1.5">
              <StatusDot status="idle" />
              not connected
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── ViewCard ──────────────────────────────────────────────────────────────────
function ViewCard({
  view,
  viewState,
  onRun,
  onEdit,
  onDelete,
}: {
  view: SavedView;
  viewState: ViewState;
  onRun: (view: SavedView) => void;
  onEdit: (view: SavedView) => void;
  onDelete: (view: SavedView) => void;
}) {
  const hasResult = !!viewState.result;
  const hasDenial = !!viewState.denial;
  const hasError = !!viewState.error;
  const hasOutput = hasResult || hasDenial || hasError;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <CardTitle>{view.name}</CardTitle>
            <CardDescription className="text-xs">
              Updated {new Date(view.updatedAt).toLocaleDateString()}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => onRun(view)}
              disabled={viewState.pending}
            >
              <Play data-icon="inline-start" />
              {hasOutput ? 'Refresh' : 'Run'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEdit(view)}
            >
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDelete(view)}
            >
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <pre className="overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
          {view.sql}
        </pre>

        {viewState.pending ? (
          <Skeleton className="h-24 w-full" />
        ) : hasDenial ? (
          <Alert>
            <AlertTitle>Authorization denied</AlertTitle>
            <AlertDescription>
              {viewState.denial!.table ? (
                <span className="mr-1 font-medium">{viewState.denial!.table}:</span>
              ) : null}
              {viewState.denial!.reason}
            </AlertDescription>
          </Alert>
        ) : hasError ? (
          <Alert variant="destructive">
            <AlertTitle>Query error</AlertTitle>
            <AlertDescription>{viewState.error}</AlertDescription>
          </Alert>
        ) : hasResult ? (
          viewState.result!.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rows returned.</p>
          ) : (
            <div className="flex flex-col gap-1">
              <DataTable
                columns={viewState.result!.columns}
                rows={viewState.result!.rows}
              />
              {viewState.result!.truncated ? (
                <p className="text-xs text-muted-foreground">
                  Results truncated by row limit.
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function ViewsPage() {
  const gw = useGatewayConnection();

  const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [viewState, setViewState] = useState<Record<string, ViewState>>({});

  // Edit dialog
  const [editTarget, setEditTarget] = useState<SavedView | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<SavedView | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetchCp<{ views: SavedView[] }>('/api/cp/views');
    if (res.ok) {
      setViews(res.data.views);
      setFetchError(null);
    } else {
      setFetchError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function applyOutcome(id: string, outcome: RunOutcome) {
    if (outcome.kind === 'result') {
      setViewState((s) => ({ ...s, [id]: { pending: false, result: outcome.result } }));
    } else if (outcome.kind === 'denial') {
      setViewState((s) => ({ ...s, [id]: { pending: false, denial: outcome.denial } }));
    } else {
      setViewState((s) => ({ ...s, [id]: { pending: false, error: outcome.error } }));
    }
  }

  async function runView(view: SavedView) {
    setViewState((s) => ({
      ...s,
      [view.id]: { pending: true, result: undefined, denial: undefined, error: undefined },
    }));
    applyOutcome(view.id, await gw.run(view.sql));
  }

  function openEdit(view: SavedView) {
    setEditTarget(view);
    setEditOpen(true);
  }

  function openNew() {
    setEditTarget(null);
    setEditOpen(true);
  }

  function openDelete(view: SavedView) {
    setDeleteTarget(view);
    setDeleteOpen(true);
  }

  function handleDeleted(id: string) {
    setViewState((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
    void refresh();
  }

  if (loading) return <ViewsSkeleton />;

  if (fetchError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load views</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {fetchError}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Views</h1>
            <p className="text-sm text-muted-foreground">
              Saved SQL queries you can run as any agent through its ACL.
            </p>
          </div>
          <Button onClick={openNew}>New view</Button>
        </div>

        <RunContextCard gw={gw} />

        {views.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No views yet</EmptyTitle>
              <EmptyDescription>
                Open a notebook, write a query, and choose "Pin as view" — or
                create one here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-5">
            {views.map((view) => (
              <ViewCard
                key={view.id}
                view={view}
                viewState={viewState[view.id] ?? {}}
                onRun={(v) => void runView(v)}
                onEdit={openEdit}
                onDelete={openDelete}
              />
            ))}
          </div>
        )}
      </div>

      <EditDialog
        view={editTarget}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => void refresh()}
      />

      <DeleteDialog
        view={deleteTarget}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={handleDeleted}
      />
    </>
  );
}
