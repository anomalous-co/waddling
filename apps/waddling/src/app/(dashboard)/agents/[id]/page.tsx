'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronLeft,
  Clock,
  EllipsisVertical,
  RefreshCw,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBreadcrumbLabel } from '@/components/dashboard/breadcrumb-context';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { fetchCp, cpPatch, cpDelete } from '@/components/dashboard/fetch';
import { GrantsSection } from '@/components/dashboard/agent/grants-section';
import { OverviewSection } from '@/components/dashboard/agent/overview-section';
import { KeysSection } from '@/components/dashboard/agent/keys-section';
import { SessionsSection } from '@/components/dashboard/agent/sessions-section';
import { ActivitySection } from '@/components/dashboard/agent/activity-section';
import { ConnectDialog } from '@/components/dashboard/agent/connect-dialog';
import { DetailLayout, type DetailSection } from '@/components/waddling/detail-layout';
import { ModeChip } from '@/components/waddling/agent-chips';
import { agentSemanticStatus, formatRelative } from '@/components/waddling/agent-status';
import { SectionCard } from '@/components/waddling/section-card';
import { EmptyState } from '@/components/waddling/empty-state';
import { formatBytes } from '@/lib/format';
import type { AgentSummary } from '@/lib/types';
import type { QbMemoryEntry } from './types';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  id: string;
  name?: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface AgentDetailEnvelope {
  agent: AgentSummary & { apiKeys?: ApiKeyRow[] };
  apiKeys?: ApiKeyRow[];
}

// ── Memory section ───────────────────────────────────────────────────────────────
// Private agent_memory, surfaced read-only for oversight. The control-api memory
// endpoint is not wired in production yet — a failed fetch (e.g. 404) resolves to
// an empty list and renders the EmptyState, never an error.

function MemorySection({ agentId }: { agentId: string }) {
  const [entries, setEntries] = useState<QbMemoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ entries: QbMemoryEntry[] }>(`/api/cp/agents/${agentId}/memory`).then((res) => {
      if (cancelled) return;
      setEntries(res.ok ? res.data.entries : []);
    });
    return () => {
      cancelled = true;
    };
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
    <SectionCard title="Agent memory" headingLevel={2}>
      <p className="text-xs text-muted-foreground">
        Private to this agent — shown for oversight, not editable.
      </p>
      <ul className="mt-4 flex flex-col divide-y divide-border">
        {entries.map((mem) => (
          <li key={mem.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <code className="font-mono text-sm font-medium text-foreground">{mem.key}</code>
              <span className="text-xs text-muted-foreground">
                updated {formatRelative(mem.updatedAt)}
              </span>
              <span className="text-xs text-muted-foreground">{formatBytes(mem.sizeBytes)}</span>
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

// ── Loading skeleton ────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48 rounded-lg" />
          <Skeleton className="h-4 w-64 rounded-lg" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-9" />
        </div>
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

// ── Page ────────────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  // ?section= deep-links jump to a section (handled natively by DetailLayout).

  // Page-level agent data
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [keyCount, setKeyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const agentId = params.id;

  // Feed the agent's name to the top-navbar breadcrumb (Agents › <name>).
  useBreadcrumbLabel(agentId, agent?.name);

  const load = useCallback(async () => {
    const agentRes = await fetchCp<AgentDetailEnvelope>(`/api/cp/agents/${agentId}`);

    if (!agentRes.ok) {
      setError(agentRes.error);
      setLoading(false);
      return;
    }

    // Dual-envelope defensiveness (same pattern as the old page)
    const data = agentRes.data;
    const agentData = data.agent;
    const apiKeys: ApiKeyRow[] =
      (data as { apiKeys?: ApiKeyRow[] }).apiKeys ?? agentData?.apiKeys ?? [];

    setAgent(agentData);
    setKeyCount(apiKeys.length);
    setError(null);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSuspendResume = async () => {
    if (!agent) return;
    const newStatus = agent.status === 'active' ? 'suspended' : 'active';
    setSuspending(true);
    const res = await cpPatch<{ ok: boolean }>(`/api/cp/agents/${agentId}`, { status: newStatus });
    setSuspending(false);
    if (res.ok) {
      toast.success(newStatus === 'suspended' ? 'Agent suspended' : 'Agent resumed');
      // Optimistic update, then re-fetch
      setAgent((a) => (a ? { ...a, status: newStatus } : a));
      void load();
    } else {
      toast.error(`Failed: ${res.error}`);
    }
  };

  const handleDelete = async () => {
    if (!agent) return;
    setDeleting(true);
    const res = await cpDelete<{ ok: boolean }>(`/api/cp/agents/${agentId}`);
    setDeleting(false);
    if (res.ok) {
      toast.success(`Agent "${agent.name}" deleted`);
      setDeleteOpen(false);
      router.push('/agents');
    } else {
      toast.error(`Failed to delete agent: ${res.error}`);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return <PageSkeleton />;

  if (error || !agent) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load agent</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error ?? 'Agent not found.'}
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

  const isActive = agent.status === 'active';
  const isSuspended = agent.status === 'suspended';

  // ── Section registry ─────────────────────────────────────────────────────────
  // Each section's content is a real, self-fetching capability module (prop
  // contract `{ agentId }`), so the sub-rail stays a thin presentation layer.
  const sections: DetailSection[] = [
    {
      id: 'overview',
      label: 'Overview',
      content: <OverviewSection agentId={agentId} />,
    },
    {
      id: 'access',
      label: 'Access',
      // The literal GRANT/DENY SQL governing this key — the headline surface.
      content: <GrantsSection agentId={agentId} />,
    },
    {
      id: 'keys',
      label: 'Keys',
      badge: keyCount > 0 ? keyCount : undefined,
      content: <KeysSection agentId={agentId} />,
    },
    {
      id: 'sessions',
      label: 'Sessions',
      badge:
        agent.activeSessions && agent.activeSessions > 0 ? agent.activeSessions : undefined,
      content: <SessionsSection agentId={agentId} />,
    },
    {
      id: 'memory',
      label: 'Memory',
      content: <MemorySection agentId={agentId} />,
    },
    {
      id: 'activity',
      label: 'Activity',
      content: <ActivitySection agentId={agentId} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DetailLayout
        title={agent.name}
        status={agentSemanticStatus(agent)}
        defaultSection="overview"
        meta={
          <>
            <span className="flex items-center gap-1">
              <User className="size-3.5" aria-hidden="true" />
              {agent.owner ?? 'No owner'}
            </span>
            <ModeChip mode={agent.mode} />
            {agent.lastSeenAt ? (
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" aria-hidden="true" />
                {formatRelative(agent.lastSeenAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">never seen</span>
            )}
            <Link
              href="/agents"
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
            <Button variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
              Connect
            </Button>

            {isActive ? (
              <Button
                variant="outline"
                size="sm"
                disabled={suspending}
                onClick={() => void handleSuspendResume()}
              >
                {suspending ? 'Suspending…' : 'Suspend'}
              </Button>
            ) : isSuspended ? (
              <Button
                variant="outline"
                size="sm"
                disabled={suspending}
                onClick={() => void handleSuspendResume()}
              >
                {suspending ? 'Resuming…' : 'Resume'}
              </Button>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label="More actions">
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="whitespace-nowrap text-destructive focus:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        sections={sections}
      />

      {/* Connect dialog */}
      <ConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        agentId={agentId}
        agentName={agent.name}
      />

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent</DialogTitle>
            <DialogDescription>
              This will permanently delete{' '}
              <span className="font-mono font-medium text-foreground">{agent.name}</span> and kill
              all active sessions. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Separator />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              <Trash2 data-icon="inline-start" />
              {deleting ? 'Deleting…' : 'Delete agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
