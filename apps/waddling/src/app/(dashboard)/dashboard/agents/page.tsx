'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  Badge,
  statusVariant,
  Button,
  Spinner,
  ErrorState,
  EmptyState,
  SectionTitle,
  Table,
  Td,
  Modal,
  CodeBlock,
  Input,
  Label,
} from '@/components/dashboard/ui';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type { AgentSummary } from '@/lib/types';

interface CreateAgentForm {
  name: string;
  description: string;
  defaultRole: string;
}

function CreateAgentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: AgentSummary, key: string) => void;
}) {
  const [form, setForm] = useState<CreateAgentForm>({
    name: '',
    description: '',
    defaultRole: 'reader',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setLoading(true);
    setError(null);
    const res = await cpPost<{ agent: AgentSummary; key?: string }>(
      '/api/cp/agents',
      form,
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onCreated(res.data.agent, res.data.key ?? '');
    onClose();
  };

  return (
    <Modal title="Create agent" open={open} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="a-name">Name</Label>
          <Input
            id="a-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="llm-analyst"
          />
        </div>
        <div>
          <Label htmlFor="a-desc">Description</Label>
          <Input
            id="a-desc"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
          />
        </div>
        <div>
          <Label htmlFor="a-role">Default role</Label>
          <Input
            id="a-role"
            value={form.defaultRole}
            onChange={(e) => setForm({ ...form, defaultRole: e.target.value })}
            placeholder="reader"
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button variant="primary" onClick={() => void submit()} loading={loading}>
            Create
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RevealKeyModal({
  open,
  onClose,
  agentName,
  apiKey,
}: {
  open: boolean;
  onClose: () => void;
  agentName: string;
  apiKey: string;
}) {
  return (
    <Modal title="API key created — copy now" open={open} onClose={onClose}>
      <p className="text-xs text-yellow-300 mb-3">
        This key is shown exactly once. Copy it now — it cannot be retrieved
        again.
      </p>
      <p className="text-xs text-neutral-500 mb-1">
        Agent: <span className="text-neutral-300">{agentName}</span>
      </p>
      <CodeBlock code={apiKey} />
      <div className="mt-4">
        <Button variant="primary" onClick={onClose}>
          Done — I have copied the key
        </Button>
      </div>
    </Modal>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealKey, setRevealKey] = useState<{
    name: string;
    key: string;
  } | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents');
    if (!res.ok) {
      setError(res.error);
    } else {
      setAgents(res.data.agents);
    }
    setLoading(false);
  }, []);

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

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            + New agent
          </Button>
        }
      >
        Agents
      </SectionTitle>

      <Card>
        <CardHeader
          title="Machine principals"
          subtitle="Agents authenticate via API keys and receive governed access to endpoints."
        />
        {agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                Create first agent
              </Button>
            }
          />
        ) : (
          <Table headers={['Name', 'Default role', 'Status', 'Last seen', '']}>
            {agents.map((a) => (
              <tr key={a.id}>
                <Td>
                  <Link
                    href={`/dashboard/agents/${a.id}`}
                    className="text-blue-400 hover:underline"
                  >
                    {a.name}
                  </Link>
                </Td>
                <Td mono>{a.defaultRole}</Td>
                <Td>
                  <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                </Td>
                <Td>
                  {a.lastSeenAt
                    ? new Date(a.lastSeenAt).toLocaleString()
                    : '—'}
                </Td>
                <Td>
                  <Link
                    href={`/dashboard/agents/${a.id}`}
                    className="text-xs text-neutral-500 hover:text-neutral-300"
                  >
                    Details →
                  </Link>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <CreateAgentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(agent, key) => {
          setAgents((prev) => [...prev, agent]);
          if (key) setRevealKey({ name: agent.name, key });
        }}
      />

      {revealKey && (
        <RevealKeyModal
          open={!!revealKey}
          onClose={() => setRevealKey(null)}
          agentName={revealKey.name}
          apiKey={revealKey.key}
        />
      )}
    </div>
  );
}
