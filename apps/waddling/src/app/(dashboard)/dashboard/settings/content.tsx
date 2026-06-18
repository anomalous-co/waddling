'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Card,
  CardHeader,
  Badge,
  Button,
  Spinner,
  ErrorState,
  SectionTitle,
  Table,
  Td,
  Input,
  Label,
  Modal,
  CodeBlock,
} from '@/components/dashboard/ui';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { authClient } from '@/lib/auth-client';

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  agentId?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

interface SettingsData {
  org: OrgInfo;
  members: MemberRow[];
  apiKeys: ApiKeyRow[];
}

function InviteMemberModal({
  open,
  onClose,
  orgId,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    setLoading(true);
    setError(null);
    const res = await cpPost<{ ok: boolean }>('/api/cp/settings/members', {
      email,
      role,
      orgId,
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
    } else {
      setSent(true);
    }
  };

  return (
    <Modal title="Invite member" open={open} onClose={onClose}>
      {sent ? (
        <div className="space-y-3">
          <p className="text-sm text-green-300">
            Invitation sent to <strong>{email}</strong>.
          </p>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <Label htmlFor="inv-email">Email</Label>
            <Input
              id="inv-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div>
            <Label htmlFor="inv-role">Role</Label>
            <select
              id="inv-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
              className="block w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={loading}
            >
              Send invite
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateApiKeyModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (key: ApiKeyRow, rawKey: string) => void;
}) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Name required');
      return;
    }
    setLoading(true);
    setError(null);
    const res = await cpPost<{ agent: ApiKeyRow; key?: string }>(
      '/api/cp/agents',
      { name, description: '', defaultRole: 'reader' },
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onCreated(res.data.agent as unknown as ApiKeyRow, res.data.key ?? '');
    onClose();
  };

  return (
    <Modal title="Create API key" open={open} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="key-name">Key name / agent name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="nightly-etl"
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={loading}
          >
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
  keyName,
  rawKey,
}: {
  open: boolean;
  onClose: () => void;
  keyName: string;
  rawKey: string;
}) {
  return (
    <Modal title="API key — copy now" open={open} onClose={onClose}>
      <p className="text-xs text-yellow-300 mb-3">
        This key is shown exactly once and cannot be retrieved again.
      </p>
      <p className="text-xs text-neutral-500 mb-1">
        Key: <span className="text-neutral-300">{keyName}</span>
      </p>
      <CodeBlock code={rawKey} />
      <div className="mt-4">
        <Button variant="primary" onClick={onClose}>
          Done — I have copied the key
        </Button>
      </div>
    </Modal>
  );
}

function CreateOrgModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Name required');
      return;
    }
    setLoading(true);
    setError(null);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await authClient.organization.create({ name, slug });
    setLoading(false);
    if (res.error) {
      setError(res.error.message ?? 'Failed to create org');
      return;
    }
    onClose();
    router.refresh();
  };

  return (
    <Modal title="Create organization" open={open} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="org-name">Organization name</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={loading}
          >
            Create org
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function SettingsContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(
    searchParams.get('create') === 'org',
  );
  const [revealKey, setRevealKey] = useState<{
    name: string;
    key: string;
  } | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<SettingsData>('/api/cp/settings');
    if (!res.ok) {
      setError(res.error);
    } else {
      setData(res.data);
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
  if (!data) return null;

  return (
    <div className="space-y-6">
      <SectionTitle>Settings</SectionTitle>

      {/* Org info */}
      <Card>
        <CardHeader
          title="Organization"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateOrgOpen(true)}
            >
              + New org
            </Button>
          }
        />
        <div className="space-y-2">
          <Row label="Name">{data.org.name}</Row>
          <Row label="Slug">
            <code className="font-mono text-xs text-neutral-300">{data.org.slug}</code>
          </Row>
          <Row label="ID">
            <code className="font-mono text-xs text-neutral-400">{data.org.id}</code>
          </Row>
          <Row label="Created">
            {new Date(data.org.createdAt).toLocaleDateString()}
          </Row>
        </div>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader
          title="Members"
          subtitle={`${data.members.length} members`}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setInviteOpen(true)}
            >
              Invite member
            </Button>
          }
        />
        <Table headers={['Name', 'Email', 'Role', 'Joined']}>
          {data.members.map((m) => (
            <tr key={m.id}>
              <Td>{m.name}</Td>
              <Td mono>{m.email}</Td>
              <Td>
                <Badge
                  variant={
                    m.role === 'owner'
                      ? 'blue'
                      : m.role === 'admin'
                        ? 'yellow'
                        : 'neutral'
                  }
                >
                  {m.role}
                </Badge>
              </Td>
              <Td>{new Date(m.joinedAt).toLocaleDateString()}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      {/* API Keys */}
      <Card>
        <CardHeader
          title="API keys"
          subtitle="Agent API keys for programmatic access via MCP."
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateKeyOpen(true)}
            >
              + Create key
            </Button>
          }
        />
        {data.apiKeys.length === 0 ? (
          <p className="text-sm text-neutral-500">No API keys yet.</p>
        ) : (
          <Table headers={['Name', 'Prefix', 'Created', 'Expires', 'Last used']}>
            {data.apiKeys.map((k) => (
              <tr key={k.id}>
                <Td>{k.name}</Td>
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

      {/* Modals */}
      <InviteMemberModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        orgId={data.org.id}
      />
      <CreateApiKeyModal
        open={createKeyOpen}
        onClose={() => setCreateKeyOpen(false)}
        onCreated={(apiKey, rawKey) => {
          setData((prev) =>
            prev ? { ...prev, apiKeys: [...prev.apiKeys, apiKey] } : prev,
          );
          if (rawKey) setRevealKey({ name: apiKey.name, key: rawKey });
        }}
      />
      <CreateOrgModal
        open={createOrgOpen}
        onClose={() => setCreateOrgOpen(false)}
      />
      {revealKey && (
        <RevealKeyModal
          open={!!revealKey}
          onClose={() => setRevealKey(null)}
          keyName={revealKey.name}
          rawKey={revealKey.key}
        />
      )}
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
