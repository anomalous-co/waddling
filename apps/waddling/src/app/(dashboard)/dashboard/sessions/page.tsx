'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { RefreshCw, Zap } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type {
  SessionSummary,
  AgentSummary,
  DatalakeSummary,
} from '@/lib/types';

// SessionSummary may carry an origin field not yet in the canonical type.
type SessionRow = SessionSummary & { origin?: string };

type StatusFilter = 'active' | 'all';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// ── skeleton ──────────────────────────────────────────────────────────────────

function SessionsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── kill confirm dialog ───────────────────────────────────────────────────────

interface KillDialogProps {
  session: SessionRow | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  killing: boolean;
}

function KillSessionDialog({ session, onOpenChange, onConfirm, killing }: KillDialogProps) {
  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Kill session</DialogTitle>
          <DialogDescription>
            This will immediately terminate session{' '}
            <span className="font-mono font-medium text-foreground">
              {session ? `${session.sid.slice(0, 8)}…` : ''}
            </span>
            . The agent will be disconnected and must re-authenticate to reconnect.
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={killing}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={killing}
          >
            <Zap data-icon="inline-start" />
            {killing ? 'Killing…' : 'Kill session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [agentById, setAgentById] = useState<Map<string, AgentSummary>>(new Map());
  const [datalakeById, setDatalakeById] = useState<Map<string, DatalakeSummary>>(new Map());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<SessionRow | null>(null);
  const [killing, setKilling] = useState(false);

  const load = useCallback(async () => {
    const [sessRes, agentRes, endRes] = await Promise.all([
      fetchCp<{ sessions: SessionRow[] }>(
        `/api/cp/sessions?status=${statusFilter}`,
      ),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
    ]);

    if (!sessRes.ok) {
      setError(sessRes.error);
      setLoading(false);
      return;
    }

    setSessions(sessRes.data.sessions ?? []);
    setError(null);

    if (agentRes.ok) {
      setAgentById(new Map(agentRes.data.agents.map((a) => [a.id, a])));
    }
    if (endRes.ok) {
      setDatalakeById(new Map(endRes.data.datalakes.map((e) => [e.id, e])));
    }

    setLoading(false);
  }, [statusFilter]);

  // Initial load + 15 s auto-refresh.
  useEffect(() => {
    setLoading(true);
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const confirmKill = useCallback(async () => {
    if (!killTarget) return;
    setKilling(true);
    const res = await cpPost<{ ok: boolean }>(
      `/api/cp/sessions/${killTarget.id}/kill`,
      {},
    );
    setKilling(false);
    if (res.ok) {
      toast.success(`Session ${killTarget.sid.slice(0, 8)}… killed`);
      setKillTarget(null);
      void load();
    } else {
      toast.error(`Failed to kill session: ${res.error}`);
    }
  }, [killTarget, load]);

  if (loading) return <SessionsSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load sessions</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  const activeSessions = sessions.filter((s) => s.status === 'active');

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
            <p className="text-sm text-muted-foreground">
              Agent connections to your governed data lakes.
            </p>
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
            <CardDescription>
              {statusFilter === 'active'
                ? `${activeSessions.length} active`
                : `${sessions.length} total`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    {statusFilter === 'active'
                      ? 'No active sessions'
                      : 'No sessions found'}
                  </EmptyTitle>
                  <EmptyDescription>
                    {statusFilter === 'active'
                      ? 'Connect an agent to see live sessions here.'
                      : 'No sessions match the current filter.'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SID</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Data Lake</TableHead>
                    <TableHead>Origin</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s) => {
                    const agent = agentById.get(s.agentId);
                    const datalake = datalakeById.get(s.datalakeId);
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs">
                          {`${s.sid.slice(0, 8)}…`}
                        </TableCell>
                        <TableCell>
                          <Link
                            href={`/dashboard/agents/${s.agentId}`}
                            className="text-primary hover:underline"
                          >
                            {agent?.name ?? `${s.agentId.slice(0, 8)}…`}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {datalake ? (
                            <Link
                              href={`/dashboard/datalakes/${s.datalakeId}`}
                              className="text-primary hover:underline"
                            >
                              {datalake.name}
                            </Link>
                          ) : (
                            <span className="font-mono text-xs text-muted-foreground">
                              {`${s.datalakeId.slice(0, 8)}…`}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {s.origin ?? '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {s.grantedRoles.length > 0
                            ? s.grantedRoles.join(', ')
                            : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {fmtTime(s.startedAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {fmtTime(s.expiresAt)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={s.status} />
                        </TableCell>
                        <TableCell>
                          {s.status === 'active' ? (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => setKillTarget(s)}
                            >
                              <Zap data-icon="inline-start" />
                              Kill
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <KillSessionDialog
        session={killTarget}
        onOpenChange={(open) => {
          if (!open) setKillTarget(null);
        }}
        onConfirm={confirmKill}
        killing={killing}
      />
    </>
  );
}
