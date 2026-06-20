'use client';

import { DuckField } from '@/components/duck-field/duck-field';
import { cubeLattice, singleDuck, lakehouse, sphere, orbit, edgeBurst } from '@/components/duck-field/layouts';
import type { DuckSpec } from '@/components/duck-field/types';

// Scratch page for tuning the composable duck scenes before wiring them into the
// home-page narrative. Each section mounts its own engine instance; scroll through
// to compare arrangements. Not linked from anywhere — dev only.
const SCENES: { title: string; blurb: string; spec: DuckSpec }[] = [
  { title: 'Easy analytics', blurb: 'single duck', spec: singleDuck() },
  { title: 'Lakehouse', blurb: 'stack over dithered logo, 3/4 iso', spec: lakehouse() },
  { title: 'ContextLake', blurb: 'sphere of ducks', spec: sphere() },
  { title: 'Orchestration', blurb: 'ring orbiting a big duck', spec: orbit() },
  { title: 'Edge analytics', blurb: 'rings firing edges into a big duck', spec: edgeBurst() },
  { title: 'Cube lattice (reference)', blurb: 'the original /memory scene', spec: cubeLattice() },
];

export default function DuckLabPage() {
  return (
    <main className="bg-zinc-950">
      {SCENES.map((s) => (
        <section key={s.title} className="relative h-screen border-b border-zinc-800">
          <DuckField spec={s.spec} className="absolute inset-0" />
          <div className="pointer-events-none absolute left-6 top-6 font-mono">
            <div className="text-lg font-semibold text-emerald-400">{s.title}</div>
            <div className="text-xs text-zinc-500">{s.blurb}</div>
          </div>
        </section>
      ))}
    </main>
  );
}
