'use client';

/**
 * Gateway lifecycle panel — the dashboard surface for the Step 1/3/4/5 recovery
 * tools. Renders the per-replica pool status (appliedVersion vs current, warm,
 * in-flight) plus the ops buttons that map to the control-api endpoints:
 *
 *   Refresh policy      → POST /datalakes/:id/refresh-policy   (Step 1)
 *   wake / sleep /      → POST /datalakes/:id/replicas/:n/:op  (Step 3)
 *     destroy / rearm
 *   Reset pool /        → POST /datalakes/:id/reset-pool       (Step 4)
 *     Clear snapshot      POST /datalakes/:id/clear-snapshot
 *   Reapply snapshot    → POST /datalakes/:id/replicas/:n/reapply (Step 5)
 *
 * All actions toast the result + refetch the replica list. Destructive ops
 * (destroy, reset pool) confirm via window.confirm (lightweight; the audit trail
 * is the system of record). Read-only fetches happen on mount + a manual refresh.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Loader2,
  Power,
  Moon,
  Trash2,
  RotateCcw,
  Zap,
  AlertTriangle,
} from 'lucide-react';
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
import { Separator } from '@/components/ui/separator';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';

interface Replica {
  index: number;
  appliedVersion: number;
  current: boolean;
  lastActiveAt: number;
  inFlight: number;
  warm: boolean;
}

interface ReplicaStatus {
  version: number;
  replicas: Replica[];
}

interface GatewayPanelProps {
  datalakeId: string;
}

// Relative-time formatter for the lastActiveAt epoch-ms.
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function GatewayPanel({ datalakeId }: GatewayPanelProps) {
  const [status, setStatus] = useState<ReplicaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // The action currently in flight (label keyed by `${op}` or `${op}:${n}`) so
  // individual buttons show a spinner + disable while their call runs.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const res = await fetchCp<ReplicaStatus>(
      `/api/cp/datalakes/${datalakeId}/replicas`,
    );
    if (res.ok) setStatus(res.data);
    setLoading(false);
  }, [datalakeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (
      key: string,
      path: string,
      body: unknown,
      okMsg: (data: unknown) => string,
      confirm?: string,
    ) => {
      if (confirm && !window.confirm(confirm)) return;
      setPending((p) => ({ ...p, [key]: true }));
      const res = await cpPost<Record<string, unknown>>(path, body);
      setPending((p) => ({ ...p, [key]: false }));
      if (res.ok) {
        toast(okMsg(res.data));
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
          <CardTitle>Gateway</CardTitle>
          <CardDescription>Replica pool + lifecycle controls</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const version = status?.version ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Gateway</CardTitle>
            <CardDescription>
              Replica pool + lifecycle controls. Policy version{' '}
              <code className="font-mono">{version}</code>
              {status && status.replicas.length > 0 ? (
                <>
                  {' · '}
                  {status.replicas.length}{' '}
                  {status.replicas.length === 1 ? 'replica' : 'replicas'}
                </>
              ) : null}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* ── Replica table ───────────────────────────────────────────── */}
        {!status || status.replicas.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No replicas</EmptyTitle>
              <EmptyDescription>
                The pool is scaled to zero. It wakes on the next connect or
                refresh-policy push.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Replica</TableHead>
                <TableHead>Policy</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Load</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.replicas.map((r) => {
                const k = (op: string) => `${op}:${r.index}`;
                return (
                  <TableRow key={r.index}>
                    <TableCell className="font-mono text-xs">#{r.index}</TableCell>
                    <TableCell className="font-mono text-xs">
                      v{r.appliedVersion}
                      {r.current ? null : (
                        <span className="text-amber-600 dark:text-amber-500">
                          {' '}
                          (stale)
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.warm ? (
                        <Badge variant="secondary">warm</Badge>
                      ) : (
                        <Badge variant="outline">cold</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.inFlight} in-flight
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {ago(r.lastActiveAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending[k('reapply')]}
                          onClick={() =>
                            run(
                              k('reapply'),
                              `/api/cp/datalakes/${datalakeId}/replicas/${r.index}/reapply`,
                              {},
                              () => 'Re-applied cached snapshot to replica #' + r.index,
                            )
                          }
                        >
                          {pending[k('reapply')] ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <Zap data-icon="inline-start" />
                          )}
                          Reapply
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending[k('rearm')]}
                          onClick={() =>
                            run(
                              k('rearm'),
                              `/api/cp/datalakes/${datalakeId}/replicas/${r.index}/rearm`,
                              {},
                              () => 'Re-armed replica #' + r.index + ' from director snapshot',
                            )
                          }
                        >
                          {pending[k('rearm')] ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <RotateCcw data-icon="inline-start" />
                          )}
                          Rearm
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending[k('sleep')]}
                          onClick={() =>
                            run(
                              k('sleep'),
                              `/api/cp/datalakes/${datalakeId}/replicas/${r.index}/sleep`,
                              {},
                              () => 'Slept replica #' + r.index,
                            )
                          }
                        >
                          {pending[k('sleep')] ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <Moon data-icon="inline-start" />
                          )}
                          Sleep
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending[k('destroy')]}
                          onClick={() =>
                            run(
                              k('destroy'),
                              `/api/cp/datalakes/${datalakeId}/replicas/${r.index}/destroy`,
                              {},
                              () => 'Destroyed replica #' + r.index,
                              `Destroy replica #${r.index}? Its container is torn down and the slot removed. The next pick may spawn a different index.`,
                            )
                          }
                        >
                          {pending[k('destroy')] ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <Trash2 data-icon="inline-start" />
                          )}
                          Destroy
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Separator />

        {/* ── Pool-level actions ────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            size="sm"
            disabled={pending['refresh']}
            onClick={() =>
              run(
                'refresh',
                `/api/cp/datalakes/${datalakeId}/refresh-policy`,
                {},
                (d) => {
                  const r = d as { grants?: number; activeAgents?: number };
                  return `Pushed policy: ${r.grants ?? 0} grants, ${r.activeAgents ?? 0} agents`;
                },
              )
            }
          >
            {pending['refresh'] ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Refresh policy
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending['wake0']}
            onClick={() =>
              run(
                'wake0',
                `/api/cp/datalakes/${datalakeId}/replicas/0/wake`,
                {},
                () => 'Woke + armed replica #0',
              )
            }
          >
            {pending['wake0'] ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Power data-icon="inline-start" />
            )}
            Wake replica 0
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending['clear']}
            onClick={() =>
              run(
                'clear',
                `/api/cp/datalakes/${datalakeId}/clear-snapshot`,
                {},
                (d) => {
                  const r = d as { markedStale?: number };
                  return `Marked ${r.markedStale ?? 0} replica(s) stale`;
                },
              )
            }
          >
            {pending['clear'] ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <RotateCcw data-icon="inline-start" />
            )}
            Clear snapshot
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending['reset']}
            onClick={() =>
              run(
                'reset',
                `/api/cp/datalakes/${datalakeId}/reset-pool`,
                {},
                () => 'Pool reset — fail-closed until the next push',
                'Reset the pool? This drops the cached snapshot and zero the version — the gateway will REFUSE queries until the next refresh-policy push. Use only when the cached snapshot is suspect.',
              )
            }
          >
            {pending['reset'] ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <AlertTriangle data-icon="inline-start" />
            )}
            Reset pool
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Refresh policy</span> recompiles from
          ACL rules + pushes. <span className="font-medium">Clear snapshot</span>{' '}
          re-applies the same policy on the next pick.{' '}
          <span className="font-medium">Reset pool</span> fail-closes until the
          next push.
        </p>
      </CardContent>
    </Card>
  );
}
