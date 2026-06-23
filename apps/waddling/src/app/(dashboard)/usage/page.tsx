'use client';

import { useEffect, useState, useCallback } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { RefreshCw } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { fetchCp } from '@/components/dashboard/fetch';
import type { UsageRollup } from '@/lib/types';

interface UsageSeries {
  ts: string;
  queries: number;
  rowsScanned: number;
  sessions: number;
}

interface UsageResponse {
  rollup: UsageRollup;
  series: UsageSeries[];
  planName: string;
  planQuotaQueries?: number;
}

const PERIODS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
] as const;

const chartConfig = {
  queries: { label: 'Queries', color: 'var(--chart-1)' },
  sessions: { label: 'Sessions', color: 'var(--chart-2)' },
  rowsScanned: { label: 'Rows scanned', color: 'var(--chart-3)' },
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

function QuotaBar({ value, quota }: { value: number; quota: number }) {
  const pct = Math.min(100, Math.round((value / quota) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {pct}% of {quota.toLocaleString()} query plan quota
      </p>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-52 w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}

function formatTs(ts: string, unit: 'hour' | 'day'): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return unit === 'hour'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('30d');

  const unit = period === '24h' ? 'hour' : 'day';

  const load = useCallback(async (p: string) => {
    setLoading(true);
    const res = await fetchCp<UsageResponse>(`/api/cp/usage?period=${p}`);
    if (!res.ok) {
      setError(res.error);
    } else {
      setData(res.data);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  if (loading) return <UsageSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load usage data</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              void load(period);
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
          <p className="text-sm text-muted-foreground">
            Query volume, data scanned, and session activity for your org.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={period}
            onValueChange={(v) => setPeriod(v as '24h' | '7d' | '30d')}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {data ? (
        <>
          {/* Plan badge */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Plan</span>
            <Badge variant="secondary">{data.planName}</Badge>
          </div>

          {/* Metric stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            <StatCard
              label="Queries"
              value={data.rollup.queries.toLocaleString()}
            />
            <StatCard
              label="Rows scanned"
              value={data.rollup.rowsScanned.toLocaleString()}
            />
            <StatCard
              label="Bytes scanned"
              value={`${(data.rollup.bytesScanned / 1_048_576).toFixed(1)} MB`}
            />
            <StatCard
              label="Active sessions"
              value={data.rollup.activeSessions.toLocaleString()}
            />
            <StatCard
              label="Est. cost"
              value={
                data.rollup.estimatedCost !== undefined
                  ? `$${data.rollup.estimatedCost.toFixed(2)}`
                  : '—'
              }
            />
          </div>

          {/* Quota progress — only when the plan provides a quota ceiling */}
          {data.planQuotaQueries ? (
            <Card>
              <CardHeader>
                <CardTitle>Query quota</CardTitle>
                <CardDescription>
                  {data.rollup.queries.toLocaleString()} of{' '}
                  {data.planQuotaQueries.toLocaleString()} queries used
                </CardDescription>
              </CardHeader>
              <CardContent>
                <QuotaBar
                  value={data.rollup.queries}
                  quota={data.planQuotaQueries}
                />
              </CardContent>
            </Card>
          ) : null}

          {/* Queries + sessions area chart */}
          <Card>
            <CardHeader>
              <CardTitle>Queries &amp; sessions</CardTitle>
              <CardDescription>
                {PERIODS.find((p) => p.value === period)?.label}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.series.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No usage data for this period</EmptyTitle>
                    <EmptyDescription>
                      Connect an agent and run a query to see activity here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ChartContainer config={chartConfig} className="h-[180px] w-full">
                  <LineChart
                    data={data.series}
                    margin={{ left: 0, right: 0, top: 12, bottom: 0 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="ts"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={(v) => formatTs(String(v), unit)}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(value) =>
                            formatTs(String(value), unit)
                          }
                        />
                      }
                    />
                    <Line
                      dataKey="queries"
                      type="monotone"
                      stroke="var(--color-queries)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      dataKey="sessions"
                      type="monotone"
                      stroke="var(--color-sessions)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          {/* Rows scanned bar chart (separate — scale differs from queries/sessions) */}
          <Card>
            <CardHeader>
              <CardTitle>Rows scanned</CardTitle>
              <CardDescription>
                {PERIODS.find((p) => p.value === period)?.label}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.series.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No data for this period</EmptyTitle>
                    <EmptyDescription>
                      Run queries against a data lake to see rows-scanned here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ChartContainer
                  config={chartConfig}
                  className="h-[160px] w-full"
                >
                  <BarChart
                    data={data.series}
                    margin={{ left: 0, right: 0, top: 12, bottom: 0 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="ts"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={(v) => formatTs(String(v), unit)}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      width={48}
                      tickFormatter={(v: number) =>
                        v >= 1_000_000
                          ? `${(v / 1_000_000).toFixed(1)}M`
                          : v >= 1000
                            ? `${(v / 1000).toFixed(0)}k`
                            : String(v)
                      }
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          labelFormatter={(value) =>
                            formatTs(String(value), unit)
                          }
                        />
                      }
                    />
                    <Bar
                      dataKey="rowsScanned"
                      fill="var(--color-rowsScanned)"
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
