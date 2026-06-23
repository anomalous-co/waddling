'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  RefreshCw,
  UserPlus,
  KeyRound,
  Copy,
  Check,
  Trash2,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import { AccountTab } from '@/components/dashboard/settings/account-tab';
import { BillingTab } from '@/components/dashboard/settings/billing-tab';
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
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import { Field, FieldLabel, FieldGroup, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

// ── Local types (mirrors the /api/cp/settings contract) ───────────────────────

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

// ── Role badge ─────────────────────────────────────────────────────────────────

const ROLE_CLASS: Record<string, string> = {
  owner:
    'border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400',
  admin:
    'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-500',
  member:
    'border-transparent bg-muted text-muted-foreground',
};

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge className={cn('font-medium capitalize', ROLE_CLASS[role] ?? ROLE_CLASS.member)}>
      {role}
    </Badge>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ── Invite member dialog ───────────────────────────────────────────────────────

function InviteMemberDialog({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: string;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const reset = () => {
    setEmail('');
    setRole('member');
    setError(null);
    setSent(false);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
        </DialogHeader>
        {sent ? (
          <>
            <p className="text-sm text-muted-foreground">
              Invitation sent to <strong className="text-foreground">{email}</strong>.
            </p>
            <DialogFooter showCloseButton>
            </DialogFooter>
          </>
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="inv-email">Email</FieldLabel>
                <Input
                  id="inv-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                />
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-role">Role</FieldLabel>
                <Select
                  value={role}
                  onValueChange={(v) => setRole(v as 'admin' | 'member')}
                >
                  <SelectTrigger id="inv-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                variant="default"
                onClick={() => void submit()}
                disabled={loading}
              >
                {loading ? 'Sending…' : 'Send invite'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Create API key dialog ──────────────────────────────────────────────────────

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (key: ApiKeyRow, rawKey: string) => void;
}) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setError(null);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
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
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="key-name">Key name / agent name</FieldLabel>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nightly-etl"
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="default"
            onClick={() => void submit()}
            disabled={loading}
          >
            {loading ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reveal key dialog (show once) ─────────────────────────────────────────────

function RevealKeyDialog({
  open,
  onOpenChange,
  keyName,
  rawKey,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  keyName: string;
  rawKey: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key — copy now</DialogTitle>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertTitle>This key is shown exactly once</AlertTitle>
          <AlertDescription>
            It cannot be retrieved again after closing this dialog.
          </AlertDescription>
        </Alert>
        <p className="text-xs text-muted-foreground">
          Key: <span className="text-foreground">{keyName}</span>
        </p>
        <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2">
          <code className="flex-1 overflow-x-auto font-mono text-xs break-all">
            {rawKey}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void copy()}
            aria-label="Copy API key"
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
        </div>
        <DialogFooter>
          <Button variant="default" onClick={() => onOpenChange(false)}>
            Done — I have copied the key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create org dialog ──────────────────────────────────────────────────────────

function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setError(null);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
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
    handleOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="default"
            onClick={() => void submit()}
            disabled={loading}
          >
            {loading ? 'Creating…' : 'Create org'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Organization tab ───────────────────────────────────────────────────────────

function OrgRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function OrganizationTab({
  org,
  onCreateOrg,
}: {
  org: OrgInfo;
  onCreateOrg: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>Your active organization details.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onCreateOrg}>
            <span>New org</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col">
          <OrgRow label="Name">{org.name}</OrgRow>
          <Separator />
          <OrgRow label="Slug">
            <code className="font-mono text-xs text-muted-foreground">
              {org.slug}
            </code>
          </OrgRow>
          <Separator />
          <OrgRow label="ID">
            <code className="font-mono text-xs text-muted-foreground">
              {org.id}
            </code>
          </OrgRow>
          <Separator />
          <OrgRow label="Created">
            {new Date(org.createdAt).toLocaleDateString()}
          </OrgRow>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Members tab ────────────────────────────────────────────────────────────────

function MembersTab({
  members,
  onInvite,
}: {
  members: MemberRow[];
  onInvite: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>{members.length} member{members.length === 1 ? '' : 's'}</CardDescription>
        <CardAction>
          <Button size="sm" onClick={onInvite}>
            <UserPlus data-icon="inline-start" />
            Invite member
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No members yet</EmptyTitle>
              <EmptyDescription>
                Invite a team member to collaborate on this organization.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {m.email}
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={m.role} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(m.joinedAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── API keys tab ───────────────────────────────────────────────────────────────

function ApiKeysTab({
  apiKeys,
  onCreateKey,
  onRevoked,
}: {
  apiKeys: ApiKeyRow[];
  onCreateKey: () => void;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!revoking?.agentId) return;
    setBusy(true);
    // Each key is 1:1 with an agent; revoking the agent revokes the key on the
    // gateway (birdshot denylist) and kills its live sessions.
    const res = await cpDelete<{ ok: boolean }>(
      `/api/cp/agents/${revoking.agentId}`,
    );
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? 'Could not revoke key');
      return;
    }
    toast.success('API key revoked');
    setRevoking(null);
    onRevoked();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Agent API keys for programmatic access via MCP.</CardDescription>
        <CardAction>
          <Button size="sm" onClick={onCreateKey}>
            <KeyRound data-icon="inline-start" />
            Create key
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {apiKeys.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No API keys yet</EmptyTitle>
              <EmptyDescription>
                Create an API key to grant an agent programmatic access.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Agent ID</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>{k.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {k.prefix}…
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {k.agentId ? k.agentId : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(k.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {k.lastUsedAt
                      ? new Date(k.lastUsedAt).toLocaleString()
                      : 'Never'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setRevoking(k)}
                      disabled={!k.agentId}
                    >
                      <Trash2 data-icon="inline-start" />
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog
        open={!!revoking}
        onOpenChange={(o) => {
          if (!o) setRevoking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              This immediately revokes the agent
              {revoking ? ` “${revoking.name}”` : ''} and kills its live
              sessions. The key cannot be restored.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevoking(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void revoke()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Root export ────────────────────────────────────────────────────────────────

const SETTINGS_TABS = ['account', 'organization', 'members', 'api-keys', 'billing'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

export function SettingsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // The active tab is driven by ?tab= so it's deep-linkable + shareable.
  const tabParam = searchParams.get('tab');
  const activeTab: SettingsTab = (SETTINGS_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as SettingsTab)
    : 'account';
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog open states — all at root so they survive tab switches
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(
    searchParams.get('create') === 'org',
  );
  const [revealKey, setRevealKey] = useState<{ name: string; key: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    const res = await fetchCp<SettingsData>('/api/cp/settings');
    if (!res.ok) {
      setError(res.error);
    } else {
      setData(res.data);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SettingsSkeleton />;

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load settings</AlertTitle>
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
  }

  if (!data) return null;

  const handleKeyCreated = (apiKey: ApiKeyRow, rawKey: string) => {
    setData((prev) =>
      prev ? { ...prev, apiKeys: [...prev.apiKeys, apiKey] } : prev,
    );
    if (rawKey) setRevealKey({ name: apiKey.name, key: rawKey });
  };

  return (
    <>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your account, organization, members, API keys, and billing.
          </p>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(v) => router.replace(`/settings?tab=${v}`)}
        >
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="organization">Organization</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="api-keys">API keys</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
          </TabsList>

          <TabsContent value="account" className="mt-4">
            <AccountTab />
          </TabsContent>

          <TabsContent value="organization" className="mt-4">
            <OrganizationTab
              org={data.org}
              onCreateOrg={() => setCreateOrgOpen(true)}
            />
          </TabsContent>

          <TabsContent value="members" className="mt-4">
            <MembersTab
              members={data.members}
              onInvite={() => setInviteOpen(true)}
            />
          </TabsContent>

          <TabsContent value="api-keys" className="mt-4">
            <ApiKeysTab
              apiKeys={data.apiKeys}
              onCreateKey={() => setCreateKeyOpen(true)}
              onRevoked={() => void load()}
            />
          </TabsContent>

          <TabsContent value="billing" className="mt-4">
            <BillingTab />
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs mounted at root — survive tab switches */}
      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        orgId={data.org.id}
      />
      <CreateApiKeyDialog
        open={createKeyOpen}
        onOpenChange={setCreateKeyOpen}
        onCreated={handleKeyCreated}
      />
      <CreateOrgDialog
        open={createOrgOpen}
        onOpenChange={setCreateOrgOpen}
      />
      {revealKey ? (
        <RevealKeyDialog
          open
          onOpenChange={(v) => { if (!v) setRevealKey(null); }}
          keyName={revealKey.name}
          rawKey={revealKey.key}
        />
      ) : null}
    </>
  );
}
