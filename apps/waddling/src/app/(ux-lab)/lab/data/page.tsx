'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Database, Plus, Table2, HardDrive, Bot } from 'lucide-react';
import { fetchCp } from '@/components/dashboard/fetch';
import type { DatalakeSummary } from '@/lib/types';
import type { DatalakeSummaryEnriched } from '@/app/api/cp/datalakes/route';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/waddling/page-header';
import { StatusDot } from '@/components/waddling/status-dot';
import { EmptyState } from '@/components/waddling/empty-state';
import type { SemanticStatus } from '@/components/waddling/status-dot';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map a data lake's status to a SemanticStatus for StatusDot.
 * 'running' → active; 'stopped' → suspended; others pass through.
 */
function lakeSemanticStatus(status: DatalakeSummary['status']): SemanticStatus {
  switch (status) {
    case 'running':
      return 'active';
    case 'stopped':
      return 'suspended';
    case 'provisioning':
      return 'provisioning';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// ── Lake card ─────────────────────────────────────────────────────────────────

function LakeCard({ lake }: { lake: DatalakeSummaryEnriched }) {
  const semantic = lakeSemanticStatus(lake.status);
  return (
    <Link
      href={`/lab/data/${lake.id}`}
      className={cn(
        'group flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground ring-1 ring-foreground/10 transition-shadow',
        'hover:shadow-md hover:ring-foreground/20',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      aria-label={`${lake.name} — ${semantic}`}
    >
      {/* Name + status */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div
            className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            <Database className="size-4" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium leading-snug group-hover:underline">
              {lake.name}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {lake.slug}
            </span>
          </div>
        </div>
        <StatusDot status={semantic} decorative={false} showLabel />
      </div>

      {/* Stats row */}
      <dl className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <Table2 className="size-3.5" aria-hidden="true" />
          <dt className="sr-only">Tables</dt>
          <dd>{lake.tableCount} table{lake.tableCount !== 1 ? 's' : ''}</dd>
        </div>
        <div className="flex items-center gap-1">
          <HardDrive className="size-3.5" aria-hidden="true" />
          <dt className="sr-only">Size</dt>
          <dd>{formatBytes(lake.sizeBytes)}</dd>
        </div>
        <div className="flex items-center gap-1">
          <Bot className="size-3.5" aria-hidden="true" />
          <dt className="sr-only">Agents with access</dt>
          <dd>{lake.agentCount} agent{lake.agentCount !== 1 ? 's' : ''}</dd>
        </div>
      </dl>
    </Link>
  );
}

// ── Skeleton card ─────────────────────────────────────────────────────────────

function LakeCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex flex-col gap-1">
            <Skeleton className="h-4 w-28 rounded" />
            <Skeleton className="h-3 w-20 rounded" />
          </div>
        </div>
        <Skeleton className="h-4 w-16 rounded" />
      </div>
      <div className="flex items-center gap-4">
        <Skeleton className="h-3 w-16 rounded" />
        <Skeleton className="h-3 w-12 rounded" />
        <Skeleton className="h-3 w-14 rounded" />
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Data lake index — lists all data lakes for the org.
 * Fetches from GET /api/cp/datalakes (enriched with tableCount, sizeBytes,
 * agentCount from the mock handler).
 */
export default function LabDataPage() {
  const [lakes, setLakes] = useState<DatalakeSummaryEnriched[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ datalakes: DatalakeSummaryEnriched[] }>('/api/cp/datalakes').then((res) => {
      if (!cancelled) {
        setLakes(res.ok ? res.data.datalakes : []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Data"
        description="Manage data lakes, browse catalogs, and control agent access."
        actions={
          <Button asChild size="sm">
            <Link href="/lab/data/new">
              <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
              New data lake
            </Link>
          </Button>
        }
      />

      {/* Lake grid — loading / empty / populated */}
      {lakes === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <LakeCardSkeleton />
          <LakeCardSkeleton />
        </div>
      ) : lakes.length === 0 ? (
        <EmptyState
          icon={<Database />}
          title="No data lakes yet"
          description="Create a data lake to start giving agents governed DuckDB access to your data."
          action={
            <Button asChild size="sm">
              <Link href="/lab/data/new">
                <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
                New data lake
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lakes.map((lake) => (
            <LakeCard key={lake.id} lake={lake} />
          ))}
        </div>
      )}
    </div>
  );
}
