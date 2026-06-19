import Link from 'next/link';
import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { LakeScene } from '@/components/lake-scene';
import { SkyScene } from '@/components/sky-scene';
import { PersonaRows } from './customers/customers-content';

export const metadata: Metadata = {
  title: 'waddling — Give your agents the lake, not the keys',
  description:
    'Dynamic ACLs for AI agents on your lakehouse. Per-agent policies, instant revoke, full audit — enforced at the DuckDB gateway.',
};

export default function LandingPage() {
  return (
    <main>
      {/* Hero — text block, then the ASCII lake scene as a full-width band
          below the call to action (same layout at every breakpoint). */}
      <section className="relative">
        {/* ASCII sky (drifting clouds, night stars) behind the hero copy,
            stopping where the lake band begins below */}
        <SkyScene className="absolute inset-x-0 top-0 bottom-[340px] lg:bottom-[420px]" />
        <div className="relative z-10 mx-auto max-w-6xl px-6 pt-16 lg:pt-24 pb-4">
          <div className="max-w-2xl">
            <div className="inline-block font-mono text-xs text-emerald-400 border border-emerald-900 bg-emerald-950/40 rounded px-2 py-1 mb-6">
              now in beta · dynamic ACL for AI agents
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-zinc-50 leading-tight tracking-tight mb-6 font-mono">
              Agent Analytics as good as<br className="hidden sm:block" /> its Quacked
              <span className="text-emerald-400"> up to be</span>
            </h1>
            <p className="text-zinc-400 text-base leading-relaxed max-w-xl mb-8">
              Per-agent ACL policies enforced at the DuckDB gateway. Grant tables, columns, and rows — revoke any agent in milliseconds, mid-query.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/docs/quickstart"
                className="bg-emerald-500 hover:bg-emerald-400 text-[#0c0a09] font-mono font-semibold px-5 py-2.5 rounded transition-colors text-sm"
              >
                quickstart →
              </Link>
              <Link
                href="/docs"
                className="border border-zinc-700 text-zinc-300 hover:text-zinc-50 hover:border-zinc-500 font-mono px-5 py-2.5 rounded transition-colors text-sm"
              >
                read the docs
              </Link>
            </div>
          </div>
        </div>
        {/* the scene gets its own full-width band; the sky flows straight into
            it, so no top fade */}
        <div className="relative h-[340px] lg:h-[420px] overflow-hidden">
          <LakeScene className="absolute inset-0" />
        </div>
      </section>

      {/* Three pillars */}
      <section className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-xl font-mono font-semibold text-zinc-50 mb-12 text-center">
            three properties that matter for agents in production
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <PillarCard
              number="01"
              title="Dynamic ACL"
              color="emerald"
              body="Per-agent policies: allow/deny by table, column allow-list, row limit, time window, or absolute TTL. Change any rule from the dashboard or via the admin MCP — the gateway enforces the new policy on the next query."
              snippet={`-- admin MCP, no restart required
waddling_admin_grant({
  agent_id: "analyst",
  schema: "sales", table: "customers",
  columns: ["id", "name", "email"],
  verb: "read", row_limit: 1000
})`}
            />
            <PillarCard
              number="02"
              title="Instant Revoke"
              color="red"
              body="Kill any agent's access in milliseconds. birdshot's in-memory denylist is hit on the very next query — no token expiry wait, no cache flush. The agent gets a structured error it can report to the human operator."
              snippet={`-- instant — next query denied
waddling_admin_revoke_agent({
  agent_id: "etl-bot",
  reason: "off-hours activity"
})
// → { ok: true, sessions_killed: 1,
//     next_query: "authorization_denied" }`}
            />
            <PillarCard
              number="03"
              title="Total Audit"
              color="blue"
              body="Every auth decision, query, grant, and revoke is durably recorded. Streamed live to the dashboard, queryable via the admin MCP. Audit retention is 90 days on Pro, 1 year on Enterprise."
              snippet={`waddling_admin_audit({
  agent_id: "analyst",
  decision: "deny",
  since: "2026-06-12T00:00:00Z"
})
// returns: [{ts, event, table,
//   reason: "column not in allow-list",
//   query: "SELECT ssn FROM ..."}]`}
            />
          </div>
        </div>
      </section>

      {/* Use cases — the persona lakes */}
      <section className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="text-xl font-mono font-semibold text-zinc-50 mb-3">use cases</h2>
            <p className="text-zinc-400 max-w-xl mx-auto">
              Every team putting agents on their lakehouse — and the one agent you would rather keep
              on a short leash. Same ducks, different hats.
            </p>
          </div>
          <PersonaRows invite={false} />
          <div className="mt-10 text-center">
            <Link
              href="/customers"
              className="font-mono text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              see who waddling is for →
            </Link>
          </div>
        </div>
      </section>

      {/* How it works — code */}
      <section className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-xl font-mono font-semibold text-zinc-50 mb-4">
            one config block, zero lake credentials in your agent
          </h2>
          <p className="text-zinc-400 mb-10 max-w-2xl">
            Add waddling to your MCP host config. The server handles auth, session minting, and the
            governed ATTACH. Your agent never sees a lake credential.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <CodeBlock
              label="claude_desktop_config.json"
              code={`{
  "mcpServers": {
    "waddling": {
      "command": "npx",
      "args": ["-y", "@waddling/mcp@latest"],
      "env": {
        "WADDLING_API_KEY": "sk_agent_…",
        "WADDLING_URL": "https://app.getwaddling.com"
      }
    }
  }
}`}
            />
            <CodeBlock
              label="what the agent runs in its DuckDB"
              code={`-- waddling_connect returns this literal SQL:
ATTACH 'quack:gw.getwaddling.com:9500'
  AS lake
  (TOKEN '<session_jwt>', DISABLE_SSL false);

-- Then the agent queries normally:
SELECT id, name, revenue
FROM lake.sales.orders
WHERE region = 'EMEA'
LIMIT 500;

-- Column ssn would be stripped by the
-- gateway proxy before it ever reaches DuckDB`}
            />
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/docs/quickstart"
              className="font-mono text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              full quickstart guide →
            </Link>
            <Link
              href="/docs/mcp-tools"
              className="font-mono text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              all 18 MCP tools →
            </Link>
          </div>
        </div>
      </section>

      {/* Social proof / callout */}
      <section className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 grid grid-cols-1 md:grid-cols-3 gap-10">
            <Stat number="18" label="governed MCP tools" sub="8 data-plane + 10 admin" />
            <Stat number="~15ms" label="revocation latency" sub="birdshot in-memory denylist" />
            <Stat number="5 layers" label="layered enforcement" sub="birdshot + proxy + session JWT" />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="text-3xl font-mono font-bold text-zinc-50 mb-4">
            ready to govern your agents?
          </h2>
          <p className="text-zinc-400 mb-8 max-w-xl mx-auto">
            Free tier includes 1 endpoint, 2 agents, and full audit. No credit card required.
          </p>
          <div className="flex justify-center gap-4 flex-wrap">
            <Link
              href={appUrl('/dashboard')}
              className="bg-emerald-500 hover:bg-emerald-400 text-[#0c0a09] font-mono font-semibold px-6 py-3 rounded transition-colors"
            >
              start free
            </Link>
            <Link
              href="/pricing"
              className="border border-zinc-700 text-zinc-300 hover:text-zinc-50 hover:border-zinc-500 font-mono px-6 py-3 rounded transition-colors"
            >
              see pricing
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

/* ── sub-components ──────────────────────────────────────────────── */

type PillarColor = 'emerald' | 'red' | 'blue';

interface PillarCardProps {
  number: string;
  title: string;
  color: PillarColor;
  body: string;
  snippet: string;
}

const colorMap: Record<PillarColor, { accent: string; border: string; bg: string }> = {
  emerald: { accent: 'text-emerald-400', border: 'border-emerald-900', bg: 'bg-emerald-950/30' },
  red: { accent: 'text-red-400', border: 'border-red-900', bg: 'bg-red-950/30' },
  blue: { accent: 'text-blue-400', border: 'border-blue-900', bg: 'bg-blue-950/30' },
};

function PillarCard({ number, title, color, body, snippet }: PillarCardProps) {
  const c = colorMap[color];
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

interface CodeBlockProps {
  label: string;
  code: string;
}

function CodeBlock({ label, code }: CodeBlockProps) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800 font-mono text-xs text-zinc-500">
        {label}
      </div>
      <pre className="p-4 font-mono text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap">
        {code}
      </pre>
    </div>
  );
}

interface StatProps {
  number: string;
  label: string;
  sub: string;
}

function Stat({ number, label, sub }: StatProps) {
  return (
    <div className="text-center">
      <div className="text-4xl font-mono font-bold text-zinc-50 mb-1">{number}</div>
      <div className="text-sm font-semibold text-zinc-200 mb-1">{label}</div>
      <div className="text-xs text-zinc-500 font-mono">{sub}</div>
    </div>
  );
}
