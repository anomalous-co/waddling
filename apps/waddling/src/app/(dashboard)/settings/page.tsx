'use client';

/**
 * Settings — unified org/account surface in the shared DetailLayout idiom (section
 * sub-rail + h1 header band). This is the production wiring behind the UX-lab design:
 * every section reads a real control-api endpoint (`/api/cp/settings`, `/api/cp/usage`)
 * and the Account + Billing sections reuse the existing, fully-wired subsystem
 * components so no real capability (avatar/password, Stripe upgrade/portal, credit
 * packs, entitlements, invoices) is lost in the restyle.
 */
import { Suspense, useCallback, useEffect, useId, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  Bot,
  Check,
  Copy,
  CreditCard,
  Database,
  KeyRound,
  Loader2,
  Rows3,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { DetailLayout } from '@/components/waddling/detail-layout';
import { SectionCard } from '@/components/waddling/section-card';
import { StatPill } from '@/components/waddling/stat-pill';
import { CopyButton } from '@/components/waddling/copy-button';
import { formatRelative } from '@/components/waddling/agent-status';
import { AccountTab } from '@/components/dashboard/settings/account-tab';
import { BillingTab } from '@/components/dashboard/settings/billing-tab';
import type {
  ApiKeyRow,
  MemberRow,
  OrgInfo,
  SettingsData,
  UsageResponse,
} from './types';

function fmtUsd(usd: number): string {
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ── Role badge ───────────────────────────────────────────────────────────────

const ROLE_CLASS: Record<string, string> = {
  owner: 'border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400',
  admin: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-500',
  member: 'border-transparent bg-muted text-muted-foreground',
};

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge className={cn('font-medium capitalize', ROLE_CLASS[role] ?? ROLE_CLASS.member)}>
      {role}
    </Badge>
  );
}

// ── Invite member dialog (real: POST /api/cp/settings/members) ─────────────────

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
  const emailId = useId();
  const roleId = useId();

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
    if (!res.ok) setError(res.error);
    else setSent(true);
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
            <DialogFooter showCloseButton />
          </>
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={emailId}>Email</FieldLabel>
                <Input
                  id={emailId}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                />
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={roleId}>Role</FieldLabel>
                <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'member')}>
                  <SelectTrigger id={roleId} className="w-full">
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
              <Button onClick={() => void submit()} disabled={loading}>
                {loading ? 'Sending…' : 'Send invite'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Create API key dialog (real: POST /api/cp/agents) ──────────────────────────

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
  const nameId = useId();

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setName('');
      setError(null);
    }
    onOpenChange(v);
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setLoading(true);
    setError(null);
    const res = await cpPost<{ agent: ApiKeyRow; key?: string }>('/api/cp/agents', {
      name,
      description: '',
      defaultRole: 'reader',
    });
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
            <FieldLabel htmlFor={nameId}>Key name / agent name</FieldLabel>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nightly-etl"
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={loading}>
            {loading ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reveal key dialog (show once) ──────────────────────────────────────────────

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
          <code className="flex-1 overflow-x-auto font-mono text-xs break-all">{rawKey}</code>
          <Button variant="ghost" size="icon-sm" onClick={() => void copy()} aria-label="Copy API key">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done — I have copied the key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create org dialog (real: Better Auth organization.create) ──────────────────

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
  const nameId = useId();

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setName('');
      setError(null);
    }
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
            <FieldLabel htmlFor={nameId}>Organization name</FieldLabel>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={loading}>
            {loading ? 'Creating…' : 'Create org'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Organization section ───────────────────────────────────────────────────────

function OrganizationSection({
  org,
  onCreateOrg,
}: {
  org: OrgInfo | null;
  onCreateOrg: () => void;
}) {
  if (!org) return <Skeleton className="h-40 rounded-xl" />;

  const slugUrl = `${org.slug}.getwaddling.com`;

  return (
    <SectionCard
      title="Organization"
      headingLevel={2}
      headerActions={
        <Button variant="outline" size="sm" onClick={onCreateOrg}>
          New org
        </Button>
      }
    >
      <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Name</dt>
          <dd className="font-medium">{org.name}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Workspace URL</dt>
          <dd className="flex items-center gap-1">
            <code className="font-mono text-sm">{slugUrl}</code>
            <CopyButton text={slugUrl} label="Copy workspace URL" size="icon" className="size-6" />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Organization ID</dt>
          <dd className="font-mono text-xs text-muted-foreground">{org.id}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Created</dt>
          <dd className="text-sm">{formatRelative(org.createdAt)}</dd>
        </div>
      </dl>
    </SectionCard>
  );
}

// ── Members section ────────────────────────────────────────────────────────────

function MembersSection({
  members,
  onInvite,
}: {
  members: MemberRow[] | null;
  onInvite: () => void;
}) {
  if (!members) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <SectionCard
      title="Members"
      headingLevel={2}
      contentClassName={members.length === 0 ? undefined : 'p-0'}
      headerActions={
        <Button size="sm" onClick={onInvite}>
          <UserPlus data-icon="inline-start" />
          Invite member
        </Button>
      }
    >
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
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Email</TableHead>
              <TableHead scope="col">Role</TableHead>
              <TableHead scope="col">Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{m.email}</TableCell>
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
    </SectionCard>
  );
}

// ── API keys section ───────────────────────────────────────────────────────────

function ApiKeysSection({
  apiKeys,
  onCreateKey,
  onRevoked,
}: {
  apiKeys: ApiKeyRow[] | null;
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
    const res = await cpDelete<{ ok: boolean }>(`/api/cp/agents/${revoking.agentId}`);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? 'Could not revoke key');
      return;
    }
    toast.success('API key revoked');
    setRevoking(null);
    onRevoked();
  };

  if (!apiKeys) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <>
      <SectionCard
        title="API keys"
        headingLevel={2}
        contentClassName={apiKeys.length === 0 ? undefined : 'p-0'}
        headerActions={
          <Button size="sm" onClick={onCreateKey}>
            <KeyRound data-icon="inline-start" />
            Create key
          </Button>
        }
      >
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
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Prefix</TableHead>
                <TableHead scope="col">Agent ID</TableHead>
                <TableHead scope="col">Created</TableHead>
                <TableHead scope="col">Last used</TableHead>
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>{k.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{k.prefix}…</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {k.agentId ? k.agentId : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(k.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}
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
      </SectionCard>

      <Dialog open={!!revoking} onOpenChange={(o) => { if (!o) setRevoking(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              This immediately revokes the agent
              {revoking ? ` “${revoking.name}”` : ''} and kills its live sessions. The key
              cannot be restored.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void revoke()} disabled={busy}>
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Usage section (real: GET /api/cp/usage?period=7d) ──────────────────────────

function dayLabel(ts: string): string {
  // The bucket timestamp is "YYYY-MM-DD HH:MM:SS+00"; normalise the space to 'T' so
  // it parses as ISO across engines.
  return new Date(ts.replace(' ', 'T')).toLocaleDateString(undefined, { weekday: 'short' });
}

function UsageSection({ usage }: { usage: UsageResponse | null }) {
  if (!usage) return <Skeleton className="h-64 rounded-xl" />;

  const maxQueries = Math.max(...usage.series.map((d) => d.queries), 1);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatPill label="Queries (7d)" value={usage.rollup.queries.toLocaleString()} icon={<Database />} />
        <StatPill label="Active sessions" value={String(usage.rollup.activeSessions)} icon={<Bot />} />
        <StatPill label="Rows scanned (7d)" value={usage.rollup.rowsScanned.toLocaleString()} icon={<Rows3 />} />
        <StatPill label="Credit balance" value={fmtUsd(usage.credit.balanceUsd)} icon={<CreditCard />} />
      </div>

      <SectionCard title="Queries per day" headingLevel={2}>
        <div className="flex flex-col gap-4">
          {/* Decorative bar chart — px heights against the fixed 112px track so they
              don't collapse without a definite-height parent. The table below is the
              accessible source of truth. */}
          <div className="flex h-32 items-end gap-2" aria-hidden="true">
            {usage.series.map((d) => (
              <div key={d.ts} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${Math.max(4, (d.queries / maxQueries) * 112)}px` }}
                />
                <span className="text-[10px] text-muted-foreground">{dayLabel(d.ts)}</span>
              </div>
            ))}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Day</TableHead>
                <TableHead scope="col" className="text-right">Queries</TableHead>
                <TableHead scope="col" className="text-right">Sessions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.series.map((d) => (
                <TableRow key={d.ts}>
                  <TableCell>{dayLabel(d.ts)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.queries.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.sessions.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Settings page ──────────────────────────────────────────────────────────────

function SettingsLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Couldn&apos;t load settings</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        {error}
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function SettingsInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  // Back-compat: the old settings page drove its tabs with `?tab=`, and inbound
  // deep-links still use it — notably the Stripe checkout/top-up return URLs
  // (`/settings?tab=billing`) which must land on the Billing section so its
  // `?topup=success` handler fires. DetailLayout reads `?section=`; remap once.
  // The legacy tab ids are all valid section ids, so this is a clean rename.
  const tabParam = searchParams.get('tab');
  useEffect(() => {
    if (tabParam && !searchParams.get('section')) {
      const p = new URLSearchParams(searchParams.toString());
      p.delete('tab');
      p.set('section', tabParam);
      router.replace(`?${p.toString()}`, { scroll: false });
    }
  }, [tabParam, searchParams, router]);

  // Dialogs mounted at the page root so they survive section switches.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(searchParams.get('create') === 'org');
  const [revealKey, setRevealKey] = useState<{ name: string; key: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<SettingsData>('/api/cp/settings');
    if (!res.ok) setError(res.error);
    else {
      setData(res.data);
      setError(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<UsageResponse>('/api/cp/usage?period=7d').then((res) => {
      if (!cancelled && res.ok) setUsage(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleKeyCreated = (apiKey: ApiKeyRow, rawKey: string) => {
    setData((prev) => (prev ? { ...prev, apiKeys: [...prev.apiKeys, apiKey] } : prev));
    if (rawKey) setRevealKey({ name: apiKey.name, key: rawKey });
  };

  if (error) {
    return <SettingsLoadError error={error} onRetry={() => void load()} />;
  }

  const sections = [
    { id: 'account', label: 'Account', content: <AccountTab /> },
    {
      id: 'organization',
      label: 'Organization',
      content: (
        <OrganizationSection org={data?.org ?? null} onCreateOrg={() => setCreateOrgOpen(true)} />
      ),
    },
    {
      id: 'members',
      label: 'Members',
      badge: data?.members.length,
      content: (
        <MembersSection members={data?.members ?? null} onInvite={() => setInviteOpen(true)} />
      ),
    },
    {
      id: 'api-keys',
      label: 'API keys',
      badge: data?.apiKeys.length,
      content: (
        <ApiKeysSection
          apiKeys={data?.apiKeys ?? null}
          onCreateKey={() => setCreateKeyOpen(true)}
          onRevoked={() => void load()}
        />
      ),
    },
    { id: 'usage', label: 'Usage', content: <UsageSection usage={usage} /> },
    { id: 'billing', label: 'Billing', content: <BillingTab /> },
  ];

  return (
    <>
      <DetailLayout
        title="Settings"
        meta={
          <span className="text-sm text-muted-foreground">
            {data ? data.org.name : 'Manage your account, organization, members, API keys, and billing.'}
          </span>
        }
        sections={sections}
        defaultSection="account"
      />

      {/* Dialogs mounted at root — survive section switches */}
      {data ? (
        <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} orgId={data.org.id} />
      ) : null}
      <CreateApiKeyDialog
        open={createKeyOpen}
        onOpenChange={setCreateKeyOpen}
        onCreated={handleKeyCreated}
      />
      <CreateOrgDialog open={createOrgOpen} onOpenChange={setCreateOrgOpen} />
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

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <SettingsInner />
    </Suspense>
  );
}
