'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import { RefreshCw } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';
import type {
  DatalakeSummary,
  AgentSummary,
  SessionSummary,
} from '@/lib/types';

// ── Reference patterns ────────────────────────────────────────────────────────
// This page is the canonical example every other dashboard view follows:
//   • Card stat tiles · shadcn Chart (themed via CSS vars) · shadcn Table
//   • StatusBadge for lifecycle words · Skeleton while loading · Alert on error
//   • Empty for empty states · Promise.all (no fetch waterfall) · 15s refresh
// ──────────────────────────────────────────────────────────────────────────────

interface UsagePoint {
  ts: string;
  queries: number;
  sessions: number;
}

interface OverviewData {
  datalakes: DatalakeSummary[];
  agents: AgentSummary[];
  liveSessions: SessionSummary[];
  usageSeries: UsagePoint[];
  totalQueries: number;
  totalSessions: number;
}

const chartConfig = {
  queries: { label: 'Queries', color: 'var(--chart-1)' },
  sessions: { label: 'Sessions', color: 'var(--chart-2)' },
} satisfies ChartConfig;

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="uppercase tracking-wider">
          {label}
        </CardDescription>
        <CardTitle className="font-mono text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {sub ? (
        <CardContent>
          <p className="text-xs text-muted-foreground">{sub}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function shortTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [endRes, agentRes, sessRes, usageRes] = await Promise.all([
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ sessions: SessionSummary[] }>('/api/cp/sessions?status=active'),
      fetchCp<{ series: UsagePoint[]; totalQueries: number; totalSessions: number }>(
        '/api/cp/usage?period=24h',
      ),
    ]);

    if (!endRes.ok || !agentRes.ok || !sessRes.ok || !usageRes.ok) {
      setError('Failed to load overview data');
      setLoading(false);
      return;
    }

    setData({
      datalakes: endRes.data.datalakes,
      agents: agentRes.data.agents,
      liveSessions: sessRes.data.sessions,
      usageSeries: usageRes.data.series ?? [],
      totalQueries: usageRes.data.totalQueries ?? 0,
      totalSessions: usageRes.data.totalSessions ?? 0,
    });
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <OverviewSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn’t load the dashboard</AlertTitle>
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

  if (!data) return null;

  const runningDatalakes = data.datalakes.filter(
    (e) => e.status === 'running',
  ).length;
  const activeAgents = data.agents.filter((a) => a.status === 'active').length;
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const datalakeById = new Map(data.datalakes.map((e) => [e.id, e]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Live health across your data lakes, agents, and sessions.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Data Lakes"
          value={runningDatalakes}
          sub={`${data.datalakes.length} total`}
        />
        <StatCard
          label="Active agents"
          value={activeAgents}
          sub={`${data.agents.length} total`}
        />
        <StatCard
          label="Live sessions"
          value={data.liveSessions.length}
          sub="right now"
        />
        <StatCard
          label="Queries 24h"
          value={data.totalQueries.toLocaleString()}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Queries &amp; sessions</CardTitle>
          <CardDescription>Last 24 hours</CardDescription>
        </CardHeader>
        <CardContent>
          {data.usageSeries.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No usage data yet</EmptyTitle>
                <EmptyDescription>
                  Connect an agent and run a query to see activity here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ChartContainer config={chartConfig} className="h-[160px] w-full">
              <AreaChart data={data.usageSeries} margin={{ left: 0, right: 0 }}>
                <defs>
                  <linearGradient id="fillQueries" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-queries)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-queries)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="fillSessions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-sessions)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-sessions)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="ts"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={shortTime}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => shortTime(String(value))}
                    />
                  }
                />
                <Area
                  dataKey="queries"
                  type="monotone"
                  stroke="var(--color-queries)"
                  fill="url(#fillQueries)"
                  strokeWidth={2}
                />
                <Area
                  dataKey="sessions"
                  type="monotone"
                  stroke="var(--color-sessions)"
                  fill="url(#fillSessions)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live sessions</CardTitle>
          <CardDescription>{data.liveSessions.length} active</CardDescription>
        </CardHeader>
        <CardContent>
          {data.liveSessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No active sessions</EmptyTitle>
                <EmptyDescription>
                  Connect an agent to see live sessions here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Data Lake</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.liveSessions.map((s) => {
                  const agent = agentById.get(s.agentId);
                  const datalake = datalakeById.get(s.datalakeId);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">
                        {`${s.sid.slice(0, 8)}…`}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/dashboard/agents/${s.agentId}`}
                          className="text-primary hover:underline"
                        >
                          {agent?.name ?? `${s.agentId.slice(0, 8)}…`}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {datalake ? (
                          <Link
                            href={`/dashboard/datalakes/${s.datalakeId}`}
                            className="text-primary hover:underline"
                          >
                            {datalake.name}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs">
                            {`${s.datalakeId.slice(0, 8)}…`}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(s.startedAt).toLocaleTimeString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(s.expiresAt).toLocaleTimeString()}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={s.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data Lakes</CardTitle>
          <CardDescription>{data.datalakes.length} configured</CardDescription>
        </CardHeader>
        <CardContent>
          {data.datalakes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No data lakes yet</EmptyTitle>
                <EmptyDescription>
                  Provision a data lake to start governing data access.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.datalakes.map((dl) => (
                  <TableRow key={dl.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/datalakes/${dl.id}`}
                        className="text-primary hover:underline"
                      >
                        {dl.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {dl.slug}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={dl.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
