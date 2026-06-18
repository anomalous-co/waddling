'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  Card,
  CardHeader,
  Badge,
  statusVariant,
  Spinner,
  ErrorState,
  EmptyState,
  SectionTitle,
  Table,
  Td,
} from '@/components/dashboard/ui';
import { fetchCp } from '@/components/dashboard/fetch';
import { useTheme } from 'fumadocs-ui/provider/base';
import type { EndpointSummary, AgentSummary, SessionSummary } from '@/lib/types';

// recharts neutrals styled via JS props (can't ride the CSS ramp inversion).
const CHART_DARK = { tick: '#525252', tipBg: '#171717', tipBorder: '#404040', label: '#a3a3a3' };
const CHART_LIGHT = { tick: '#78716c', tipBg: '#ffffff', tipBorder: '#d6d3d1', label: '#57534e' };

interface UsagePoint {
  ts: string;
  queries: number;
  sessions: number;
}

interface OverviewData {
  endpoints: EndpointSummary[];
  agents: AgentSummary[];
  liveSessions: SessionSummary[];
  usageSeries: UsagePoint[];
  totalQueries: number;
  totalSessions: number;
}

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
      <p className="text-xs text-neutral-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-mono font-semibold text-neutral-100 mt-1">
        {value}
      </p>
      {sub && <p className="text-xs text-neutral-600 mt-0.5">{sub}</p>}
    </Card>
  );
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { resolvedTheme } = useTheme();
  const ck = resolvedTheme === 'light' ? CHART_LIGHT : CHART_DARK;

  const load = useCallback(async () => {
    const [endRes, agentRes, sessRes, usageRes] = await Promise.all([
      fetchCp<{ endpoints: EndpointSummary[] }>('/api/cp/endpoints'),
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
      endpoints: endRes.data.endpoints,
      agents: agentRes.data.agents,
      liveSessions: sessRes.data.sessions,
      usageSeries: usageRes.data.series,
      totalQueries: usageRes.data.totalQueries,
      totalSessions: usageRes.data.totalSessions,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    // Auto-refresh every 15s
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;
  if (!data) return null;

  const runningEndpoints = data.endpoints.filter((e) => e.status === 'running').length;
  // Resolve session UUIDs → human names for the Live sessions table.
  const agentById = new Map(data.agents.map((a) => [a.id, a]));
  const endpointById = new Map(data.endpoints.map((e) => [e.id, e]));

  return (
    <div className="space-y-6">
      <SectionTitle>Overview</SectionTitle>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Endpoints"
          value={runningEndpoints}
          sub={`${data.endpoints.length} total`}
        />
        <StatCard
          label="Active agents"
          value={data.agents.filter((a) => a.status === 'active').length}
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

      {/* Sparklines */}
      <Card>
        <CardHeader title="Queries & Sessions — last 24h" />
        {data.usageSeries.length === 0 ? (
          <EmptyState title="No usage data yet" />
        ) : (
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart
              data={data.usageSeries}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="gQ" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gS" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 10, fill: ck.tick }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{
                  background: ck.tipBg,
                  border: `1px solid ${ck.tipBorder}`,
                  borderRadius: 4,
                  fontSize: 11,
                }}
                labelStyle={{ color: ck.label }}
              />
              <Area
                type="monotone"
                dataKey="queries"
                stroke="#3b82f6"
                strokeWidth={1.5}
                fill="url(#gQ)"
                dot={false}
                name="Queries"
              />
              <Area
                type="monotone"
                dataKey="sessions"
                stroke="#10b981"
                strokeWidth={1.5}
                fill="url(#gS)"
                dot={false}
                name="Sessions"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Live sessions */}
      <Card>
        <CardHeader
          title="Live sessions"
          subtitle={`${data.liveSessions.length} active`}
        />
        {data.liveSessions.length === 0 ? (
          <EmptyState title="No active sessions" description="Connect an agent to see live sessions here." />
        ) : (
          <Table headers={['Session', 'Agent', 'Owner', 'Endpoint', 'Started', 'Expires', 'Status']}>
            {data.liveSessions.map((s) => {
              const agent = agentById.get(s.agentId);
              const endpoint = endpointById.get(s.endpointId);
              return (
                <tr key={s.id}>
                  <Td>
                    <Link
                      href={`/dashboard/sessions/${s.id}`}
                      className="font-mono text-xs text-blue-400 hover:underline"
                    >
                      {`${s.sid.slice(0, 8)}…`}
                    </Link>
                  </Td>
                  <Td>
                    <Link
                      href={`/dashboard/agents/${s.agentId}`}
                      className="text-blue-400 hover:underline"
                    >
                      {agent?.name ?? `${s.agentId.slice(0, 8)}…`}
                    </Link>
                  </Td>
                  <Td className="text-neutral-400">{agent?.owner ?? '—'}</Td>
                  <Td>
                    {endpoint ? (
                      <Link
                        href={`/dashboard/endpoints/${s.endpointId}`}
                        className="text-blue-400 hover:underline"
                      >
                        {endpoint.name}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{`${s.endpointId.slice(0, 8)}…`}</span>
                    )}
                  </Td>
                  <Td>{new Date(s.startedAt).toLocaleTimeString()}</Td>
                  <Td>{new Date(s.expiresAt).toLocaleTimeString()}</Td>
                  <Td>
                    <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {/* Endpoint health */}
      <Card>
        <CardHeader title="Endpoints" />
        {data.endpoints.length === 0 ? (
          <EmptyState
            title="No endpoints yet"
            description="Provision an endpoint to start governing data access."
          />
        ) : (
          <Table headers={['Name', 'Slug', 'Status', 'Gateway']}>
            {data.endpoints.map((ep) => (
              <tr key={ep.id}>
                <Td>
                  <Link
                    href={`/dashboard/endpoints/${ep.id}`}
                    className="text-blue-400 hover:underline"
                  >
                    {ep.name}
                  </Link>
                </Td>
                <Td mono>{ep.slug}</Td>
                <Td>
                  <Badge variant={statusVariant(ep.status)}>{ep.status}</Badge>
                </Td>
                <Td mono className="text-neutral-500">
                  {ep.schemas?.join(', ') ?? '—'}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
