'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';
import { toast } from 'sonner';
import {
  Bot,
  Plug,
  MoreHorizontal,
  Search,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type { AgentSummary } from '@/lib/types';
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
import { PageHeader } from '@/components/waddling/page-header';
import { EmptyState } from '@/components/waddling/empty-state';
import { StatusDot } from '@/components/waddling/status-dot';
import { ModeChip } from '@/components/waddling/agent-chips';
import {
  agentSemanticStatus,
  formatRelative,
} from '@/components/waddling/agent-status';

// ── Types ─────────────────────────────────────────────────────────────────────

type SortKey = 'name' | 'lastSeen';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Agents roster — searchable, sortable table of all org agents.
 * Links to /lab/agents/[id] for per-agent detail.
 *
 * A11y: real <table> semantics, sort buttons with accessible names, icon-only
 * controls have aria-label, AlertDialog confirmations for all destructive actions.
 */
export default function LabAgentsPage() {
  const { openConnect } = useConnectAgent();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('lastSeen');
  const [sortAsc, setSortAsc] = useState(false);

  // Pending destructive action (null when no dialog is open)
  const [pendingSuspend, setPendingSuspend] = useState<AgentSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentSummary | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents').then((res) => {
      if (cancelled) return;
      setAgents(res.ok ? res.data.agents : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleSort(col: SortKey) {
    if (sortBy === col) {
      setSortAsc((prev) => !prev);
    } else {
      setSortBy(col);
      setSortAsc(col === 'name'); // name: A→Z default; lastSeen: most-recent-first
    }
  }

  const filtered = (agents ?? [])
    .filter((a) => {
      const q = search.trim().toLowerCase();
      return (
        q === '' ||
        a.name.toLowerCase().includes(q) ||
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

  async function handleResume(agent: AgentSummary) {
    const res = await cpPost<{ agent: AgentSummary }>(
      `/api/cp/agents/${agent.id}/resume`,
      {},
    );
    if (res.ok) {
      setAgents(
        (prev) =>
          prev?.map((a) =>
            a.id === agent.id ? { ...a, status: 'active' } : a,
          ) ?? null,
      );
      toast.success(`${agent.name} resumed`);
    } else {
      toast.error('Failed to resume agent');
    }
  }

  async function handleSuspendConfirm() {
    if (!pendingSuspend) return;
    const agent = pendingSuspend;
    setIsMutating(true);
    const res = await cpPost<{ agent: AgentSummary }>(
      `/api/cp/agents/${agent.id}/suspend`,
      {},
    );
    setIsMutating(false);
    setPendingSuspend(null);
    if (res.ok) {
      setAgents(
        (prev) =>
          prev?.map((a) =>
            a.id === agent.id ? { ...a, status: 'suspended' } : a,
          ) ?? null,
      );
      toast.success(`${agent.name} suspended`);
    } else {
      toast.error('Failed to suspend agent');
    }
  }

  async function handleDeleteConfirm() {
    if (!pendingDelete) return;
    const agent = pendingDelete;
    setIsMutating(true);
    await fetchCp<{ ok: true }>(`/api/cp/agents/${agent.id}`, {
      method: 'DELETE',
    });
    setIsMutating(false);
    setPendingDelete(null);
    // Optimistic: always remove from local list for the mock
    setAgents((prev) => prev?.filter((a) => a.id !== agent.id) ?? null);
    toast.success(`${agent.name} deleted`);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Manage autonomous and delegated agents that connect to your data lakes."
        actions={
          <Button onClick={() => openConnect()}>
            <Plug className="mr-1.5 size-3.5" aria-hidden="true" />
            Connect an agent
          </Button>
        }
      />

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
      {agents !== null && agents.length === 0 && (
        <EmptyState
          icon={<Bot />}
          title="No agents yet"
          description="Create your first agent to start querying your data lakes."
          action={
            <Button onClick={() => openConnect()}>
              <Plug className="mr-1.5 size-3.5" aria-hidden="true" />
              Connect an agent
            </Button>
          }
        />
      )}

      {/* Empty — search returned nothing */}
      {agents !== null && agents.length > 0 && filtered.length === 0 && (
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
                    <SortChevron
                      col="lastSeen"
                      sortBy={sortBy}
                      sortAsc={sortAsc}
                    />
                  </button>
                </TableHead>
                <TableHead className="hidden sm:table-cell text-right">
                  Sessions
                </TableHead>
                <TableHead className="w-10" aria-label="Row actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((agent) => {
                const semantic = agentSemanticStatus(agent);
                return (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <Link
                        href={`/lab/agents/${agent.id}`}
                        className="group flex flex-col gap-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      >
                        <span className="font-medium group-hover:underline underline-offset-4">
                          {agent.name}
                        </span>
                        {agent.description && (
                          <span className="max-w-xs truncate text-xs text-muted-foreground">
                            {agent.description}
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
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {agent.lastSeenAt
                        ? formatRelative(agent.lastSeenAt)
                        : '—'}
                    </TableCell>
                    <TableCell className="hidden text-right text-sm text-muted-foreground sm:table-cell">
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
                            <MoreHorizontal
                              className="size-4"
                              aria-hidden="true"
                            />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/lab/agents/${agent.id}`}>
                              View details
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {agent.status === 'suspended' ? (
                            <DropdownMenuItem
                              onSelect={() => void handleResume(agent)}
                            >
                              Resume
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onSelect={() => setPendingSuspend(agent)}
                            >
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

      {/* ── Suspend AlertDialog ──────────────────────────────────────────────── */}
      <AlertDialog
        open={!!pendingSuspend}
        onOpenChange={(open) => !open && setPendingSuspend(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {pendingSuspend?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Suspending this agent blocks all new connections and terminates any
              live sessions. You can resume it at any time.
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
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the agent and revokes all its API keys.
              Any live sessions will be terminated. This action cannot be undone.
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
    </div>
  );
}
