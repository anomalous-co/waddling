import Link from 'next/link';
import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { LakeScene } from '@/components/lake-scene';
import { SkyScene } from '@/components/sky-scene';
import { TrackedLink } from '@/components/tracked-link';
import { SwarmMemory } from './swarm-memory';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'waddling — your personal data store',
  description:
    'waddling Swarm Memory: a personal data store you own, that your agents remember how to use. Ingest, query, and grow your own corpus — managed, governed, $15/mo.',
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
              Swarm Memory · managed data lake — $15/mo
            </Badge>
            <h1 className="mb-6 font-mono text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Agent Analytics as good as
              <br className="hidden sm:block" /> its Quacked
              <span className="text-emerald-500 dark:text-emerald-400"> up to be</span>
            </h1>
            <p className="mb-8 max-w-xl text-base leading-relaxed text-muted-foreground">
              Your personal data store — a managed lake you own, that your
              agents remember how to use. They ingest, query, and grow your
              corpus session after session. No infrastructure to run.
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

      {/* The one offer: Swarm Memory at $15/mo */}
      <SwarmMemory />

      {/* Setup — a single config block is the whole integration */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-12">
            <div>
              <h2 className="mb-4 font-mono text-2xl font-bold tracking-tight sm:text-3xl">
                Set up in one config block
              </h2>
              <p className="mb-6 max-w-md leading-relaxed text-muted-foreground">
                Paste this into your MCP host config and every agent in the
                swarm shares the same lake. waddling handles auth, sessions,
                and per-agent policy — your agents never see a credential.
              </p>
              <Link
                href="/docs/quickstart"
                className="font-mono text-sm text-emerald-600 transition-colors hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
              >
                full quickstart guide →
              </Link>
            </div>
            <Card className="gap-0 overflow-hidden py-0">
              <div className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
                .mcp.json — remote server, nothing to install
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-xs text-muted-foreground">
                {`{
  "mcpServers": {
    "waddling": {
      "type": "http",
      "url": "https://api.getwaddling.com/mcp",
      "headers": { "Authorization": "Bearer sk_agent_…" }
    }
  }
}

// or one line in Claude Code:
// claude mcp add --transport http waddling \\
//   https://api.getwaddling.com/mcp \\
//   --header "Authorization: Bearer sk_agent_…"`}
              </pre>
            </Card>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="mb-4 font-mono text-3xl font-bold">
            your agents forget everything.
            <span className="text-emerald-500 dark:text-emerald-400"> fix that for $15.</span>
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-muted-foreground">
            Swarm Memory is one managed data lake your whole swarm reads,
            writes, and remembers in. Set up in minutes, cancel anytime.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Button asChild size="lg" className={BRAND_BTN}>
              <TrackedLink
                href={appUrl('/dashboard')}
                location="landing_footer"
                text="start free — 3 days, then $15/mo"
              >
                start free — 3 days, then $15/mo
              </TrackedLink>
            </Button>
            <Button asChild size="lg" variant="outline" className="font-mono">
              <TrackedLink href="/pricing" location="landing_footer" text="see pricing">
                see pricing
              </TrackedLink>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

// The brand CTA keeps waddling's emerald identity (the neutral shadcn primary
// would erase it). Single source of truth so every emerald button matches.
const BRAND_BTN =
  'bg-emerald-500 font-mono font-semibold text-emerald-950 hover:bg-emerald-400';
