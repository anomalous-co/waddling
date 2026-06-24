'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Info,
  KeyRound,
  EllipsisVertical,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
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
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPatch, cpDelete } from '@/components/dashboard/fetch';
import { AgentAccess } from '@/components/dashboard/agent-access';
import { AccessEditorDialog } from '@/components/dashboard/access-editor-dialog';
import {
  NoAccessBanner,
  WorkspacePanel,
  needsAccess,
  type AgentSection,
} from '@/components/dashboard/agent/kit';
import { OverviewSection } from '@/components/dashboard/agent/overview-section';
import { KeysSection } from '@/components/dashboard/agent/keys-section';
import { SessionsSection } from '@/components/dashboard/agent/sessions-section';
import { ActivitySection } from '@/components/dashboard/agent/activity-section';
import { ConnectDialog } from '@/components/dashboard/agent/connect-dialog';
import type { AgentSummary } from '@/lib/types';

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

interface AclRuleRow {
  id: string;
  capability: string;
}

// ── Access section wrapper (reuses AgentAccess as-is, no rail-in-rail) ─────────

function AccessSectionBody({ agentId }: { agentId: string }) {
  // AgentAccess renders its own <Card> + fetches its own data + opens the editor.
  // We render it inside the WorkspacePanel ScrollArea; intentional per the spec:
  // "Access section reuses AgentAccess (read-only + existing dialog)."
  return <AgentAccess agentId={agentId} />;
}

// ── Loading skeleton ────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-36" />
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-20" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <Skeleton className="h-[70vh] w-full" />
    </div>
  );
}

// ── Relative time helper ────────────────────────────────────────────────────────

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  // Page-level agent data
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [keyCount, setKeyCount] = useState(0);
  const [grantCount, setGrantCount] = useState(0);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [grantEditorOpen, setGrantEditorOpen] = useState(false);

  const agentId = params.id;

  // Feed the agent's name to the top-navbar breadcrumb (Agents › <name>).
  useBreadcrumbLabel(agentId, agent?.name);

  const load = useCallback(async () => {
    const [agentRes, aclRes, polRes, lakesRes] = await Promise.all([
      fetchCp<AgentDetailEnvelope>(`/api/cp/agents/${agentId}`),
      fetchCp<{ rules: AclRuleRow[] }>(`/api/cp/acl?agentId=${agentId}`),
      fetchCp<{ policies: { id: string }[] }>(`/api/cp/acl-policy?agentId=${agentId}`),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
    ]);

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

    if (aclRes.ok && polRes.ok) {
      const filteredRules = aclRes.data.rules.filter((r) => r.capability);
      setGrantCount(filteredRules.length + polRes.data.policies.length);
    }

    if (lakesRes.ok) {
      setDatalakes(lakesRes.data.datalakes.map((d) => ({ id: d.id, name: d.name })));
    }

    setLoading(false);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const handleSuspendResume = async () => {
    if (!agent) return;
    const newStatus = agent.status === 'active' ? 'suspended' : 'active';
    setSuspending(true);
    const res = await cpPatch<{ ok: boolean }>(`/api/cp/agents/${agentId}`, { status: newStatus });
    setSuspending(false);
    if (res.ok) {
      toast.success(newStatus === 'suspended' ? 'Agent suspended' : 'Agent resumed');
      // Optimistic update, then re-fetch
      setAgent((a) => a ? { ...a, status: newStatus } : a);
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

  // ── Section registry ─────────────────────────────────────────────────────────

  const sections: AgentSection[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: Info,
      Component: OverviewSection,
    },
    {
      id: 'access',
      label: 'Access',
      icon: ShieldCheck,
      Component: AccessSectionBody,
    },
    {
      id: 'keys',
      label: 'Keys',
      icon: KeyRound,
      badge: keyCount > 0 ? keyCount : null,
      Component: KeysSection,
    },
    {
      id: 'sessions',
      label: 'Sessions',
      icon: Radio,
      Component: SessionsSection,
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: ScrollText,
      Component: ActivitySection,
    },
  ];

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

  const showBanner = needsAccess(agent.status, grantCount);
  const isActive = agent.status === 'active';
  const isSuspended = agent.status === 'suspended';

  return (
    // Bound the page to the viewport (below the sticky header + page padding) so the
    // section content area — not the page — is what scrolls, consistently for every
    // section. Header + banner are auto-height; the panel region takes the rest.
    <div className="flex min-h-0 flex-col gap-4 h-[calc(100vh-var(--header-height)-3rem)]">
      {/* Header (breadcrumb lives in the top navbar — see useBreadcrumbLabel below) */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <StatusBadge status={agent.status} />
            <StatusBadge status={agent.mode} />
          </div>
          {agent.lastSeenAt ? (
            <p className="text-sm text-muted-foreground">
              last seen {formatRelative(agent.lastSeenAt)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">never seen</p>
          )}
        </div>

        {/* Header actions */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConnectOpen(true)}
          >
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

          {/* ⋯ menu — Delete */}
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
        </div>
      </div>

      {/* No-access banner (shown only when: active + 0 grants, only after data loaded) */}
      {showBanner && (
        <NoAccessBanner
          action={
            <Button
              size="sm"
              onClick={() => setGrantEditorOpen(true)}
              disabled={datalakes.length === 0}
            >
              Grant access
            </Button>
          }
        />
      )}

      {/* Workspace panel — the canonical frame; fills remaining height so its
          inner ScrollArea (not the page) scrolls the active section. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePanel
          sections={sections}
          agentId={agentId}
          className="flex-1"
        />
      </div>

      {/* Connect dialog */}
      <ConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        agentId={agentId}
        agentName={agent.name}
      />

      {/* Grant access dialog (banner CTA → opens AccessEditorDialog directly) */}
      {grantEditorOpen && (
        <AccessEditorDialog
          mode="edit"
          open={grantEditorOpen}
          onOpenChange={setGrantEditorOpen}
          datalakes={datalakes}
          agentId={agentId}
          onSaved={() => {
            void load();
          }}
        />
      )}

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent</DialogTitle>
            <DialogDescription>
              This will permanently delete{' '}
              <span className="font-mono font-medium text-foreground">
                {agent.name}
              </span>{' '}
              and kill all active sessions. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Separator />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              <Trash2 data-icon="inline-start" />
              {deleting ? 'Deleting…' : 'Delete agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
