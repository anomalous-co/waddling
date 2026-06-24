'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/dashboard/status';
import { SectionHeader } from '@/components/dashboard/agent/kit';
import { fetchCp } from '@/components/dashboard/fetch';
import type { AgentSummary } from '@/lib/types';

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

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  );
}

export function OverviewSection({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetchCp<{ agent: AgentSummary }>(`/api/cp/agents/${agentId}`);
    if (!res.ok) {
      setError(res.error);
    } else {
      setAgent(res.data.agent);
      setError(null);
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <SectionHeader title="Overview" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <SectionHeader title="Overview" />
        <div className="flex items-center gap-2 text-sm text-destructive">
          {error ?? 'Could not load agent.'}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <SectionHeader title="Overview" />

      <div className="divide-y divide-border">
        <InfoRow label="ID">
          <code className="font-mono text-xs text-muted-foreground">{agent.id}</code>
        </InfoRow>
        <InfoRow label="Status">
          <StatusBadge status={agent.status} />
        </InfoRow>
        <InfoRow label="Mode">
          <StatusBadge status={agent.mode} />
        </InfoRow>
        <InfoRow label="Default role">
          <code className="font-mono text-xs">{agent.defaultRole}</code>
        </InfoRow>
        {agent.owner ? (
          <InfoRow label="Owner">
            <span className="text-sm">{agent.owner}</span>
          </InfoRow>
        ) : null}
        {agent.lastSeenAt ? (
          <InfoRow label="Last seen">
            <span className="tabular-nums text-sm text-muted-foreground">
              {formatRelative(agent.lastSeenAt)}
            </span>
          </InfoRow>
        ) : (
          <InfoRow label="Last seen">
            <span className="text-sm text-muted-foreground">Never</span>
          </InfoRow>
        )}
        {agent.description ? (
          <InfoRow label="Description">
            <span className="text-sm text-muted-foreground">{agent.description}</span>
          </InfoRow>
        ) : null}
      </div>

      {/* Swarm membership — roadmap placeholder */}
      <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Swarm membership
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Not in any swarm yet.{' '}
          <span className="text-xs text-muted-foreground/60">(Swarms coming soon)</span>
        </p>
      </div>
    </div>
  );
}
