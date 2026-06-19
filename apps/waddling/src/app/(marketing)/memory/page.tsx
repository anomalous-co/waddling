import Link from 'next/link';
import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { DuckScene } from '@/components/duck-scene';
import { SingleDuckScene } from '@/components/single-duck-scene';

export const metadata: Metadata = {
  title: 'Distributed Agent Memory — waddling',
  description:
    'Every query, every grant, every revoke — durable agent memory distributed across your lakehouse. Powered by waddling\'s audit engine.',
};

export default function MemoryPage() {
  return (
    <main>
      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="border-b border-zinc-800">
        {/* Desktop: full grid background with CTA overlay */}
        <div className="hidden lg:block relative overflow-hidden h-[1100px]">
          <DuckScene />
          <div className="absolute inset-0 flex items-center pointer-events-none">
            <div className="mx-auto max-w-6xl w-full px-6">
              <div className="max-w-xl pointer-events-auto bg-zinc-950/80 backdrop-blur-sm rounded-lg border border-zinc-800 p-8">
                <MemoryCTA />
              </div>
            </div>
          </div>
        </div>

      </section>

      {/* Mobile: CTA section + duck cube below */}
      <section className="lg:hidden border-b border-zinc-800">
        <div className="px-6 pt-16 pb-10">
          <div className="max-w-xl">
            <MemoryCTA />
          </div>
        </div>
        <div className="h-[500px] border-t border-zinc-800">
          <SingleDuckScene />
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section className="border-b border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-xl font-mono font-semibold text-zinc-50 mb-3">
            distributed analytics, durable memory
          </h2>
          <p className="text-zinc-400 mb-12 max-w-2xl">
            Agent memory isn&apos;t a vector embedding — it&apos;s the full audit trail of every
            decision your agents made, queryable in seconds.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <MemoryCard
              number="01"
              title="Distributed Audit"
              color="emerald"
              body="Every auth decision, query, grant, and revoke is durably written to your lakehouse. No separate audit DB — waddling writes to the same DuckDB tables your agents query, with column-level ACLs so only admins can read the audit schema."
              snippet={`-- query the full history
SELECT agent_id, decision, table_name,
       reason, ts
FROM waddling_audit. decisions
WHERE agent_id = 'analyst'
  AND ts > now() - INTERVAL '7 days'
ORDER BY ts DESC
LIMIT 100`}
            />
            <MemoryCard
              number="02"
              title="Agent Memory"
              color="blue"
              body="Each agent leaves a searchable trail: what they queried, when they were granted access, when they were denied, and why. This is the durable memory your operations team needs — not a black-box embedding, but structured, queryable audit data."
              snippet={`-- what did this agent do last Tuesday?
waddling_admin_audit({
  agent_id: "support-bot",
  decision: "allow",
  since: "2026-06-10T00:00:00Z",
  until: "2026-06-10T23:59:59Z"
})
// → 47 allowed queries across 12 tables`}
            />
            <MemoryCard
              number="03"
              title="Live Telemetry"
              color="red"
              body="The audit stream is live — decisions appear on the dashboard in milliseconds. Set up alerts on deny spikes, query anomalies, or off-hours access. Your SOC can react before the agent gets its next token."
              snippet={`-- real-time deny-rate alert
CREATE METRIC deny_rate
ON waddling_audit.decisions
WHERE decision = 'deny'
AGGREGATE count() EVERY 1m
ALERT IF value > 5
  → PagerDuty, Slack, webhook`}
            />
          </div>
        </div>
      </section>

      {/* ── Architecture diagram (textual) ─────────────────────────────── */}
      <section className="border-b border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-xl font-mono font-semibold text-zinc-50 mb-4">
            the memory pipeline
          </h2>
          <p className="text-zinc-400 mb-10 max-w-2xl">
            Five stages from agent query to durable audit record — all in your lakehouse, all under your ACLs.
          </p>

          <div className="space-y-4 font-mono text-sm">
            {[
              { step: '1', label: 'Agent queries via MCP', detail: 'Agent sends SQL through the waddling MCP server. The gateway intercepts before DuckDB.', color: 'text-emerald-400', border: 'border-emerald-900', bg: 'bg-emerald-950/20' },
              { step: '2', label: 'birdshot denylist check', detail: 'In-memory check against revoked agents/sessions. Deny in ~15ms if matched.', color: 'text-red-400', border: 'border-red-900', bg: 'bg-red-950/20' },
              { step: '3', label: 'ACL enforcement', detail: 'Column allow-list, row limit, schema scope applied. Deny reason recorded.', color: 'text-amber-400', border: 'border-amber-900', bg: 'bg-amber-950/20' },
              { step: '4', label: 'Query execution', detail: 'DuckDB runs the governed query. Results streamed back through the gateway.', color: 'text-blue-400', border: 'border-blue-900', bg: 'bg-blue-950/20' },
              { step: '5', label: 'Audit write', detail: 'Decision (allow/deny), query fingerprint, agent ID, timestamp written to waddling_audit schema.', color: 'text-purple-400', border: 'border-purple-900', bg: 'bg-purple-950/20' },
            ].map((s) => (
              <div key={s.step} className={`flex items-start gap-4 rounded-lg border ${s.border} ${s.bg} p-4`}>
                <span className={`font-bold text-lg ${s.color} w-8 shrink-0`}>{s.step}</span>
                <div>
                  <div className={`font-semibold ${s.color} mb-1`}>{s.label}</div>
                  <div className="text-zinc-400 text-xs leading-relaxed">{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stats ─────────────────────────────────────────────────────── */}
      <section className="border-b border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 grid grid-cols-1 md:grid-cols-3 gap-10">
            <Stat number="∞" label="retention" sub="lakehouse-native — keep audit data as long as you keep the lake" />
            <Stat number="~2ms" label="audit write latency" sub="appended to DuckDB in the same transaction" />
            <Stat number="5 dimensions" label="queryable by" sub="agent, decision, table, column, time range" />
          </div>
        </div>
      </section>

      {/* ── Code block: analytics query ────────────────────────────────── */}
      <section className="border-b border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-xl font-mono font-semibold text-zinc-50 mb-4">
            distributed analytics, one SQL query
          </h2>
          <p className="text-zinc-400 mb-8 max-w-2xl">
            Because the audit trail is in your DuckDB lakehouse, you can join it with your business data.
            No ETL, no separate warehouse — just SQL.
          </p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-800 font-mono text-xs text-zinc-500">
              analytics.sql — join audit trail with business data
            </div>
            <pre className="p-4 font-mono text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap">{`-- Which agents accessed PII columns this week?
SELECT
  a.agent_id,
  a.table_name,
  a.column_name,
  a.ts,
  a.reason
FROM waddling_audit.column_decisions a
JOIN lake.governance.pii_columns p
  ON a.table_name = p.table_name
 AND a.column_name = p.column_name
WHERE a.decision = 'allow'
  AND a.ts > now() - INTERVAL '7 days'
ORDER BY a.ts DESC;

-- Result: 12 agents touched PII, 4 were denied,
-- 8 allowed (all with row_limit ≤ 100)`}</pre>
          </div>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section>
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="text-3xl font-mono font-bold text-zinc-50 mb-4">
            give your agents durable memory
          </h2>
          <p className="text-zinc-400 mb-8 max-w-xl mx-auto">
            Audit trail included on every plan. Free tier: 1 endpoint, 2 agents, 90-day retention.
          </p>
          <div className="flex justify-center gap-4 flex-wrap">
            <Link
              href={appUrl('/dashboard')}
              className="bg-emerald-500 hover:bg-emerald-400 text-[#0c0a09] font-mono font-semibold px-6 py-3 rounded transition-colors"
            >
              start free
            </Link>
            <Link
              href="/docs/telemetry"
              className="border border-zinc-700 text-zinc-300 hover:text-zinc-50 hover:border-zinc-500 font-mono px-6 py-3 rounded transition-colors"
            >
              telemetry docs →
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

/* ── sub-components ──────────────────────────────────────────────────── */

type CardColor = 'emerald' | 'red' | 'blue';

const cardColors: Record<CardColor, { accent: string; border: string; bg: string }> = {
  emerald: { accent: 'text-emerald-400', border: 'border-emerald-900', bg: 'bg-emerald-950/30' },
  red: { accent: 'text-red-400', border: 'border-red-900', bg: 'bg-red-950/30' },
  blue: { accent: 'text-blue-400', border: 'border-blue-900', bg: 'bg-blue-950/30' },
};

function MemoryCard({ number, title, color, body, snippet }: {
  number: string; title: string; color: CardColor; body: string; snippet: string;
}) {
  const c = cardColors[color];
  return (
    <div className={`rounded-lg border ${c.border} ${c.bg} p-6 flex flex-col gap-4`}>
      <div className="flex items-center gap-3">
        <span className={`font-mono text-xs ${c.accent}`}>{number}</span>
        <h3 className={`font-mono font-semibold ${c.accent} text-lg`}>{title}</h3>
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed">{body}</p>
      <pre className="text-xs font-mono bg-zinc-950/60 rounded p-3 overflow-x-auto text-zinc-300 whitespace-pre-wrap border border-zinc-800 mt-auto">
        {snippet}
      </pre>
    </div>
  );
}

function MemoryCTA() {
  return (
    <>
      <div className="inline-block font-mono text-xs text-emerald-400 border border-emerald-900 bg-emerald-950/40 rounded px-2 py-1 mb-6">
        distributed analytics &middot; agent memory
      </div>
      <h1 className="text-4xl sm:text-5xl font-bold text-zinc-50 leading-tight tracking-tight mb-4 font-mono">
        Every agent leaves<br className="hidden sm:block" /> a trace.
        <span className="text-emerald-400"> Remember it.</span>
      </h1>
      <p className="text-zinc-400 text-base leading-relaxed max-w-lg mb-6">
        Every query, grant, and revoke is recorded into a distributed audit log on your lakehouse — durable agent memory you can query with SQL.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/docs/telemetry"
          className="bg-emerald-500 hover:bg-emerald-400 text-[#0c0a09] font-mono font-semibold px-5 py-2.5 rounded transition-colors text-sm"
        >
          explore telemetry →
        </Link>
        <Link
          href="/docs/quickstart"
          className="border border-zinc-700 text-zinc-300 hover:text-zinc-50 hover:border-zinc-500 font-mono px-5 py-2.5 rounded transition-colors text-sm"
        >
          quickstart
        </Link>
      </div>
    </>
  );
}

function Stat({ number, label, sub }: { number: string; label: string; sub: string }) {
  return (
    <div className="text-center">
      <div className="text-4xl font-mono font-bold text-zinc-50 mb-1">{number}</div>
      <div className="text-sm font-semibold text-zinc-200 mb-1">{label}</div>
      <div className="text-xs text-zinc-500 font-mono">{sub}</div>
    </div>
  );
}
