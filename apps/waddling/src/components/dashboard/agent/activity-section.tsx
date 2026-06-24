'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';
import { SectionHeader } from '@/components/dashboard/agent/kit';
import type { AuditEventRow } from '@/lib/types';

/** Format an ISO timestamp as a relative string, e.g. "3m ago", "2h ago". */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function ActivitySection({ agentId }: { agentId: string }) {
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchCp<{ events: AuditEventRow[]; total: number }>(
      `/api/cp/audit?agentId=${agentId}`,
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      setEvents(res.data.events ?? []);
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pt-1">
        <SectionHeader title="Activity" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <SectionHeader title="Activity" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <SectionHeader
        title="Activity"
        action={
          events.length > 0 ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {events.length} event{events.length !== 1 ? 's' : ''}
            </span>
          ) : undefined
        }
      />

      {events.length === 0 ? (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyTitle>No activity yet</EmptyTitle>
            <EmptyDescription>
              This agent has no recorded activity yet. Query events and access
              decisions will appear here once the agent starts connecting.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {events.map((ev) => (
            <div key={ev.id} className="flex items-start gap-3 py-2">
              {/* Timestamp */}
              <span className="w-14 shrink-0 tabular-nums text-xs text-muted-foreground">
                {relativeTime(ev.ts)}
              </span>

              {/* Event + source */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{ev.event}</span>
                {ev.source ? (
                  <span className="text-xs text-muted-foreground">{ev.source}</span>
                ) : null}
                {ev.query ? (
                  <code className="mt-0.5 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {ev.query}
                  </code>
                ) : null}
                {ev.reason ? (
                  <span className="text-xs text-muted-foreground">{ev.reason}</span>
                ) : null}
              </div>

              {/* Decision badge (only when present) */}
              {ev.decision ? (
                <div className="shrink-0">
                  <StatusBadge status={ev.decision} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
