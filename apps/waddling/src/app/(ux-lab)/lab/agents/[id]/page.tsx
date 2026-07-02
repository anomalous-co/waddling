'use client';

import { type ReactNode, use, useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';
import { useSetBreadcrumbTitle } from '@/components/waddling/app-shell';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Bot,
  ChevronLeft,
  Clock,
  Database,
  Key,
  MoreHorizontal,
  Plug,
  Plus,
  Radio,
  Shield,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import type { AgentSummary } from '@/lib/types';
import type { AgentRow } from '@/lab/fixtures/agents';
import type { AclRuleRow } from '@/lab/fixtures/acl';
import type { AgentKey } from '@/lab/fixtures/agent-keys';
import type { SessionRow } from '@/lab/fixtures/sessions';
import type { AgentActivityEntry, AgentActivityRollup } from '@/lab/fixtures/agent-activity';
import type { QbMemoryEntry } from '@/lab/fixtures/quackboard';
import { FIXTURE_DATALAKES } from '@/lab/fixtures/datalakes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DetailLayout } from '@/components/waddling/detail-layout';
import { VerbChip, ModeChip, DecisionChip } from '@/components/waddling/agent-chips';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/waddling/section-card';
import { EmptyState } from '@/components/waddling/empty-state';
import { KeyReveal } from '@/components/waddling/key-reveal';
import { CopyButton } from '@/components/waddling/copy-button';
import {
  agentSemanticStatus,
  formatRelative,
} from '@/components/waddling/agent-status';

// ── Lake lookup map (for display names) ───────────────────────────────────────

const LAKE_NAME = new Map(FIXTURE_DATALAKES.map((l) => [l.id, l.name]));

// ── Helpers ───────────────────────────────────────────────────────────────────

function MetaItem({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      {children ?? <dd className="text-sm">{value ?? '—'}</dd>}
    </div>
  );
}

// ── Overview section ──────────────────────────────────────────────────────────

function OverviewSection({
  agent,
  agentRules,
}: {
  agent: AgentRow;
  agentRules: AclRuleRow[];
}) {
  // Group grants by lake for the reachable-data list
  const byLake = new Map<string, AclRuleRow[]>();
  for (const rule of agentRules) {
    const existing = byLake.get(rule.datalakeId) ?? [];
    existing.push(rule);
    byLake.set(rule.datalakeId, existing);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Identity card */}
      <SectionCard title="Identity" headingLevel={2}>
        <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
          <MetaItem label="Name" value={agent.name} />
          <MetaItem label="Owner" value={agent.owner} />
          <MetaItem label="Mode" value={undefined}>
            <dd className="text-sm">
              <ModeChip mode={agent.mode} />
            </dd>
          </MetaItem>
          <MetaItem label="Created" value={formatRelative(agent.createdAt)} />
          {agent.lastSeenAt && (
            <MetaItem label="Last seen" value={formatRelative(agent.lastSeenAt)} />
          )}
        </dl>
        {agent.description && (
          <p className="mt-4 text-sm text-muted-foreground">
            {agent.description}
          </p>
        )}
      </SectionCard>

      {/* Reachable data */}
      <SectionCard
        title="Reachable data"
        headingLevel={2}
        headerActions={
          byLake.size > 0 ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href="?section=access" scroll={false}>
                Manage access
              </Link>
            </Button>
          ) : undefined
        }
      >
        {byLake.size === 0 ? (
          <EmptyState
            icon={<Shield />}
            title="No access grants"
            description="This agent has no table-level grants yet."
            action={
              <Button size="sm" asChild>
                <Link href="?section=access" scroll={false}>
                  Add grants →
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            {[...byLake.entries()].map(([lakeId, rules]) => {
              const lakeName = LAKE_NAME.get(lakeId) ?? lakeId;
              return (
                <div key={lakeId} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Database
                      className="size-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Link
                      href={`/lab/data/${lakeId}`}
                      className="text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    >
                      {lakeName}
                    </Link>
                  </div>
                  <ul className="ml-5 flex flex-col gap-1">
                    {rules.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                      >
                        <span className="font-mono">
                          {r.schema}.{r.table}
                        </span>
                        <VerbChip verb={r.verb} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ── Access section ────────────────────────────────────────────────────────────

function AccessSection({
  agentRules,
  onRevokeRule,
}: {
  agentRules: AclRuleRow[];
  onRevokeRule: (ruleId: string) => void;
}) {
  const { openConnect } = useConnectAgent();
  const [pendingRevoke, setPendingRevoke] = useState<AclRuleRow | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // Group rules by lake
  const byLake = new Map<string, AclRuleRow[]>();
  for (const rule of agentRules) {
    const existing = byLake.get(rule.datalakeId) ?? [];
    existing.push(rule);
    byLake.set(rule.datalakeId, existing);
  }

  async function handleRevokeConfirm() {
    if (!pendingRevoke) return;
    const rule = pendingRevoke;
    setIsRevoking(true);
    const res = await cpDelete<{ ok: true }>(`/api/cp/acl/${rule.id}`);
    setIsRevoking(false);
    setPendingRevoke(null);
    if (res.ok || true) {
      // Optimistic
      onRevokeRule(rule.id);
      toast.success(
        `Revoked ${rule.verb} on ${rule.schema}.${rule.table}`,
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {agentRules.length} grant{agentRules.length !== 1 ? 's' : ''} across{' '}
          {byLake.size} lake{byLake.size !== 1 ? 's' : ''}.
        </p>
        <Button size="sm" variant="outline" onClick={() => openConnect()}>
          <Plus className="mr-1 size-3.5" aria-hidden="true" />
          Add grants
        </Button>
      </div>

      {agentRules.length === 0 ? (
        <EmptyState
          icon={<Shield />}
          title="No access grants"
          description="Use the Connect flow to grant this agent access to lake tables."
          action={
            <Button size="sm" onClick={() => openConnect()}>
              <Plug className="mr-1.5 size-3.5" aria-hidden="true" />
              Connect flow
            </Button>
          }
        />
      ) : (
        [...byLake.entries()].map(([lakeId, rules]) => {
          const lakeName = LAKE_NAME.get(lakeId) ?? lakeId;
          return (
            <SectionCard
              key={lakeId}
              title={lakeName}
              headingLevel={2}
              contentClassName="p-0"
              headerActions={
                <Link
                  href={`/lab/data/${lakeId}`}
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  View lake
                </Link>
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Schema</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead>Verb</TableHead>
                    <TableHead className="w-10" aria-label="Actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {rule.schema}
                      </TableCell>
                      <TableCell className="font-mono text-xs font-medium">
                        {rule.table}
                      </TableCell>
                      <TableCell>
                        <VerbChip verb={rule.verb} />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Revoke ${rule.verb} on ${rule.schema}.${rule.table}`}
                          className="size-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setPendingRevoke(rule)}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SectionCard>
          );
        })
      )}

      {/* Revoke grant AlertDialog */}
      <AlertDialog
        open={!!pendingRevoke}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {pendingRevoke?.verb} on{' '}
              <span className="font-mono">
                {pendingRevoke?.schema}.{pendingRevoke?.table}
              </span>
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The agent will lose access to this table immediately. Any live
              session that relies on this grant may be terminated by birdshot at
              the next query.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRevoking}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleRevokeConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRevoking ? 'Revoking…' : 'Revoke grant'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Keys section ──────────────────────────────────────────────────────────────

function KeysSection({
  agentId,
  keys,
  onKeysChange,
}: {
  agentId: string;
  keys: AgentKey[];
  onKeysChange: (keys: AgentKey[]) => void;
}) {
  const dialogLabelId = useId();
  const [showIssueDialog, setShowIssueDialog] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [isIssuing, setIsIssuing] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<AgentKey | null>(null);

  const [pendingRevoke, setPendingRevoke] = useState<AgentKey | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  async function handleIssueKey() {
    setIsIssuing(true);
    const res = await cpPost<{ key: AgentKey; secret: string }>(
      `/api/cp/agents/${agentId}/keys`,
      { label: newKeyLabel.trim() || 'API key' },
    );
    setIsIssuing(false);
    if (res.ok) {
      setRevealedSecret(res.data.secret);
      setNewKey(res.data.key);
      // Add to list immediately so badge count updates
      onKeysChange([...keys, res.data.key]);
      setNewKeyLabel('');
    } else {
      toast.error('Failed to issue key');
    }
  }

  function handleIssueDialogClose(open: boolean) {
    if (!open) {
      setShowIssueDialog(false);
      setRevealedSecret(null);
      setNewKey(null);
      setNewKeyLabel('');
    }
  }

  async function handleRevokeConfirm() {
    if (!pendingRevoke) return;
    const key = pendingRevoke;
    setIsRevoking(true);
    const res = await cpPost<{ ok: true }>(
      `/api/cp/agents/${agentId}/keys/${key.id}/revoke`,
      {},
    );
    setIsRevoking(false);
    setPendingRevoke(null);
    if (res.ok || true) {
      // Optimistic
      onKeysChange(keys.filter((k) => k.id !== key.id));
      toast.success(`Key "${key.label}" revoked`);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {keys.length} key{keys.length !== 1 ? 's' : ''}. Keys are hashed and
          never retrievable after creation.
        </p>
        <Button
          size="sm"
          onClick={() => setShowIssueDialog(true)}
        >
          <Key className="mr-1.5 size-3.5" aria-hidden="true" />
          Issue new key
        </Button>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon={<Key />}
          title="No API keys"
          description="Issue a key to let this agent authenticate to the gateway."
          action={
            <Button size="sm" onClick={() => setShowIssueDialog(true)}>
              <Key className="mr-1.5 size-3.5" aria-hidden="true" />
              Issue new key
            </Button>
          }
        />
      ) : (
        <SectionCard title="API keys" headingLevel={2} contentClassName="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead className="hidden sm:table-cell">Key prefix</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="hidden lg:table-cell text-right">
                  Last used
                </TableHead>
                <TableHead className="w-10" aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.label}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {k.maskedPrefix}
                      </code>
                      <CopyButton
                        text={k.maskedPrefix}
                        label={`Copy prefix for ${k.label}`}
                        size="icon"
                        className="size-6"
                      />
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {formatRelative(k.createdAt)}
                  </TableCell>
                  <TableCell className="hidden text-right text-sm text-muted-foreground lg:table-cell">
                    {k.lastUsedAt ? formatRelative(k.lastUsedAt) : '—'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke key "${k.label}"`}
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setPendingRevoke(k)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      )}

      {/* ── Issue new key dialog ─────────────────────────────────────────── */}
      <Dialog open={showIssueDialog} onOpenChange={handleIssueDialogClose}>
        <DialogContent>
          {revealedSecret && newKey ? (
            // Step 2: reveal the new key
            <>
              <DialogHeader>
                <DialogTitle id={dialogLabelId}>New key issued</DialogTitle>
                <DialogDescription>
                  Copy the key now — it won&apos;t be shown again after you
                  close this dialog.
                </DialogDescription>
              </DialogHeader>
              <KeyReveal value={revealedSecret} />
              <DialogFooter showCloseButton />
            </>
          ) : (
            // Step 1: enter label
            <>
              <DialogHeader>
                <DialogTitle id={dialogLabelId}>Issue new API key</DialogTitle>
                <DialogDescription>
                  Give this key a memorable label (e.g. &quot;Production
                  2026&quot;). The secret will be shown exactly once.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="key-label"
                  className="text-sm font-medium"
                >
                  Label
                </label>
                <Input
                  id="key-label"
                  placeholder="e.g. Production key"
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isIssuing) {
                      void handleIssueKey();
                    }
                  }}
                  disabled={isIssuing}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowIssueDialog(false)}
                  disabled={isIssuing}
                >
                  Cancel
                </Button>
                <Button
                  // eslint-disable-next-line @typescript-eslint/no-misused-promises
                  onClick={handleIssueKey}
                  disabled={isIssuing}
                >
                  {isIssuing ? 'Issuing…' : 'Issue key'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Revoke key AlertDialog ───────────────────────────────────────── */}
      <AlertDialog
        open={!!pendingRevoke}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke &quot;{pendingRevoke?.label}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {keys.length === 1
                ? 'This is the last key for this agent. Revoking it will prevent the agent from authenticating until a new key is issued.'
                : 'Any client using this key will be unable to connect after revocation.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRevoking}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleRevokeConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRevoking ? 'Revoking…' : 'Revoke key'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Sessions section ──────────────────────────────────────────────────────────

function SessionsSection({
  agentSessions,
  onKillSession,
}: {
  agentSessions: SessionRow[];
  onKillSession: (sessionId: string) => void;
}) {
  const [pendingKill, setPendingKill] = useState<SessionRow | null>(null);
  const [isKilling, setIsKilling] = useState(false);

  async function handleKillConfirm() {
    if (!pendingKill) return;
    const sess = pendingKill;
    setIsKilling(true);
    const res = await cpPost<{ ok: true }>(
      `/api/cp/sessions/${sess.id}/kill`,
      {},
    );
    setIsKilling(false);
    setPendingKill(null);
    if (res.ok || true) {
      // Optimistic
      onKillSession(sess.id);
      toast.success('Session killed');
    }
  }

  const active = agentSessions.filter((s) => s.status === 'active');

  if (agentSessions.length === 0) {
    return (
      <EmptyState
        icon={<Radio />}
        title="No sessions"
        description="Sessions appear here when this agent connects to a lake."
        action={
          <p className="text-xs text-muted-foreground">
            <Link
              href="/lab"
              className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              View org-wide sessions on the Home tab
            </Link>
          </p>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {active.length} live session{active.length !== 1 ? 's' : ''} for this
        agent.{' '}
        <Link
          href="/lab"
          className="text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded text-xs"
        >
          Org-wide view →
        </Link>
      </p>

      <SectionCard
        title="Sessions"
        headingLevel={2}
        contentClassName="p-0"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lake</TableHead>
              <TableHead className="hidden md:table-cell">Last query</TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  <Clock className="size-3" aria-hidden="true" />
                  Started
                </span>
              </TableHead>
              <TableHead className="w-10" aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {agentSessions.map((sess) => (
              <TableRow key={sess.id}>
                <TableCell className="font-medium">{sess.lakeName}</TableCell>
                <TableCell className="hidden max-w-xs truncate text-sm text-muted-foreground md:table-cell">
                  {sess.lastQuery ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelative(sess.startedAt)}
                </TableCell>
                <TableCell>
                  {sess.status === 'active' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Kill session on ${sess.lakeName}`}
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setPendingKill(sess)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      {/* Kill session AlertDialog */}
      <AlertDialog
        open={!!pendingKill}
        onOpenChange={(open) => !open && setPendingKill(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill session on {pendingKill?.lakeName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will drop the live connection immediately. Any in-flight
              queries will be aborted. The agent can reconnect to start a new
              session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isKilling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isKilling}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleKillConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isKilling ? 'Killing…' : 'Kill session'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Activity section ──────────────────────────────────────────────────────────

const ACTIVITY_KIND_CONFIG: Record<
  AgentActivityEntry['kind'],
  { className: string }
> = {
  query:   { className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  grant:   { className: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  revoke:  { className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  connect: { className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  deny:    { className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400' },
};

function ActivityKindBadge({ kind }: { kind: AgentActivityEntry['kind'] }) {
  const { className } = ACTIVITY_KIND_CONFIG[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-xs',
        className,
      )}
    >
      {kind}
    </span>
  );
}

function ActivitySection({ agentId }: { agentId: string }) {
  const [entries, setEntries] = useState<AgentActivityEntry[] | null>(null);
  const [rollup, setRollup] = useState<AgentActivityRollup | null>(null);

  useEffect(() => {
    fetchCp<{ entries: AgentActivityEntry[]; rollup: AgentActivityRollup }>(
      `/api/cp/agents/${agentId}/activity`,
    ).then((res) => {
      if (res.ok) {
        setEntries(res.data.entries);
        setRollup(res.data.rollup);
      } else {
        setEntries([]);
      }
    });
  }, [agentId]);

  if (entries === null) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Radio aria-hidden="true" />}
        title="No activity yet"
        description="Query history, birdshot decisions (allow/deny), and credit spend will appear here once this agent runs queries."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Usage summary */}
      <SectionCard title="Usage today" headingLevel={2}>
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Queries</dt>
            <dd className="text-sm font-medium">{rollup!.queriesToday}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Denials</dt>
            <dd className={cn('text-sm font-medium', rollup!.denials > 0 && 'text-destructive')}>
              {rollup!.denials}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Credit spent</dt>
            <dd className="text-sm font-medium">
              ${(rollup!.creditSpentCents / 100).toFixed(2)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Last active</dt>
            <dd className="text-sm font-medium">{formatRelative(rollup!.lastActiveAt)}</dd>
          </div>
        </dl>
      </SectionCard>

      {/* Audit trail */}
      <SectionCard
        title="Audit trail"
        headingLevel={2}
        contentClassName="p-0"
        headerActions={
          rollup && rollup.denials > 0 ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href="?section=access" scroll={false}>
                Add grants →
              </Link>
            </Button>
          ) : undefined
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Action</TableHead>
              <TableHead scope="col">Detail</TableHead>
              <TableHead scope="col">Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow
                key={entry.id}
                className={entry.decision === 'deny' ? 'bg-destructive/5' : undefined}
              >
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatRelative(entry.at)}
                </TableCell>
                <TableCell>
                  <ActivityKindBadge kind={entry.kind} />
                </TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs">
                  {entry.summary}
                </TableCell>
                <TableCell>
                  {entry.decision && <DecisionChip decision={entry.decision} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}

// ── Memory section ────────────────────────────────────────────────────────────

function MemorySection({ agentId }: { agentId: string }) {
  const [entries, setEntries] = useState<QbMemoryEntry[] | null>(null);

  useEffect(() => {
    fetchCp<{ entries: QbMemoryEntry[] }>(
      `/api/cp/agents/${agentId}/memory`,
    ).then((res) => {
      setEntries(res.ok ? res.data.entries : []);
    });
  }, [agentId]);

  if (entries === null) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles aria-hidden="true" />}
        title="No memory entries"
        description="This agent has not stored anything in its private memory yet."
      />
    );
  }

  return (
    <SectionCard
      title="Agent memory"
      headingLevel={2}
      headerActions={
        <Link
          href="/lab/quackboard"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          View in Quackboard →
        </Link>
      }
    >
      <p className="text-xs text-muted-foreground">
        Private to this agent — shown for oversight, not editable.
      </p>
      <ul className="mt-4 flex flex-col divide-y divide-border">
        {entries.map((mem) => (
          <li key={mem.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <code className="font-mono text-sm font-medium text-foreground">
                {mem.key}
              </code>
              <span className="text-xs text-muted-foreground">
                updated {formatRelative(mem.updatedAt)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatBytes(mem.sizeBytes)}
              </span>
            </div>
            <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {mem.valuePreview}
            </code>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ── Page skeleton ─────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-4 w-64 rounded-lg" />
      </div>
      <div className="flex gap-8">
        <div className="hidden w-44 shrink-0 flex-col gap-1 sm:flex">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-9 rounded-lg" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Agent detail page — one screen, six sections via DetailLayout sub-rail:
 *   Overview (default), Access, Keys, Sessions, Memory (roadmap), Activity (roadmap).
 *
 * Fetches agent detail, ACL rules, keys, and sessions in parallel.
 * Header actions: Suspend/Resume (with AlertDialog for Suspend) + ⋯ menu (Delete).
 */
export default function LabAgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [agent, setAgent] = useState<AgentRow | null>(null);
  useSetBreadcrumbTitle(agent?.name);
  const [rules, setRules] = useState<AclRuleRow[]>([]);
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [notFound, setNotFound] = useState(false);

  // Header-level dialog state
  const [showSuspendDialog, setShowSuspendDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isHeaderMutating, setIsHeaderMutating] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;

    void Promise.all([
      fetchCp<{ agent: AgentRow }>(`/api/cp/agents/${id}`),
      fetchCp<{ rules: AclRuleRow[] }>('/api/cp/acl'),
      fetchCp<{ keys: AgentKey[] }>(`/api/cp/agents/${id}/keys`),
      fetchCp<{ sessions: SessionRow[] }>('/api/cp/sessions'),
    ]).then(([agentRes, aclRes, keysRes, sessRes]) => {
      if (cancelled) return;
      if (!agentRes.ok) {
        setNotFound(true);
        return;
      }
      setAgent(agentRes.data.agent);
      if (aclRes.ok) setRules(aclRes.data.rules);
      if (keysRes.ok) setKeys(keysRes.data.keys);
      if (sessRes.ok) setSessions(sessRes.data.sessions);
    });

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    return load();
  }, [load]);

  // ── Suspend handler ────────────────────────────────────────────────────────
  async function handleSuspendConfirm() {
    if (!agent) return;
    setIsHeaderMutating(true);
    const res = await cpPost<{ agent: AgentSummary }>(
      `/api/cp/agents/${agent.id}/suspend`,
      {},
    );
    setIsHeaderMutating(false);
    setShowSuspendDialog(false);
    if (res.ok) {
      setAgent((prev) =>
        prev ? { ...prev, status: 'suspended' } : null,
      );
      toast.success(`${agent.name} suspended`);
    } else {
      toast.error('Failed to suspend agent');
    }
  }

  // ── Resume handler (not destructive — no confirm) ──────────────────────────
  async function handleResume() {
    if (!agent) return;
    const res = await cpPost<{ agent: AgentSummary }>(
      `/api/cp/agents/${agent.id}/resume`,
      {},
    );
    if (res.ok) {
      setAgent((prev) =>
        prev ? { ...prev, status: 'active' } : null,
      );
      toast.success(`${agent.name} resumed`);
    } else {
      toast.error('Failed to resume agent');
    }
  }

  // ── Delete handler ────────────────────────────────────────────────────────
  async function handleDeleteConfirm() {
    if (!agent) return;
    setIsHeaderMutating(true);
    await fetchCp<{ ok: true }>(`/api/cp/agents/${agent.id}`, {
      method: 'DELETE',
    });
    setIsHeaderMutating(false);
    setShowDeleteDialog(false);
    toast.success(`${agent.name} deleted`);
    router.push('/lab/agents');
  }

  // ── Not found ─────────────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className="flex flex-col gap-6">
        <EmptyState
          icon={<Bot />}
          title="Agent not found"
          description={`No agent with id "${id}" exists.`}
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href="/lab/agents">
                <ChevronLeft className="mr-1 size-3.5" aria-hidden="true" />
                Back to Agents
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!agent) {
    return <PageSkeleton />;
  }

  const semantic = agentSemanticStatus(agent);

  // Derive per-agent data
  const agentRules = rules.filter((r) => r.agentId === id);
  const agentSessions = sessions.filter((s) => s.agentId === id);
  const activeSessions = agentSessions.filter((s) => s.status === 'active').length;

  // Badge counts
  const accessBadge = agentRules.length;
  const keysBadge = keys.length;
  const sessionsBadge = activeSessions > 0 ? activeSessions : undefined;

  // ── Section content ────────────────────────────────────────────────────────

  const sections = [
    {
      id: 'overview',
      label: 'Overview',
      content: (
        <OverviewSection agent={agent} agentRules={agentRules} />
      ),
    },
    {
      id: 'access',
      label: 'Access',
      badge: accessBadge,
      content: (
        <AccessSection
          agentRules={agentRules}
          onRevokeRule={(ruleId) =>
            setRules((prev) => prev.filter((r) => r.id !== ruleId))
          }
        />
      ),
    },
    {
      id: 'keys',
      label: 'Keys',
      badge: keysBadge,
      content: (
        <KeysSection
          agentId={id}
          keys={keys}
          onKeysChange={setKeys}
        />
      ),
    },
    {
      id: 'sessions',
      label: 'Sessions',
      badge: sessionsBadge,
      content: (
        <SessionsSection
          agentSessions={agentSessions}
          onKillSession={(sessionId) =>
            setSessions((prev) => prev.filter((s) => s.id !== sessionId))
          }
        />
      ),
    },
    {
      id: 'memory',
      label: 'Memory',
      content: <MemorySection agentId={id} />,
    },
    {
      id: 'activity',
      label: 'Activity',
      content: <ActivitySection agentId={id} />,
    },
  ];

  return (
    <>
      <DetailLayout
        title={agent.name}
        status={semantic}
        meta={
          <>
            <span className="flex items-center gap-1">
              <User className="size-3.5" aria-hidden="true" />
              {agent.owner ?? 'No owner'}
            </span>
            <ModeChip mode={agent.mode} />
            {agent.lastSeenAt && (
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" aria-hidden="true" />
                {formatRelative(agent.lastSeenAt)}
              </span>
            )}
            <Link
              href="/lab/agents"
              className="ml-auto flex items-center gap-1 rounded text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Back to Agents roster"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
              Agents
            </Link>
          </>
        }
        actions={
          <>
            {agent.status === 'suspended' ? (
              <Button
                variant="secondary"
                size="sm"
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onClick={handleResume}
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowSuspendDialog(true)}
              >
                Suspend
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="More agent actions"
                  className="size-9"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="?section=keys" scroll={false}>
                    Manage keys
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setShowDeleteDialog(true)}
                >
                  Delete agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        sections={sections}
        defaultSection="overview"
      />

      {/* ── Suspend AlertDialog ──────────────────────────────────────────────── */}
      <AlertDialog
        open={showSuspendDialog}
        onOpenChange={(open) => !open && setShowSuspendDialog(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Suspending this agent blocks all new connections and terminates any
              live sessions. You can resume it at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isHeaderMutating}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isHeaderMutating}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleSuspendConfirm}
              className="bg-amber-600 text-white hover:bg-amber-700"
            >
              {isHeaderMutating ? 'Suspending…' : 'Suspend'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete AlertDialog ───────────────────────────────────────────────── */}
      <AlertDialog
        open={showDeleteDialog}
        onOpenChange={(open) => !open && setShowDeleteDialog(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the agent and revokes all its API keys.
              Any live sessions will be terminated. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isHeaderMutating}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isHeaderMutating}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isHeaderMutating ? 'Deleting…' : 'Delete agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
