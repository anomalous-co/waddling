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
  'Your data, your lake — agents ingest and ELT into a corpus you own, in plain SQL, no black-box embeddings',
  'Agents remember — what they loaded, how your tables work, what they learned last session',
  'Per-agent access control with instant revoke — governance is built in, not bolted on',
  'Fully managed — we run the lake, your agents connect with one config block',
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
            waddling Swarm Memory
          </Badge>
          <h2 className="mb-4 font-mono text-2xl font-bold tracking-tight sm:text-3xl">
            One lake. Every agent remembers.
          </h2>
          <p className="mb-6 max-w-md leading-relaxed text-muted-foreground">
            Your agents each wake up empty. Swarm Memory is a personal data
            lake you own and they remember — every dataset they ingest, every
            result they compute, every fact they learn lands in your tables,
            queryable in the next session and the one after that.
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
          <div className="mb-6 flex items-baseline gap-3">
            <span className="font-mono text-4xl font-bold">$15</span>
            <span className="font-mono text-sm text-muted-foreground">
              / month · first 3 days free · cancel anytime
            </span>
          </div>
          <Button
            asChild
            size="lg"
            className="bg-emerald-500 font-mono font-semibold text-emerald-950 hover:bg-emerald-400"
          >
            <TrackedLink
              href={appUrl('/dashboard')}
              location="landing_swarm_memory"
              text="get Swarm Memory"
            >
              get Swarm Memory →
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
