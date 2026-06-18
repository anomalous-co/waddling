'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  Card,
  CardHeader,
  Badge,
  Spinner,
  ErrorState,
  EmptyState,
  SectionTitle,
  Select,
  Label,
} from '@/components/dashboard/ui';
import { fetchCp } from '@/components/dashboard/fetch';
import { useTheme } from 'fumadocs-ui/provider/base';
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
];

function MetricCard({
  label,
  value,
  sub,
  quota,
}: {
  label: string;
  value: string | number;
  sub?: string;
  quota?: number;
}) {
  const pct =
    quota && typeof value === 'number'
      ? Math.min(100, Math.round((value / quota) * 100))
      : null;

  return (
    <Card>
      <p className="text-xs text-neutral-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-mono font-semibold text-neutral-100 mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {sub && <p className="text-xs text-neutral-600 mt-0.5">{sub}</p>}
      {pct !== null && (
        <div className="mt-2">
          <div className="h-1 rounded bg-neutral-800 overflow-hidden">
            <div
              className={[
                'h-full rounded transition-all',
                pct > 90
                  ? 'bg-red-500'
                  : pct > 70
                    ? 'bg-yellow-500'
                    : 'bg-blue-500',
              ].join(' ')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-neutral-600 mt-0.5">
            {pct}% of plan quota
          </p>
        </div>
      )}
    </Card>
  );
}

// recharts styles via JS props, not CSS, so it can't ride the ramp inversion —
// resolve the neutral chart chrome per theme here. The data bars keep their hue
// in both themes.
const CHART_DARK = { grid: '#262626', tick: '#525252', tipBg: '#171717', tipBorder: '#404040', label: '#a3a3a3', legend: '#737373' };
const CHART_LIGHT = { grid: '#e7e5e4', tick: '#78716c', tipBg: '#ffffff', tipBorder: '#d6d3d1', label: '#57534e', legend: '#57534e' };

export default function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState('30d');
  const { resolvedTheme } = useTheme();
  const ck = resolvedTheme === 'light' ? CHART_LIGHT : CHART_DARK;

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      const res = await fetchCp<UsageResponse>(`/api/cp/usage?period=${p}`);
      if (!res.ok) {
        setError(res.error);
      } else {
        setData(res.data);
        setError(null);
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    void load(period);
  }, [load, period]);

  return (
    <div className="space-y-4">
      <SectionTitle>Usage</SectionTitle>

      {/* Period selector */}
      <div className="flex items-center gap-3">
        <Label htmlFor="period">Period</Label>
        <div className="w-48">
          <Select
            id="period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
        {loading && <Spinner size="sm" />}
      </div>

      {error && <ErrorState message={error} retry={() => void load(period)} />}

      {!loading && data && (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Total queries"
              value={data.rollup.queries}
              quota={data.planQuotaQueries}
            />
            <MetricCard
              label="Rows scanned"
              value={data.rollup.rowsScanned}
              sub={`${(data.rollup.bytesScanned / 1_048_576).toFixed(1)} MB`}
            />
            <MetricCard
              label="Active sessions"
              value={data.rollup.activeSessions}
            />
            {data.rollup.estimatedCost !== undefined && (
              <MetricCard
                label="Est. cost"
                value={`$${data.rollup.estimatedCost.toFixed(2)}`}
              />
            )}
          </div>

          {/* Plan badge */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Plan:</span>
            <Badge variant="blue">{data.planName}</Badge>
          </div>

          {/* Charts */}
          <Card>
            <CardHeader title="Queries over time" />
            {data.series.length === 0 ? (
              <EmptyState title="No data for this period" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={data.series}
                  margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={ck.grid} />
                  <XAxis
                    dataKey="ts"
                    tick={{ fontSize: 10, fill: ck.tick }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: ck.tick }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: ck.tipBg,
                      border: `1px solid ${ck.tipBorder}`,
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                    labelStyle={{ color: ck.label }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: ck.legend }}
                  />
                  <Bar dataKey="queries" fill="#3b82f6" name="Queries" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="sessions" fill="#10b981" name="Sessions" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          {/* Rows scanned chart */}
          <Card>
            <CardHeader title="Rows scanned over time" />
            {data.series.length === 0 ? (
              <EmptyState title="No data for this period" />
            ) : (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart
                  data={data.series}
                  margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={ck.grid} />
                  <XAxis
                    dataKey="ts"
                    tick={{ fontSize: 10, fill: ck.tick }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: ck.tick }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: ck.tipBg,
                      border: `1px solid ${ck.tipBorder}`,
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                    labelStyle={{ color: ck.label }}
                  />
                  <Bar
                    dataKey="rowsScanned"
                    fill="#8b5cf6"
                    name="Rows scanned"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
