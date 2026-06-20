'use client';

import Link from 'next/link';
import { DuckField } from '@/components/duck-field/duck-field';
import {
  singleDuck,
  lakehouse,
  sphere,
  orbit,
  edgeBurst,
} from '@/components/duck-field/layouts';
import type { DuckSpec } from '@/components/duck-field/types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Offering {
  eyebrow: string;
  title: string;
  body: string;
  cta: { label: string; href: string };
  spec: DuckSpec;
}

// One value prop per arrangement. The DuckField spec is captured here (these are
// functions, so this must be a client component — they can't cross the
// server/client boundary as props).
const OFFERINGS: Offering[] = [
  {
    eyebrow: 'single agent',
    title: 'Analytics agents, the easy way',
    body:
      'Point one agent at your lake and let it answer questions in SQL. waddling mints a scoped session, the agent attaches over the Quack wire protocol, and every query runs under a per-agent policy — no lake credentials ever live in the agent.',
    cta: { label: 'quickstart →', href: '/docs/quickstart' },
    spec: singleDuck(),
  },
  {
    eyebrow: 'lakehouse-native',
    title: 'Govern the whole lakehouse',
    body:
      'Stack as many agents as you need on one DuckDB lakehouse. birdshot enforces table-level ACLs at the gateway and the proxy layer strips columns and caps rows. One source of truth, many agents, zero copies.',
    cta: { label: 'how it works →', href: '/docs' },
    spec: lakehouse(),
  },
  {
    eyebrow: 'durable memory',
    title: 'ContextLake: agent memory you can query',
    body:
      'Every decision, grant, and revoke is written back to your lake as structured, queryable history — not a black-box embedding. Agents and your ops team read their own trail with plain SQL.',
    cta: { label: 'explore memory →', href: '/memory' },
    spec: sphere(),
  },
  {
    eyebrow: 'fleets',
    title: 'Orchestrate a fleet around a coordinator',
    body:
      'Run a coordinator with a ring of workers, each on its own policy and TTL. Revoke any worker in milliseconds mid-task and the coordinator keeps going — scale the ring without re-minting lake credentials.',
    cta: { label: 'see the MCP tools →', href: '/docs/mcp-tools' },
    spec: orbit(),
  },
  {
    eyebrow: 'edge',
    title: 'Edge analytics that report home',
    body:
      'Push lightweight agents to the edge and let their results flow back to a central lake. Each edge agent is scoped to exactly what it needs, and the gateway records every query so the core always has the full picture.',
    cta: { label: 'read the docs →', href: '/docs' },
    spec: edgeBurst(),
  },
];

export function Offerings() {
  return (
    <>
      {OFFERINGS.map((o, i) => {
        // Alternate which half holds the animation as you scroll down.
        const animLeft = i % 2 === 1;
        return (
          <section key={o.title} className="border-t border-border">
            <div className="mx-auto grid max-w-6xl items-center gap-8 px-6 py-16 lg:grid-cols-2 lg:gap-12 lg:py-24">
              <div className={cn(animLeft && 'lg:order-2')}>
                <Badge
                  variant="outline"
                  className="mb-6 border-emerald-500/40 bg-emerald-500/10 font-mono text-emerald-600 dark:text-emerald-400"
                >
                  {o.eyebrow}
                </Badge>
                <h2 className="mb-4 font-mono text-2xl font-bold tracking-tight sm:text-3xl">
                  {o.title}
                </h2>
                <p className="mb-6 max-w-md leading-relaxed text-muted-foreground">
                  {o.body}
                </p>
                <Link
                  href={o.cta.href}
                  className="font-mono text-sm text-emerald-600 transition-colors hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
                >
                  {o.cta.label}
                </Link>
              </div>
              <div
                className={cn(
                  // Square box so the (roughly square) scenes fill the width
                  // instead of floating with side gaps in a wide container.
                  'relative aspect-square overflow-hidden rounded-lg border border-border/60',
                  animLeft && 'lg:order-1',
                )}
              >
                <DuckField spec={o.spec} className="absolute inset-0" />
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}
