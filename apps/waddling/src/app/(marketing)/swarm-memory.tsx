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
  'Agents self-serve — spin up a lake and load data in plain SQL',
  'Runs itself — no clusters, no glue code, no ops',
  'Agents remember across sessions',
  'Governed by default — per-agent ACLs, instant revoke',
  'Metered compute, billed per-second',
  'Connections coming soon',
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
            Agents set up, run, and remember in a managed DuckLake — governed
            per-agent, no infrastructure.
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
            Base subscription + metered usage.
          </p>

          <Button
            asChild
            size="lg"
            className="rounded-none bg-emerald-500 px-7 font-mono text-base font-bold tracking-tight text-emerald-950 shadow-[0_0_30px_-6px_var(--color-emerald-500)] ring-1 ring-emerald-600/50 transition-all hover:bg-emerald-600 hover:text-emerald-50 hover:shadow-[0_0_40px_-4px_var(--color-emerald-600)]"
          >
            <TrackedLink
              href={appUrl('/dashboard')}
              location="landing_swarm_memory"
              text="start free"
            >
              Start free →
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
