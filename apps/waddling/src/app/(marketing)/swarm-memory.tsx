'use client';

import { DuckField } from '@/components/duck-field/duck-field';
import { sphere } from '@/components/duck-field/layouts';
import { appUrl } from '@/lib/site';
import { TrackedLink } from '@/components/tracked-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// sphere() returns functions, so the spec has to be built on the client —
// it can't cross the server/client boundary as a prop.
const SPEC = sphere();

const BULLETS = [
  'Agents self-serve — they spin up a lake, create tables, and load data with plain SQL, no provisioning',
  'Runs itself — no clusters, no glue code, no ops; the lake scales and maintains itself in the background',
  'Agents remember — what they loaded, how your tables work, what they learned last session',
  'Governed by default — dynamic per-agent ACLs on columns, rows, and time windows, with instant revoke',
  'Metered compute — pick a size from Duckling to Swan, billed per-second, no infrastructure to run',
  'Connections coming soon — point the lake at your own sources and let agents query them in place',
];

// Four-tier glance. Copy is hardcoded to stay decoupled from the PLANS schema
// rewrite happening in parallel — this teaser links out to /pricing for detail.
const TIERS = [
  { name: 'Free', price: '$0', note: '7-day trial · no card' },
  { name: 'Pro', price: '$29', note: '3 seats · 2 lakes' },
  { name: 'Max', price: '$99', note: '10 seats · admin MCP' },
  { name: 'Scale', price: '$299', note: 'uncapped · SSO' },
];

export function SwarmMemory() {
  return (
    <section className="border-t border-border">
      <div className="mx-auto grid max-w-6xl items-center gap-8 px-6 py-16 lg:grid-cols-2 lg:gap-12 lg:py-24">
        <div>
          <Badge
            variant="outline"
            className="mb-6 border-emerald-500/40 bg-emerald-500/10 font-mono text-emerald-600 dark:text-emerald-400"
          >
            the agent native data lake
          </Badge>
          <h2 className="mb-4 font-mono text-2xl font-bold tracking-tight sm:text-3xl">
            A lake your agents run themselves.
          </h2>
          <p className="mb-6 max-w-md leading-relaxed text-muted-foreground">
            A managed DuckDB/DuckLake lake built for agents to set up, manage, and
            maintain on their own — they create tables, ingest, query, and
            remember in plain SQL. No infrastructure, no glue code. You govern
            exactly what each one can see, down to the column, row, and time
            window. Connections to your own sources coming soon.
          </p>
          <ul className="mb-8 max-w-md space-y-3">
            {BULLETS.map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-sm">
                <span className="mt-0.5 shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                  ✓
                </span>
                <span className="text-muted-foreground">{b}</span>
              </li>
            ))}
          </ul>

          {/* Four tiers at a glance */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {TIERS.map((t) => (
              <div
                key={t.name}
                className="rounded-lg border border-border/60 bg-emerald-500/[0.03] px-3 py-3"
              >
                <div className="font-mono text-sm font-bold">{t.name}</div>
                <div className="font-mono text-lg font-bold text-emerald-600 dark:text-emerald-400">
                  {t.price}
                </div>
                <div className="font-mono text-[11px] leading-tight text-muted-foreground">
                  {t.note}
                </div>
              </div>
            ))}
          </div>
          <p className="mb-6 font-mono text-xs text-muted-foreground">
            Base subscription + included storage & compute envelope + metered usage.
          </p>

          <Button
            asChild
            size="lg"
            className="bg-emerald-500 font-mono font-semibold text-emerald-950 hover:bg-emerald-400"
          >
            <TrackedLink
              href={appUrl('/dashboard')}
              location="landing_swarm_memory"
              text="start free — 7 days, no card"
            >
              start free — 7 days, no card →
            </TrackedLink>
          </Button>
        </div>
        <div className="relative aspect-square overflow-hidden rounded-lg border border-border/60">
          <DuckField spec={SPEC} className="absolute inset-0" />
        </div>
      </div>
    </section>
  );
}
