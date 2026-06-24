'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Plus,
  RefreshCw,
  Copy,
  Check,
  TriangleAlert,
  EllipsisVertical,
  Search,
  Table2,
  LayoutGrid,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StatusBadge, StatusDot } from '@/components/dashboard/status';
import { fetchCp, cpPatch, cpDelete } from '@/components/dashboard/fetch';
import { AccessEditorDialog } from '@/components/dashboard/access-editor-dialog';
import { NoAccessFlag, needsAccess } from '@/components/dashboard/agent/kit';
import { DelegationsTab } from '@/components/dashboard/agent/delegations-tab';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { AgentSummary } from '@/lib/types';

// ── Local types ───────────────────────────────────────────────────────────────

interface AclRuleRow {
  id: string;
  agentId?: string;
}

interface AclPolicyRow {
  id: string;
  agentId?: string;
}

type ViewMode = 'table' | 'cards';
type TypeFilter = 'all' | 'autonomous' | 'delegated';
type StatusFilter = 'all' | 'active' | 'suspended';
type SortKey = 'lastSeen' | 'name';

const VIEW_STORAGE_KEY = 'agents.rosterView';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function buildGrantCounts(rules: AclRuleRow[], policies: AclPolicyRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rules) {
    if (r.agentId) map.set(r.agentId, (map.get(r.agentId) ?? 0) + 1);
  }
  for (const p of policies) {
    if (p.agentId) map.set(p.agentId, (map.get(p.agentId) ?? 0) + 1);
  }
  return map;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function AgentsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

// ── RevealKeyDialog ───────────────────────────────────────────────────────────

interface RevealKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  apiKey: string;
}

function RevealKeyDialog({ open, onOpenChange, agentName, apiKey }: RevealKeyDialogProps) {
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

// ── DeleteConfirmDialog ───────────────────────────────────────────────────────

interface DeleteConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  onConfirm: () => void;
}

function DeleteConfirmDialog({ open, onOpenChange, agentName, onConfirm }: DeleteConfirmProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete agent?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes <span className="font-medium text-foreground">{agentName}</span> and
            all its grants. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Row actions menu ──────────────────────────────────────────────────────────

interface AgentActionsProps {
  agent: AgentSummary;
  onSuspend: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (agent: AgentSummary) => void;
}

function AgentActionsMenu({ agent, onSuspend, onResume, onDelete }: AgentActionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-7">
          <EllipsisVertical className="size-3.5" />
          <span className="sr-only">Actions for {agent.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {agent.status === 'active' && (
          <DropdownMenuItem onClick={() => onSuspend(agent.id)}>Suspend</DropdownMenuItem>
        )}
        {agent.status === 'suspended' && (
          <DropdownMenuItem onClick={() => onResume(agent.id)}>Resume</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => onDelete(agent)}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Table view ────────────────────────────────────────────────────────────────

interface TableViewProps {
  agents: AgentSummary[];
  grantCounts: Map<string, number>;
  onSuspend: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (agent: AgentSummary) => void;
}

function TableView({ agents, grantCounts, onSuspend, onResume, onDelete }: TableViewProps) {
  if (agents.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Agent</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>Sessions</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => {
          const count = grantCounts.get(a.id) ?? 0;
          const noAccess = needsAccess(a.status, count);
          return (
            <TableRow key={a.id} className="hover:bg-muted/50">
              <TableCell>
                <StatusDot status={a.status} />
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <Link
                    href={`/agents/${a.id}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {a.name}
                  </Link>
                  <span className="font-mono text-xs text-muted-foreground">{a.id}</span>
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={a.mode} />
              </TableCell>
              <TableCell>
                {noAccess ? (
                  <NoAccessFlag />
                ) : (
                  <span className="tabular-nums text-sm text-muted-foreground">
                    {count} {count === 1 ? 'grant' : 'grants'}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {a.activeSessions && a.activeSessions > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                    <span className="size-1.5 rounded-full bg-green-500" aria-hidden />
                    {a.activeSessions}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground tabular-nums">
                {a.lastSeenAt ? relativeTime(a.lastSeenAt) : '—'}
              </TableCell>
              <TableCell>
                <AgentActionsMenu
                  agent={a}
                  onSuspend={onSuspend}
                  onResume={onResume}
                  onDelete={onDelete}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ── Card view ─────────────────────────────────────────────────────────────────

interface CardViewProps {
  agents: AgentSummary[];
  grantCounts: Map<string, number>;
  onSuspend: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (agent: AgentSummary) => void;
}

function CardView({ agents, grantCounts, onSuspend, onResume, onDelete }: CardViewProps) {
  if (agents.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((a) => {
        const count = grantCounts.get(a.id) ?? 0;
        const noAccess = needsAccess(a.status, count);
        return (
          <Card key={a.id} className="ring-1 ring-foreground/10">
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <StatusDot status={a.status} />
                    <Link
                      href={`/agents/${a.id}`}
                      className="font-medium text-foreground hover:underline truncate"
                    >
                      {a.name}
                    </Link>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground truncate">{a.id}</span>
                </div>
                <AgentActionsMenu
                  agent={a}
                  onSuspend={onSuspend}
                  onResume={onResume}
                  onDelete={onDelete}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <StatusBadge status={a.mode} />
                {noAccess && <NoAccessFlag />}
              </div>

              <div className="text-xs text-muted-foreground">
                {noAccess ? (
                  <span className="text-amber-700 dark:text-amber-500">No access — queries denied</span>
                ) : (
                  <span className="tabular-nums">
                    {count} {count === 1 ? 'grant' : 'grants'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                {a.activeSessions && a.activeSessions > 0 ? (
                  <>
                    <span className="size-1.5 rounded-full bg-green-500" aria-hidden />
                    {a.activeSessions} active · last seen {a.lastSeenAt ? relativeTime(a.lastSeenAt) : '—'}
                  </>
                ) : (
                  <>Last seen: {a.lastSeenAt ? relativeTime(a.lastSeenAt) : '—'}</>
                )}
              </div>

              <div className="pt-1">
                {noAccess ? (
                  <Link
                    href={`/agents/${a.id}#access`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Grant →
                  </Link>
                ) : (
                  <Link
                    href={`/agents/${a.id}`}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Connect →
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── Placeholder tabs ──────────────────────────────────────────────────────────

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">{label} — coming soon</p>
      <p className="text-xs text-muted-foreground">This section is planned for a future release.</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [grantCounts, setGrantCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [revealKey, setRevealKey] = useState<{ name: string; key: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);

  // Roster view / filters — default state; hydrate from localStorage in effect
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('lastSeen');

  // Hydrate view preference from localStorage after mount (SSR-safe)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === 'table' || stored === 'cards') setViewMode(stored);
    } catch {
      // localStorage unavailable — keep default
    }
  }, []);

  const setAndPersistView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(async () => {
    const [agentsRes, lakesRes, rulesRes, policiesRes] = await Promise.all([
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
      fetchCp<{ rules: AclRuleRow[] }>('/api/cp/acl'),
      fetchCp<{ policies: AclPolicyRow[] }>('/api/cp/acl-policy'),
    ]);

    if (!agentsRes.ok) {
      setError(agentsRes.error);
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

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Lifecycle actions ──────────────────────────────────────────────────────

  const handleSuspend = useCallback(async (id: string) => {
    const res = await cpPatch<unknown>(`/api/cp/agents/${id}`, { status: 'suspended' });
    if (res.ok) {
      setAgents((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: 'suspended' as const } : a)),
      );
      toast.success('Agent suspended');
    } else {
      toast.error(`Failed to suspend: ${res.error}`);
    }
  }, []);

  const handleResume = useCallback(async (id: string) => {
    const res = await cpPatch<unknown>(`/api/cp/agents/${id}`, { status: 'active' });
    if (res.ok) {
      setAgents((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: 'active' as const } : a)),
      );
      toast.success('Agent resumed');
    } else {
      toast.error(`Failed to resume: ${res.error}`);
    }
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    const name = deleteTarget.name;
    setDeleteTarget(null);
    const res = await cpDelete<unknown>(`/api/cp/agents/${id}`);
    if (res.ok) {
      setAgents((prev) => prev.filter((a) => a.id !== id));
      toast.success(`Agent "${name}" deleted`);
    } else {
      toast.error(`Failed to delete: ${res.error}`);
    }
  }, [deleteTarget]);

  const handleCreated = useCallback((agent: AgentSummary, key: string) => {
    setAgents((prev) => [...prev, agent]);
    if (key) setRevealKey({ name: agent.name, key });
  }, []);

  // ── Filtered + sorted roster ───────────────────────────────────────────────

  const filtered = useMemo(() => {
    // "Delete" is a soft-revoke (status='revoked'); a deleted agent should leave
    // the roster, so revoked agents are excluded from the list entirely.
    let list = agents.filter((a) => a.status !== 'revoked');

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
    }

    if (typeFilter !== 'all') {
      list = list.filter((a) => a.mode === typeFilter);
    }

    if (statusFilter !== 'all') {
      list = list.filter((a) => a.status === statusFilter);
    }

    if (sort === 'lastSeen') {
      list = [...list].sort((a, b) => {
        if (!a.lastSeenAt && !b.lastSeenAt) return 0;
        if (!a.lastSeenAt) return 1;
        if (!b.lastSeenAt) return -1;
        return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
      });
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }

    return list;
  }, [agents, search, typeFilter, statusFilter, sort]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <AgentsSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load agents</AlertTitle>
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

  return (
    <>
      <div className="flex flex-col gap-6">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            New agent
          </Button>
        </div>

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
          <TabsContent value="agents" className="mt-4">
            {agents.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No agents yet</EmptyTitle>
                  <EmptyDescription>
                    Create an agent to give a model or automated system governed access to your data
                    lakes.
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus data-icon="inline-start" />
                  Create first agent
                </Button>
              </Empty>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Search */}
                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search agents…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className={cn(
                        'h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm',
                        'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50',
                      )}
                    />
                  </div>

                  {/* Type filter */}
                  <Select
                    value={typeFilter}
                    onValueChange={(v) => setTypeFilter(v as TypeFilter)}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-[120px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="autonomous">Autonomous</SelectItem>
                      <SelectItem value="delegated">Connected</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Status filter */}
                  <Select
                    value={statusFilter}
                    onValueChange={(v) => setStatusFilter(v as StatusFilter)}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-[120px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All status</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="suspended">Suspended</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Sort */}
                  <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                    <SelectTrigger className="h-8 w-auto min-w-[140px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lastSeen">Last seen</SelectItem>
                      <SelectItem value="name">Name</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Spacer */}
                  <div className="flex-1" />

                  {/* Count */}
                  <span className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                    {filtered.length} {filtered.length === 1 ? 'agent' : 'agents'}
                  </span>

                  {/* View toggle */}
                  <div className="flex items-center rounded-md border border-input bg-background">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        'size-8 rounded-r-none border-r border-input',
                        viewMode === 'table' && 'bg-muted',
                      )}
                      onClick={() => setAndPersistView('table')}
                      aria-label="Table view"
                      aria-pressed={viewMode === 'table'}
                    >
                      <Table2 className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn('size-8 rounded-l-none', viewMode === 'cards' && 'bg-muted')}
                      onClick={() => setAndPersistView('cards')}
                      aria-label="Card view"
                      aria-pressed={viewMode === 'cards'}
                    >
                      <LayoutGrid className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Empty filtered state */}
                {filtered.length === 0 && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No agents match your filters.
                  </div>
                )}

                {/* Roster: table or cards */}
                {viewMode === 'table' ? (
                  <TableView
                    agents={filtered}
                    grantCounts={grantCounts}
                    onSuspend={(id) => void handleSuspend(id)}
                    onResume={(id) => void handleResume(id)}
                    onDelete={setDeleteTarget}
                  />
                ) : (
                  <CardView
                    agents={filtered}
                    grantCounts={grantCounts}
                    onSuspend={(id) => void handleSuspend(id)}
                    onResume={(id) => void handleResume(id)}
                    onDelete={setDeleteTarget}
                  />
                )}
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

      {/* Delete confirm dialog */}
      {deleteTarget ? (
        <DeleteConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          agentName={deleteTarget.name}
          onConfirm={() => void handleDeleteConfirm()}
        />
      ) : null}
    </>
  );
}
