'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Card,
  CardHeader,
  Badge,
  statusVariant,
  Button,
  Spinner,
  ErrorState,
  SectionTitle,
  Table,
  Td,
  Modal,
} from '@/components/dashboard/ui';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
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

function RevokeAgentModal({
  open,
  onClose,
  agentName,
  onConfirm,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  agentName: string;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <Modal title="Revoke agent" open={open} onClose={onClose}>
      <p className="text-sm text-neutral-300 mb-4">
        Revoke <span className="font-mono text-red-300">{agentName}</span>?
        This will instantly deny all future queries from this agent and kill
        any active sessions.
      </p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          onClick={onConfirm}
          loading={loading}
        >
          Revoke agent
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
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

  const load = useCallback(async () => {
    const res = await fetchCp<{ agent: AgentDetail }>(
      `/api/cp/agents/${params.id}`,
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      setAgent(res.data.agent);
    }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const killSession = async (sessionId: string) => {
    const res = await cpPost<{ ok: boolean }>(
      `/api/cp/sessions/${sessionId}/kill`,
      { reason: 'Manually killed from dashboard' },
    );
    if (res.ok) {
      setAgent((prev) =>
        prev
          ? {
              ...prev,
              sessions: prev.sessions.map((s) =>
                s.id === sessionId ? { ...s, status: 'killed' as const } : s,
              ),
            }
          : prev,
      );
    }
  };

  const revokeAgent = async () => {
    if (!agent) return;
    setRevoking(true);
    const res = await cpPost<{ ok: boolean }>(
      `/api/cp/agents/${agent.id}/revoke`,
      { reason: 'Revoked from dashboard' },
    );
    setRevoking(false);
    if (res.ok) {
      setRevokeOpen(false);
      router.push('/dashboard/agents');
    }
  };

  if (loading)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;
  if (!agent) return null;

  const activeSessions = agent.sessions.filter((s) => s.status === 'active');

  return (
    <div className="space-y-4">
      <SectionTitle>
        Agent: <span className="font-mono text-blue-300">{agent.name}</span>
      </SectionTitle>

      {/* Meta + revoke */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Agent info" />
          <div className="space-y-2">
            <Row label="ID">
              <code className="font-mono text-xs text-neutral-300">{agent.id}</code>
            </Row>
            <Row label="Status">
              <Badge variant={statusVariant(agent.status)}>{agent.status}</Badge>
            </Row>
            <Row label="Default role">
              <code className="font-mono text-xs">{agent.defaultRole}</code>
            </Row>
            {agent.description && (
              <Row label="Description">{agent.description}</Row>
            )}
            {agent.lastSeenAt && (
              <Row label="Last seen">
                {new Date(agent.lastSeenAt).toLocaleString()}
              </Row>
            )}
          </div>
          {agent.status === 'active' && (
            <div className="mt-4">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setRevokeOpen(true)}
              >
                Revoke agent
              </Button>
            </div>
          )}
        </Card>

        {/* API keys */}
        <Card>
          <CardHeader
            title="API keys"
            subtitle="Keys are shown once at creation. Revoke by deleting."
          />
          {agent.apiKeys.length === 0 ? (
            <p className="text-sm text-neutral-500">No keys.</p>
          ) : (
            <Table headers={['Prefix', 'Created', 'Expires', 'Last used']}>
              {agent.apiKeys.map((k) => (
                <tr key={k.id}>
                  <Td mono>{k.prefix}…</Td>
                  <Td>{new Date(k.createdAt).toLocaleDateString()}</Td>
                  <Td>
                    {k.expiresAt
                      ? new Date(k.expiresAt).toLocaleDateString()
                      : '—'}
                  </Td>
                  <Td>
                    {k.lastUsedAt
                      ? new Date(k.lastUsedAt).toLocaleString()
                      : 'Never'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* Sessions */}
      <Card>
        <CardHeader
          title="Sessions"
          subtitle={`${activeSessions.length} active`}
        />
        {agent.sessions.length === 0 ? (
          <p className="text-sm text-neutral-500">No sessions yet.</p>
        ) : (
          <Table headers={['SID', 'Endpoint', 'Status', 'Started', 'Expires', '']}>
            {agent.sessions.map((s) => (
              <tr key={s.id}>
                <Td mono>{s.sid}</Td>
                <Td mono>{s.endpointId}</Td>
                <Td>
                  <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                </Td>
                <Td>{new Date(s.startedAt).toLocaleString()}</Td>
                <Td>{new Date(s.expiresAt).toLocaleString()}</Td>
                <Td>
                  {s.status === 'active' && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void killSession(s.id)}
                    >
                      Kill
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <RevokeAgentModal
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        agentName={agent.name}
        onConfirm={() => void revokeAgent()}
        loading={revoking}
      />
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm text-neutral-300">{children}</span>
    </div>
  );
}
