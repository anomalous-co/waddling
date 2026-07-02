'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Bot,
  Plus,
  Copy,
  Check,
  TriangleAlert,
  MoreHorizontal,
  Search,
  ChevronUp,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import { fetchCp, cpPatch, cpDelete } from '@/components/dashboard/fetch';
import type { AgentSummary } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
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
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageHeader } from '@/components/waddling/page-header';
import { EmptyState } from '@/components/waddling/empty-state';
import { StatusDot } from '@/components/waddling/status-dot';
import { ModeChip } from '@/components/waddling/agent-chips';
import { agentSemanticStatus, formatRelative } from '@/components/waddling/agent-status';
import { AccessEditorDialog } from '@/components/dashboard/access-editor-dialog';
import { NoAccessFlag, needsAccess } from '@/components/dashboard/agent/kit';
import { DelegationsTab } from '@/components/dashboard/agent/delegations-tab';

// ── Local types ─────────────────────────────────────────────────────────────

type SortKey = 'name' | 'lastSeen';

/** ACL rows used only to count grants per agent for the roster's Access column. */
interface AclRuleRow {
  id: string;
  agentId?: string;
}
interface AclPolicyRow {
  id: string;
  agentId?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildGrantCounts(
  rules: AclRuleRow[],
  policies: AclPolicyRow[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rules) {
    if (r.agentId) map.set(r.agentId, (map.get(r.agentId) ?? 0) + 1);
  }
  for (const p of policies) {
    if (p.agentId) map.set(p.agentId, (map.get(p.agentId) ?? 0) + 1);
  }
  return map;
}

function SortChevron({
  col,
  sortBy,
  sortAsc,
}: {
  col: SortKey;
  sortBy: SortKey;
  sortAsc: boolean;
}) {
  if (sortBy !== col) return null;
  const Icon = sortAsc ? ChevronUp : ChevronDown;
  return <Icon className="ml-1 inline size-3" aria-hidden="true" />;
}

// ── RevealKeyDialog ───────────────────────────────────────────────────────────
// Shown once after create — the API key is never retrievable again.

function RevealKeyDialog({
  open,
  onOpenChange,
  agentName,
  apiKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  apiKey: string;
}) {
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Alert>
            <TriangleAlert />
            <AlertTitle>Shown once — store it now</AlertTitle>
            <AlertDescription>
              This key for <span className="font-medium text-foreground">{agentName}</span> will
              not be shown again. Copy it to a secure location before closing this dialog.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-1.5">
            <Label>API key</Label>
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 overflow-x-auto rounded-lg border border-input bg-muted px-3 py-2 font-mono text-xs leading-relaxed break-all">
                {apiKey}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void copyKey()}
                aria-label="Copy API key"
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done — I have saved the key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Placeholder tab ───────────────────────────────────────────────────────────

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">{label} — coming soon</p>
      <p className="text-xs text-muted-foreground">This section is planned for a future release.</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Agents roster — searchable, sortable table of all org agents, wrapped in the
 * org-level Agents / Swarms / Delegations tab strip.
 *
 * Real data: /api/cp/agents (roster), /api/cp/datalakes (create dialog), and
 * /api/cp/acl + /api/cp/acl-policy (per-agent grant counts → the Access column,
 * which surfaces the "active but 0 grants" no-access flag).
 *
 * Lifecycle actions hit the real control-plane endpoints: suspend/resume via
 * PATCH /api/cp/agents/:id { status }, delete (soft-revoke) via DELETE.
 */
export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [grantCounts, setGrantCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('lastSeen');
  const [sortAsc, setSortAsc] = useState(false);

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [revealKey, setRevealKey] = useState<{ name: string; key: string } | null>(null);

  // Pending destructive action (null when no dialog is open)
  const [pendingSuspend, setPendingSuspend] = useState<AgentSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentSummary | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  const load = useCallback(async () => {
    const [agentsRes, lakesRes, rulesRes, policiesRes] = await Promise.all([
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
      fetchCp<{ rules: AclRuleRow[] }>('/api/cp/acl'),
      fetchCp<{ policies: AclPolicyRow[] }>('/api/cp/acl-policy'),
    ]);

    if (!agentsRes.ok) {
      setError(agentsRes.error);
      setAgents([]);
    } else {
      setAgents(agentsRes.data.agents);
      setError(null);
    }

    if (lakesRes.ok) {
      setDatalakes(lakesRes.data.datalakes.map((d) => ({ id: d.id, name: d.name })));
    }

    const rules = rulesRes.ok ? rulesRes.data.rules : [];
    const policies = policiesRes.ok ? policiesRes.data.policies : [];
    setGrantCounts(buildGrantCounts(rules, policies));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleSort(col: SortKey) {
    if (sortBy === col) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(col);
      setSortAsc(col === 'name'); // name: A→Z default; lastSeen: most-recent-first
    }
  }

  // "Delete" is a soft-revoke (status='revoked'); a revoked agent leaves the roster.
  const visible = (agents ?? []).filter((a) => a.status !== 'revoked');

  const filtered = visible
    .filter((a) => {
      const q = search.trim().toLowerCase();
      return (
        q === '' ||
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      let cmp: number;
      if (sortBy === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else {
        const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
        const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
        cmp = bt - at; // recent first
      }
      return sortAsc ? cmp : -cmp;
    });

  // ── Lifecycle actions (real control-plane endpoints) ─────────────────────────

  async function handleResume(agent: AgentSummary) {
    const res = await cpPatch<unknown>(`/api/cp/agents/${agent.id}`, { status: 'active' });
    if (res.ok) {
      setAgents(
        (prev) => prev?.map((a) => (a.id === agent.id ? { ...a, status: 'active' } : a)) ?? null,
      );
      toast.success(`${agent.name} resumed`);
    } else {
      toast.error(`Failed to resume: ${res.error}`);
    }
  }

  async function handleSuspendConfirm() {
    if (!pendingSuspend) return;
    const agent = pendingSuspend;
    setIsMutating(true);
    const res = await cpPatch<unknown>(`/api/cp/agents/${agent.id}`, { status: 'suspended' });
    setIsMutating(false);
    setPendingSuspend(null);
    if (res.ok) {
      setAgents(
        (prev) =>
          prev?.map((a) => (a.id === agent.id ? { ...a, status: 'suspended' } : a)) ?? null,
      );
      toast.success(`${agent.name} suspended`);
    } else {
      toast.error(`Failed to suspend: ${res.error}`);
    }
  }

  async function handleDeleteConfirm() {
    if (!pendingDelete) return;
    const agent = pendingDelete;
    setIsMutating(true);
    const res = await cpDelete<unknown>(`/api/cp/agents/${agent.id}`);
    setIsMutating(false);
    setPendingDelete(null);
    if (res.ok) {
      setAgents((prev) => prev?.filter((a) => a.id !== agent.id) ?? null);
      toast.success(`${agent.name} deleted`);
    } else {
      toast.error(`Failed to delete: ${res.error}`);
    }
  }

  const handleCreated = useCallback((agent: AgentSummary, key: string) => {
    setAgents((prev) => [...(prev ?? []), agent]);
    if (key) setRevealKey({ name: agent.name, key });
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (error && (agents === null || agents.length === 0)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load agents</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setAgents(null); // back to the skeleton while the retry fetch resolves
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

  return (
    <>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Agents"
          description="Manage autonomous and delegated agents that connect to your data lakes."
          actions={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
              New agent
            </Button>
          }
        />

        {/* Org-level tab strip — compact, content-sized tabs on a full-width rule */}
        <Tabs defaultValue="agents">
          <TabsList variant="line" className="w-full justify-start border-b rounded-none pb-0 h-auto">
            <TabsTrigger value="agents" className="flex-none px-3 pb-2">
              Agents
            </TabsTrigger>
            <TabsTrigger value="swarms" className="flex-none px-3 pb-2">
              Swarms
            </TabsTrigger>
            <TabsTrigger value="delegations" className="flex-none px-3 pb-2">
              Delegations
            </TabsTrigger>
          </TabsList>

          {/* ── Agents tab ─────────────────────────────────────────────────── */}
          <TabsContent value="agents" className="mt-4 flex flex-col gap-6">
            {/* Search */}
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                placeholder="Search agents…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search agents by name or description"
                className="pl-9"
              />
            </div>

            {/* Loading */}
            {agents === null && (
              <div className="flex flex-col gap-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-xl" />
                ))}
              </div>
            )}

            {/* Empty — no agents at all */}
            {agents !== null && visible.length === 0 && (
              <EmptyState
                icon={<Bot />}
                title="No agents yet"
                description="Create an agent to give a model or automated system governed access to your data lakes."
                action={
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
                    Create first agent
                  </Button>
                }
              />
            )}

            {/* Empty — search returned nothing */}
            {agents !== null && visible.length > 0 && filtered.length === 0 && (
              <EmptyState
                icon={<Search />}
                title="No agents match"
                description={`No agents found matching "${search}".`}
              />
            )}

            {/* Roster table */}
            {filtered.length > 0 && (
              <div className="overflow-hidden rounded-xl border ring-1 ring-foreground/10">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <button
                          type="button"
                          onClick={() => toggleSort('name')}
                          aria-label={
                            sortBy === 'name'
                              ? `Sort by name ${sortAsc ? 'descending' : 'ascending'}`
                              : 'Sort by name'
                          }
                          className="inline-flex items-center rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Agent
                          <SortChevron col="name" sortBy={sortBy} sortAsc={sortAsc} />
                        </button>
                      </TableHead>
                      <TableHead className="hidden sm:table-cell">Status</TableHead>
                      <TableHead className="hidden md:table-cell">Mode</TableHead>
                      <TableHead className="hidden md:table-cell">Access</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        <button
                          type="button"
                          onClick={() => toggleSort('lastSeen')}
                          aria-label={
                            sortBy === 'lastSeen'
                              ? `Sort by last seen ${sortAsc ? 'descending' : 'ascending'}`
                              : 'Sort by last seen'
                          }
                          className="inline-flex items-center rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Last seen
                          <SortChevron col="lastSeen" sortBy={sortBy} sortAsc={sortAsc} />
                        </button>
                      </TableHead>
                      <TableHead className="hidden sm:table-cell text-right">Sessions</TableHead>
                      <TableHead className="w-10" aria-label="Row actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((agent) => {
                      const semantic = agentSemanticStatus(agent);
                      const count = grantCounts.get(agent.id) ?? 0;
                      const noAccess = needsAccess(agent.status, count);
                      return (
                        <TableRow key={agent.id}>
                          <TableCell>
                            <Link
                              href={`/agents/${agent.id}`}
                              className="group flex flex-col gap-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            >
                              <span className="font-medium group-hover:underline underline-offset-4">
                                {agent.name}
                              </span>
                              {agent.description ? (
                                <span className="max-w-xs truncate text-xs text-muted-foreground">
                                  {agent.description}
                                </span>
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground">
                                  {agent.id}
                                </span>
                              )}
                            </Link>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <StatusDot status={semantic} />
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <ModeChip mode={agent.mode} />
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {noAccess ? (
                              <NoAccessFlag />
                            ) : (
                              <span className="tabular-nums text-sm text-muted-foreground">
                                {count} {count === 1 ? 'grant' : 'grants'}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                            {agent.lastSeenAt ? formatRelative(agent.lastSeenAt) : '—'}
                          </TableCell>
                          <TableCell className="hidden text-right text-sm text-muted-foreground sm:table-cell tabular-nums">
                            {agent.activeSessions ?? 0}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Actions for ${agent.name}`}
                                  className="size-7"
                                >
                                  <MoreHorizontal className="size-4" aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/agents/${agent.id}`}>View details</Link>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {agent.status === 'suspended' ? (
                                  <DropdownMenuItem onSelect={() => void handleResume(agent)}>
                                    Resume
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onSelect={() => setPendingSuspend(agent)}>
                                    Suspend
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => setPendingDelete(agent)}
                                >
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* ── Swarms tab ─────────────────────────────────────────────────── */}
          <TabsContent value="swarms" className="mt-4">
            <ComingSoon label="Swarms" />
          </TabsContent>

          {/* ── Delegations tab (org-wide, admin/owner-gated) ──────────────── */}
          <TabsContent value="delegations" className="mt-4">
            <DelegationsTab />
          </TabsContent>
        </Tabs>
      </div>

      {/* Create dialog */}
      <AccessEditorDialog
        mode="create"
        datalakes={datalakes}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      {/* Reveal-key dialog */}
      {revealKey ? (
        <RevealKeyDialog
          open={!!revealKey}
          onOpenChange={(open) => {
            if (!open) setRevealKey(null);
          }}
          agentName={revealKey.name}
          apiKey={revealKey.key}
        />
      ) : null}

      {/* ── Suspend AlertDialog ──────────────────────────────────────────────── */}
      <AlertDialog open={!!pendingSuspend} onOpenChange={(open) => !open && setPendingSuspend(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {pendingSuspend?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Suspending this agent blocks all new connections and terminates any live sessions. You
              can resume it at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isMutating}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleSuspendConfirm}
              className="bg-amber-600 text-white hover:bg-amber-700"
            >
              {isMutating ? 'Suspending…' : 'Suspend'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete AlertDialog ───────────────────────────────────────────────── */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the agent and all its grants. Any live sessions will be
              terminated. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isMutating}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isMutating ? 'Deleting…' : 'Delete agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
