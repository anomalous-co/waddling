import Link from 'next/link';
import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { LakeScene } from '@/components/lake-scene';
import { SkyScene } from '@/components/sky-scene';
import { TrackedLink } from '@/components/tracked-link';
import { AgentCarousel } from '@/components/agent-carousel';
import { SwarmMemory } from './swarm-memory';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = {
  title: 'waddling — the agent native data lake',
  description:
    'A managed DuckDB/DuckLake lake your agents spin up, manage, and maintain themselves — no infrastructure, no glue code. They create tables, ingest, query, and remember; you govern what each one sees. Connections coming soon. Start free, 7 days, no card.',
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
              the agent native data lake · connections coming soon
            </Badge>
            <h1 className="mb-6 font-mono text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              The Agent Native Data Lake
              <br className="hidden sm:block" /> as good as its
              <span className="text-emerald-500 dark:text-emerald-400"> Quacked</span> up to be
            </h1>
            <p className="mb-8 max-w-xl text-base leading-relaxed text-muted-foreground">
              A managed DuckDB/DuckLake lake your agents spin up, manage, and
              maintain themselves — no infrastructure, no glue code. They create
              tables, ingest, query, and remember; you govern exactly what each
              one sees. Connections to your own sources coming soon.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild className={BRAND_BTN}>
                <TrackedLink
                  href={appUrl('/dashboard')}
                  location="landing_hero"
                  text="start free — 7 days, no card"
                >
                  start free — 7 days, no card →
                </TrackedLink>
              </Button>
              <Button asChild variant="outline" className="font-mono">
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

      {/* Agents that connect — infinite marquee */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <p className="mb-5 text-center font-mono text-xs uppercase tracking-wider text-muted-foreground/70">
            works with the agents you already run
          </p>
          <AgentCarousel />
        </div>
      </section>

      {/* Positioning + four-tier glance */}
      <SwarmMemory />
    </main>
  );
}

// The brand CTA keeps waddling's emerald identity (the neutral shadcn primary
// would erase it). Single source of truth so every emerald button matches.
const BRAND_BTN =
  'bg-emerald-500 font-mono font-semibold text-emerald-950 hover:bg-emerald-400';
