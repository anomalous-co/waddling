'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { RefreshCw, Trash2, Zap } from 'lucide-react';
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
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { AgentAccess } from '@/components/dashboard/agent-access';
import type { AgentSummary, SessionSummary } from '@/lib/types';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

interface AgentDetail extends AgentSummary {
  apiKeys: ApiKeyRow[];
  sessions: SessionSummary[];
}

function AgentDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [killingSession, setKillingSession] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<{ agent: AgentDetail; apiKeys: ApiKeyRow[]; sessions: SessionSummary[] }>(
      `/api/cp/agents/${params.id}`,
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      // Support both envelope shapes: { agent: { ...apiKeys, sessions } } and
      // { agent, apiKeys, sessions } (the spec says the latter).
      const data = res.data;
      const detail: AgentDetail = {
        ...data.agent,
        apiKeys: (data as { apiKeys?: ApiKeyRow[] }).apiKeys ?? data.agent.apiKeys ?? [],
        sessions: (data as { sessions?: SessionSummary[] }).sessions ?? data.agent.sessions ?? [],
      };
      setAgent(detail);
    }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const killSession = async (sessionId: string) => {
    setKillingSession(sessionId);
    const res = await cpPost<{ ok: boolean }>(
      `/api/cp/sessions/${sessionId}/kill`,
      {},
    );
    setKillingSession(null);
    if (res.ok) {
      toast.success('Session killed');
      void load();
    } else {
      toast.error(`Failed to kill session: ${res.error}`);
    }
  };

  const revokeAgent = async () => {
    if (!agent) return;
    setRevoking(true);
    const res = await cpDelete<{ ok: boolean }>(`/api/cp/agents/${agent.id}`);
    setRevoking(false);
    if (res.ok) {
      toast.success(`Agent "${agent.name}" revoked`);
      setRevokeOpen(false);
      router.push('/agents');
    } else {
      toast.error(`Failed to revoke agent: ${res.error}`);
    }
  };

  if (loading) return <AgentDetailSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load agent</AlertTitle>
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

  if (!agent) return null;

  const activeSessions = agent.sessions.filter((s) => s.status === 'active');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="text-sm text-muted-foreground">
            {agent.description ?? 'Agent detail'}
          </p>
        </div>
        {agent.status === 'active' ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setRevokeOpen(true)}
          >
            <Trash2 data-icon="inline-start" />
            Revoke agent
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Agent info card */}
        <Card>
          <CardHeader>
            <CardTitle>Agent info</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              <InfoRow label="ID">
                <code className="font-mono text-xs text-muted-foreground">{agent.id}</code>
              </InfoRow>
              <InfoRow label="Status">
                <StatusBadge status={agent.status} />
              </InfoRow>
              <InfoRow label="Mode">
                <StatusBadge status={agent.mode} />
              </InfoRow>
              <InfoRow label="Default role">
                <code className="font-mono text-xs">{agent.defaultRole}</code>
              </InfoRow>
              {agent.owner ? (
                <InfoRow label="Owner">{agent.owner}</InfoRow>
              ) : null}
              {agent.lastSeenAt ? (
                <InfoRow label="Last seen">
                  {new Date(agent.lastSeenAt).toLocaleString()}
                </InfoRow>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Access (in-place scope editor) */}
        <AgentAccess agentId={agent.id} />

        {/* API keys card */}
        <Card>
          <CardHeader>
            <CardTitle>API keys</CardTitle>
            <CardDescription>
              Keys are shown once at creation. Revoke by revoking the agent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {agent.apiKeys.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No API keys</EmptyTitle>
                  <EmptyDescription>
                    This agent has no active API keys.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Prefix</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agent.apiKeys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="font-mono text-xs">
                        {k.prefix}&hellip;
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(k.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {k.lastUsedAt
                          ? new Date(k.lastUsedAt).toLocaleString()
                          : 'Never'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sessions card */}
      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            {activeSessions.length} active &middot; {agent.sessions.length} total
          </CardDescription>
        </CardHeader>
        <CardContent>
          {agent.sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No sessions yet</EmptyTitle>
                <EmptyDescription>
                  This agent has not opened any sessions.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SID</TableHead>
                  <TableHead>Data Lake</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {agent.sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">
                      {s.sid.slice(0, 8)}&hellip;
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.datalakeId.slice(0, 8)}&hellip;
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(s.startedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(s.expiresAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {s.status === 'active' ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={killingSession === s.id}
                          onClick={() => void killSession(s.id)}
                        >
                          <Zap data-icon="inline-start" />
                          {killingSession === s.id ? 'Killing…' : 'Kill'}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Revoke confirm dialog */}
      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke agent</DialogTitle>
            <DialogDescription>
              This will permanently revoke{' '}
              <span className="font-mono font-medium text-foreground">
                {agent.name}
              </span>{' '}
              and kill all active sessions. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Separator />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeOpen(false)}
              disabled={revoking}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void revokeAgent()}
              disabled={revoking}
            >
              <Trash2 data-icon="inline-start" />
              {revoking ? 'Revoking…' : 'Revoke agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
