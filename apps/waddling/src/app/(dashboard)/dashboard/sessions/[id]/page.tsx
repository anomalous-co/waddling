'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
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
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';

interface SessionDetail {
  id: string;
  sid: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
  startedAt: string;
  expiresAt: string;
  grantedRoles: string[];
  agentId: string;
  agentName?: string;
  owner?: string;
  datalakeId: string;
  // The route still returns `endpointName` (the gateway name column wasn't
  // renamed alongside datalakeId).
  endpointName?: string;
  actor?: string;
  actorName?: string;
}
interface QueryRow {
  ts: string;
  query: string;
  decision?: 'allow' | 'deny';
  reason?: string;
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetchCp<{ session: SessionDetail; queries: QueryRow[] }>(
      `/api/cp/sessions/${id}`,
    );
    if (res.ok) {
      setSession(res.data.session);
      setQueries(res.data.queries);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn’t load this session</AlertTitle>
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

  if (!session) return null;

  // "run as agent" when a human actor opened a session for an agent.
  const isRunAs = !!session.actor && session.actor !== session.agentId;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Session <span className="font-mono text-primary">{session.sid.slice(0, 8)}…</span>
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Session info</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Session ID">
            <code className="font-mono text-xs text-muted-foreground">
              {session.sid}
            </code>
          </InfoRow>
          <InfoRow label="Status">
            <StatusBadge status={session.status} />
          </InfoRow>
          <InfoRow label="Source agent">
            <Link
              href={`/dashboard/agents/${session.agentId}`}
              className="text-primary hover:underline"
            >
              {session.agentName ?? `${session.agentId.slice(0, 8)}…`}
            </Link>
          </InfoRow>
          <InfoRow label="Owner">{session.owner ?? '—'}</InfoRow>
          {isRunAs ? (
            <InfoRow label="Run by">
              <span className="text-amber-600 dark:text-amber-500">
                {session.actorName ?? session.actor}
              </span>{' '}
              <span className="text-xs text-muted-foreground">
                (run-as-agent)
              </span>
            </InfoRow>
          ) : null}
          <InfoRow label="Data Lake">
            <Link
              href={`/dashboard/datalakes/${session.datalakeId}`}
              className="text-primary hover:underline"
            >
              {session.endpointName ?? `${session.datalakeId.slice(0, 8)}…`}
            </Link>
          </InfoRow>
          <InfoRow label="Roles">
            {session.grantedRoles?.length ? (
              <span className="font-mono text-xs">
                {session.grantedRoles.join(', ')}
              </span>
            ) : (
              '—'
            )}
          </InfoRow>
          <InfoRow label="Started">
            {new Date(session.startedAt).toLocaleString()}
          </InfoRow>
          <InfoRow label="Expires">
            {new Date(session.expiresAt).toLocaleString()}
          </InfoRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Queries</CardTitle>
          <CardDescription>{queries.length} in this session</CardDescription>
        </CardHeader>
        <CardContent>
          {queries.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No queries yet</EmptyTitle>
                <EmptyDescription>
                  This session hasn’t run any queries.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Query</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queries.map((q, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground">
                      {new Date(q.ts).toLocaleTimeString()}
                    </TableCell>
                    <TableCell>
                      {q.decision ? <StatusBadge status={q.decision} /> : null}
                    </TableCell>
                    <TableCell className="max-w-md truncate font-mono text-xs">
                      {q.query}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {q.reason ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
