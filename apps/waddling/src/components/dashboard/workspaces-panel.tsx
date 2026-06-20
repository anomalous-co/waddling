'use client';

/**
 * Workspaces panel — the dashboard surface for the Step 2/7 workspace recovery
 * tools. Lists the org's per-(workspace, agent) durable DuckDB slots with their
 * live-session counts, and exposes the two recovery actions:
 *
 *   Reconfigure → POST /workspaces/:ws/agents/:a/reconfigure  (Step 2+7)
 *                  re-ATTACH the lake with lockConfiguration:false — recovers a
 *                  SURVIVING container without losing its file.
 *   Destroy     → POST /workspaces/:ws/agents/:a/destroy       (Step 2)
 *                  tear down the container; with purge, also delete the R2 file
 *                  so the next connect bootstraps fresh (the lock_configuration
 *                  deadlock recovery).
 *
 * Loaded once on mount + on manual refresh. Actions toast + refetch.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Trash2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';

interface WorkspaceRow {
  workspaceId: string;
  workspaceName: string;
  datalakeId: string;
  datalakeName: string;
  agentId: string;
  agentName?: string;
  activeSessions: number;
  lastSessionAt?: string | null;
}

interface WorkspacesPanelProps {
  /** Restrict the list to one datalake (used on the datalake detail page).
   *  Omit on an org-wide view. */
  datalakeId?: string;
}

const rowKey = (w: WorkspaceRow) => `${w.workspaceId}:${w.agentId}`;

export function WorkspacesPanel({ datalakeId }: WorkspacesPanelProps) {
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, 'reconfigure' | 'destroy' | undefined>>({});

  const load = useCallback(async () => {
    const res = await fetchCp<{ workspaces: WorkspaceRow[] }>(`/api/cp/workspaces`);
    if (res.ok) {
      const all = res.data.workspaces;
      setRows(datalakeId ? all.filter((w) => w.datalakeId === datalakeId) : all);
    }
    setLoading(false);
  }, [datalakeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reconfigure = useCallback(
    async (w: WorkspaceRow) => {
      setPending((p) => ({ ...p, [rowKey(w)]: 'reconfigure' }));
      const res = await cpPost<{ lakeAttached?: boolean }>(
        `/api/cp/workspaces/${w.workspaceId}/agents/${w.agentId}/reconfigure`,
        {},
      );
      setPending((p) => ({ ...p, [rowKey(w)]: undefined }));
      if (res.ok) {
        toast(
          res.data.lakeAttached
            ? 'Reconfigured — lake re-attached'
            : 'Reconfigured (lake attach pending)',
        );
        void load();
      } else {
        toast.error(res.error);
      }
    },
    [load],
  );

  const destroy = useCallback(
    async (w: WorkspaceRow, purge: boolean) => {
      if (
        !window.confirm(
          purge
            ? `Destroy + PURGE this workspace? The container is torn down AND the R2 DuckDB file is deleted, so the next connect bootstraps fresh. Use this to recover from a locked/corrupt workspace.`
            : `Destroy this workspace container? The R2 file is kept; the next connect restores it.`,
        )
      )
        return;
      setPending((p) => ({ ...p, [rowKey(w)]: 'destroy' }));
      const res = await cpPost<{ purged?: boolean; killedSessions?: number }>(
        `/api/cp/workspaces/${w.workspaceId}/agents/${w.agentId}/destroy`,
        { purge },
      );
      setPending((p) => ({ ...p, [rowKey(w)]: undefined }));
      if (res.ok) {
        toast(
          `Destroyed${res.data.purged ? ' + purged' : ''}${
            res.data.killedSessions ? ` · killed ${res.data.killedSessions} session(s)` : ''
          }`,
        );
        void load();
      } else {
        toast.error(res.error);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Per-agent durable DuckDB slots</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Workspaces</CardTitle>
            <CardDescription>
              Per-agent durable DuckDB slots. Use reconfigure to re-ATTACH a
              locked container; destroy + purge to start fresh.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!rows || rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No workspaces</EmptyTitle>
              <EmptyDescription>
                Workspaces are created on an agent&apos;s first connect to a
                data lake.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Data lake</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Last session</TableHead>
                <TableHead className="text-right">Recovery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => {
                const busy = pending[rowKey(w)];
                return (
                  <TableRow key={rowKey(w)}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">
                          {w.agentName ?? w.agentId.slice(0, 8)}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {w.agentId.slice(0, 8)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {datalakeId ? (
                        <span className="font-mono text-xs">{w.workspaceName}</span>
                      ) : (
                        w.datalakeName
                      )}
                    </TableCell>
                    <TableCell>
                      {w.activeSessions > 0 ? (
                        <Badge variant="secondary">{w.activeSessions} live</Badge>
                      ) : (
                        <Badge variant="outline">idle</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {w.lastSessionAt
                        ? new Date(w.lastSessionAt).toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== undefined}
                          onClick={() => reconfigure(w)}
                        >
                          {busy === 'reconfigure' ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <Wrench data-icon="inline-start" />
                          )}
                          Reconfigure
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== undefined}
                          onClick={() => destroy(w, true)}
                        >
                          {busy === 'destroy' ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <Trash2 data-icon="inline-start" />
                          )}
                          Destroy + purge
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
