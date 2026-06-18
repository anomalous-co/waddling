'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  Badge,
  statusVariant,
  Spinner,
  ErrorState,
  Table,
  Td,
  SectionTitle,
} from '@/components/dashboard/ui';
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
  endpointId: string;
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wider text-neutral-500">{label}</span>
      <span className="text-sm text-neutral-200">{children}</span>
    </div>
  );
}

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;
  if (!session) return null;

  // "run as agent" when a human actor opened a session for an agent.
  const isRunAs = !!session.actor && session.actor !== session.agentId;

  return (
    <div className="space-y-4">
      <SectionTitle>
        Session <span className="font-mono text-blue-300">{session.sid.slice(0, 8)}…</span>
      </SectionTitle>

      <Card>
        <CardHeader title="Session info" />
        <Row label="Session ID">
          <code className="font-mono text-xs text-neutral-300">{session.sid}</code>
        </Row>
        <Row label="Status">
          <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
        </Row>
        <Row label="Source agent">
          <Link href={`/dashboard/agents/${session.agentId}`} className="text-blue-400 hover:underline">
            {session.agentName ?? `${session.agentId.slice(0, 8)}…`}
          </Link>
        </Row>
        <Row label="Owner">{session.owner ?? '—'}</Row>
        {isRunAs && (
          <Row label="Run by">
            <span className="text-yellow-300">{session.actorName ?? session.actor}</span>{' '}
            <span className="text-xs text-neutral-500">(run-as-agent)</span>
          </Row>
        )}
        <Row label="Endpoint">
          <Link
            href={`/dashboard/endpoints/${session.endpointId}`}
            className="text-blue-400 hover:underline"
          >
            {session.endpointName ?? `${session.endpointId.slice(0, 8)}…`}
          </Link>
        </Row>
        <Row label="Started">{new Date(session.startedAt).toLocaleString()}</Row>
        <Row label="Expires">{new Date(session.expiresAt).toLocaleString()}</Row>
      </Card>

      <Card>
        <CardHeader title="Queries" subtitle={`${queries.length} in this session`} />
        {queries.length === 0 ? (
          <p className="text-sm text-neutral-500">No queries run in this session yet.</p>
        ) : (
          <Table headers={['Time', 'Decision', 'Query', 'Reason']}>
            {queries.map((q, i) => (
              <tr key={i}>
                <Td>{new Date(q.ts).toLocaleTimeString()}</Td>
                <Td>
                  {q.decision && (
                    <Badge variant={q.decision === 'allow' ? 'green' : 'yellow'}>{q.decision}</Badge>
                  )}
                </Td>
                <Td mono className="max-w-md truncate">{q.query}</Td>
                <Td className="text-neutral-500">{q.reason ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
