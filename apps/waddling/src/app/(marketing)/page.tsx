import Link from 'next/link';
import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { LakeScene } from '@/components/lake-scene';
import { SkyScene } from '@/components/sky-scene';
import { TrackedLink } from '@/components/tracked-link';
import { AgentCarousel } from '@/components/agent-carousel';
import { McpConnect } from '@/components/mcp-connect';
import { SwarmMemory } from './swarm-memory';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'waddling — the agent native data lake',
  description:
    'A managed lake your agents set up and run themselves. Governed per-agent, no infrastructure. Connections coming soon. Start free, 7 days, no card.',
};

export default function LandingPage() {
  return (
    <main className="text-foreground">
      {/* Hero — copy + CTA overlay a full-viewport backdrop: the ASCII sky up
          top, the lake pinned as a band at the very bottom. Both are absolute
          so the content (incl. the MCP picker) floats ABOVE them and never
          shoves the lake down the page. */}
      <section className="relative flex min-h-[100svh] flex-col overflow-hidden">
        {/* ASCII sky (drifting clouds, night stars) behind the hero copy,
            stopping where the lake band begins below */}
        <SkyScene className="absolute inset-x-0 top-0 bottom-[340px] lg:bottom-[420px]" />
        {/* the scene gets its own full-width band, pinned to the bottom edge */}
        <div className="absolute inset-x-0 bottom-0 h-[340px] overflow-hidden lg:h-[420px]" aria-hidden>
          <LakeScene className="absolute inset-0" />
        </div>
        <div className="relative z-10 mx-auto w-full max-w-6xl px-6 pt-12 pb-4 lg:pt-16">
          <div className="max-w-2xl">
            <h1 className="mb-6 font-mono text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              The Agent Native Data Lake as good as its
              <span className="text-emerald-500 dark:text-emerald-400"> Quacked</span> up to be
            </h1>
            <p className="mb-8 max-w-xl text-base leading-relaxed text-muted-foreground">
              A managed lake your agents set up and run themselves. Connections
              coming soon.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className={BRAND_BTN}>
                <TrackedLink
                  href={appUrl('/dashboard')}
                  location="landing_hero"
                  text="start free"
                >
                  Start free →
                </TrackedLink>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-none font-mono">
                <Link href="/docs">docs</Link>
              </Button>
            </div>

            {/* Drop the waddling MCP into your agent — pick your agent, copy, go */}
            <McpConnect className="mt-8 max-w-xl" />
          </div>
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
// NB: this repo REMAPS the emerald ramp (emerald-500 is the brand #10b981,
// higher numbers are BRIGHTER, emerald-950 is near-white) — so hover→600 is a
// lighten. Hard right-angle corners + a ring + glow so it reads on the dark hero.
const BRAND_BTN =
  'rounded-none bg-emerald-500 px-7 font-mono text-base font-bold tracking-tight text-emerald-950 ' +
  'shadow-[0_0_30px_-6px_var(--color-emerald-500)] ring-1 ring-emerald-600/50 ' +
  'transition-all hover:bg-emerald-600 hover:text-emerald-50 hover:shadow-[0_0_40px_-4px_var(--color-emerald-600)]';
