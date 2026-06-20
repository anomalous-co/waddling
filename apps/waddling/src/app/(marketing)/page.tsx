import Link from 'next/link';
import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { LakeScene } from '@/components/lake-scene';
import { SkyScene } from '@/components/sky-scene';
import { Offerings } from './offerings';
import { PersonaRows } from './customers/customers-content';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'waddling — Give your agents the lake, not the keys',
  description:
    'Dynamic ACLs for AI agents on your lakehouse. Per-agent policies, instant revoke, full audit — enforced at the DuckDB gateway.',
};

export default function LandingPage() {
  return (
    <main className="text-foreground">
      {/* Hero — text block, then the ASCII lake scene as a full-width band
          below the call to action (same layout at every breakpoint). */}
      <section className="relative">
        {/* ASCII sky (drifting clouds, night stars) behind the hero copy,
            stopping where the lake band begins below */}
        <SkyScene className="absolute inset-x-0 top-0 bottom-[340px] lg:bottom-[420px]" />
        <div className="relative z-10 mx-auto max-w-6xl px-6 pt-16 pb-4 lg:pt-24">
          <div className="max-w-2xl">
            <Badge
              variant="outline"
              className="mb-6 border-emerald-500/40 bg-emerald-500/10 font-mono text-emerald-600 dark:text-emerald-400"
            >
              now in beta · dynamic ACL for AI agents
            </Badge>
            <h1 className="mb-6 font-mono text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Agent Analytics as good as
              <br className="hidden sm:block" /> its Quacked
              <span className="text-emerald-500 dark:text-emerald-400"> up to be</span>
            </h1>
            <p className="mb-8 max-w-xl text-base leading-relaxed text-muted-foreground">
              Per-agent ACL policies enforced at the DuckDB gateway. Grant
              tables, columns, and rows — revoke any agent in milliseconds,
              mid-query.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild className={BRAND_BTN}>
                <Link href="/docs/quickstart">quickstart →</Link>
              </Button>
              <Button asChild variant="outline" className="font-mono">
                <Link href="/docs">read the docs</Link>
              </Button>
            </div>
          </div>
        </div>
        {/* the scene gets its own full-width band; the sky flows straight into
            it, so no top fade */}
        <div className="relative h-[340px] overflow-hidden lg:h-[420px]">
          <LakeScene className="absolute inset-0" />
        </div>
      </section>

      {/* Offerings — one value prop per scene, animation side alternating */}
      <Offerings />

      {/* Three pillars */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="mb-12 text-center font-mono text-xl font-semibold">
            three properties that matter for agents in production
          </h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
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
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mb-12 text-center">
            <h2 className="mb-3 font-mono text-xl font-semibold">use cases</h2>
            <p className="mx-auto max-w-xl text-muted-foreground">
              Every team putting agents on their lakehouse — and the one agent
              you would rather keep on a short leash. Same ducks, different hats.
            </p>
          </div>
          <PersonaRows invite={false} />
          <div className="mt-10 text-center">
            <Link
              href="/customers"
              className="font-mono text-sm text-emerald-600 transition-colors hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              see who waddling is for →
            </Link>
          </div>
        </div>
      </section>

      {/* How it works — code */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="mb-4 font-mono text-xl font-semibold">
            one config block, zero lake credentials in your agent
          </h2>
          <p className="mb-10 max-w-2xl text-muted-foreground">
            Add waddling to your MCP host config. The server handles auth,
            session minting, and the governed ATTACH. Your agent never sees a
            lake credential.
          </p>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <CodeCard
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
            <CodeCard
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
              className="font-mono text-sm text-emerald-600 transition-colors hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              full quickstart guide →
            </Link>
            <Link
              href="/docs/mcp-tools"
              className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              all 18 MCP tools →
            </Link>
          </div>
        </div>
      </section>

      {/* Social proof / callout */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Card>
            <CardContent className="grid grid-cols-1 gap-10 py-8 md:grid-cols-3">
              <Stat
                number="18"
                label="governed MCP tools"
                sub="8 data-plane + 10 admin"
              />
              <Stat
                number="~15ms"
                label="revocation latency"
                sub="birdshot in-memory denylist"
              />
              <Stat
                number="5 layers"
                label="layered enforcement"
                sub="birdshot + proxy + session JWT"
              />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="mb-4 font-mono text-3xl font-bold">
            ready to govern your agents?
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-muted-foreground">
            Free tier includes 1 data lake, 2 agents, and full audit. No credit
            card required.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Button asChild size="lg" className={BRAND_BTN}>
              <Link href={appUrl('/dashboard')}>start free</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="font-mono">
              <Link href="/pricing">see pricing</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

/* ── sub-components ──────────────────────────────────────────────── */

// The brand CTA keeps waddling's emerald identity (the neutral shadcn primary
// would erase it). Single source of truth so every emerald button matches.
const BRAND_BTN =
  'bg-emerald-500 font-mono font-semibold text-emerald-950 hover:bg-emerald-400';

type PillarColor = 'emerald' | 'red' | 'blue';

interface PillarCardProps {
  number: string;
  title: string;
  color: PillarColor;
  body: string;
  snippet: string;
}

const colorMap: Record<PillarColor, { accent: string; ring: string }> = {
  emerald: {
    accent: 'text-emerald-600 dark:text-emerald-400',
    ring: 'border-emerald-500/30',
  },
  red: {
    accent: 'text-red-600 dark:text-red-400',
    ring: 'border-red-500/30',
  },
  blue: {
    accent: 'text-blue-600 dark:text-blue-400',
    ring: 'border-blue-500/30',
  },
};

function PillarCard({ number, title, color, body, snippet }: PillarCardProps) {
  const c = colorMap[color];
  return (
    <Card className={cn('flex flex-col', c.ring)}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className={cn('font-mono text-xs', c.accent)}>{number}</span>
          <CardTitle className={cn('font-mono text-lg', c.accent)}>
            {title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        <pre className="mt-auto overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
          {snippet}
        </pre>
      </CardContent>
    </Card>
  );
}

function CodeCard({ label, code }: { label: string; code: string }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
        {label}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-xs text-muted-foreground">
        {code}
      </pre>
    </Card>
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
      <div className="mb-1 font-mono text-4xl font-bold">{number}</div>
      <div className="mb-1 text-sm font-semibold">{label}</div>
      <div className="font-mono text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
