'use client';

import { useCallback, useEffect, useState } from 'react';
import { Power, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { SectionHeader } from '@/components/dashboard/agent/kit';
import type { SessionSummary, DatalakeSummary } from '@/lib/types';

interface AgentDetailWithSessions {
  agent: { sessions?: SessionSummary[] };
  sessions?: SessionSummary[];
}

export function SessionsSection({ agentId }: { agentId: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [lakeNames, setLakeNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingKill, setPendingKill] = useState<SessionSummary | null>(null);
  const [killing, setKilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [agentRes, lakesRes] = await Promise.all([
      fetchCp<AgentDetailWithSessions>(`/api/cp/agents/${agentId}`),
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
    ]);

    if (!agentRes.ok) {
      setError(agentRes.error);
      setLoading(false);
      return;
    }

    // Support both envelope shapes: { sessions } and { agent: { sessions } }
    const data = agentRes.data;
    const resolved: SessionSummary[] =
      (data as { sessions?: SessionSummary[] }).sessions ??
      data.agent?.sessions ??
      [];
    setSessions(resolved);

    if (lakesRes.ok) {
      const map: Record<string, string> = {};
      for (const lake of lakesRes.data.datalakes ?? []) {
        map[lake.id] = lake.name;
      }
      setLakeNames(map);
    }

    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmKill = async () => {
    if (!pendingKill) return;
    setKilling(true);
    const res = await cpPost<{ ok: boolean }>(
      `/api/cp/sessions/${pendingKill.id}/kill`,
      {},
    );
    setKilling(false);
    setPendingKill(null);
    if (res.ok) {
      toast.success('Session ended');
      void load();
    } else {
      toast.error(`Failed to end session: ${res.error}`);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pt-1">
        <SectionHeader title="Sessions" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <SectionHeader title="Sessions" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      </div>
    );
  }

  const activeSessions = sessions.filter((s) => s.status === 'active');

  return (
    <div className="flex flex-col gap-3 pt-1">
      <SectionHeader
        title="Sessions"
        action={
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {activeSessions.length} active · {sessions.length} total
          </span>
        }
      />

      {sessions.length === 0 ? (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>
              This agent has not opened any sessions. Install the extension and
              connect to see live sessions here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SID</TableHead>
              <TableHead>Data lake</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">
                  {s.sid.slice(0, 8)}&hellip;
                </TableCell>
                <TableCell className="text-sm">
                  {lakeNames[s.datalakeId] ?? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {s.datalakeId.slice(0, 8)}&hellip;
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={s.status} />
                </TableCell>
                <TableCell className="tabular-nums text-xs text-muted-foreground">
                  {new Date(s.startedAt).toLocaleString()}
                </TableCell>
                <TableCell className="tabular-nums text-xs text-muted-foreground">
                  {new Date(s.expiresAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  {s.status === 'active' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs text-destructive hover:border-destructive/50 hover:text-destructive"
                      onClick={() => setPendingKill(s)}
                    >
                      <Power className="size-3" />
                      End
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AlertDialog
        open={!!pendingKill}
        onOpenChange={(o) => { if (!o) setPendingKill(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately terminate the live connection for session{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {pendingKill?.sid.slice(0, 8)}&hellip;
              </code>
              . Any in-flight queries will be interrupted. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={killing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={killing}
              onClick={(e) => {
                // Prevent Radix from closing the dialog immediately so we can
                // show the loading state; confirmKill calls setPendingKill(null)
                // on completion to close it.
                e.preventDefault();
                void confirmKill();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Power data-icon="inline-start" className="size-3.5" />
              {killing ? 'Ending…' : 'End session'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
