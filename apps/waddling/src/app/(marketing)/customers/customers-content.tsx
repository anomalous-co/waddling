'use client';

import Link from 'next/link';
import { appUrl } from '@/lib/site';
import { GiCorkHat, GiPirateHat, GiMagicHat, GiPointyHat } from 'react-icons/gi';
import { FaHardHat } from 'react-icons/fa';
import { LakePond, type PondDuck } from '@/components/lake-pond';

interface Persona {
  name: string;
  role: string;
  does: string;
  needs: string;
  rogue?: boolean;
  /** hero duck (the user) first, then ducklings (their agents) */
  ducks: PondDuck[];
}

// Every card is the same lake, rendered with the same engine as the hero
// scene: the hero duck paddles in the top lane wearing the persona's hat, the
// ducklings (the user's agents) mill about in the lanes below.
const PERSONAS: Persona[] = [
  {
    name: 'The Pipeline Builder',
    role: 'Data / Platform Engineer',
    does: 'Wires agents into the lakehouse and ships the pipelines around them.',
    needs: 'One governed ATTACH — no lake credentials sprayed across a dozen configs.',
    ducks: [
      {
        kind: 'hero',
        body: '#7dd3fc',
        ring: '#fb7185',
        lane: 2,
        fx: 0.46,
        bobK: 2,
        ph: 0.5,
        osc: 0.05,
        oscK: 1,
        hat: { icon: FaHardHat, color: '#facc15', cells: 3.3, dy: 0.9 },
      },
      { kind: 'duckling', body: '#fbbf24', lane: 5, fx: 0.16, bobK: 3, ph: 0.7, osc: 0.18, oscK: 1 },
      { kind: 'duckling', body: '#f0abfc', lane: 6, fx: 0.72, bobK: 2, ph: 2.1, laps: 1, dir: -1 },
    ],
  },
  {
    name: 'The Model Wrangler',
    role: 'ML / AI Engineer',
    does: 'Feeds training and eval agents straight from the lake.',
    needs: 'Column- and row-scoped reads — and nothing the policy does not allow.',
    ducks: [
      {
        kind: 'hero',
        body: '#fbbf24',
        ring: '#34d399',
        lane: 2,
        fx: 0.5,
        bobK: 2,
        ph: 1,
        osc: 0.05,
        oscK: 1,
        hat: { icon: GiMagicHat, color: '#a78bfa', cells: 3.4, dy: 0.6, rotate: -6 },
      },
      { kind: 'duckling', body: '#7dd3fc', lane: 5, fx: 0.2, bobK: 3, ph: 0.4, osc: 0.16, oscK: 1.2 },
      { kind: 'duckling', body: '#bef264', lane: 6, fx: 0.7, bobK: 2, ph: 3.4, laps: 1, dir: -1 },
    ],
  },
  {
    name: 'The Lake Explorer',
    role: 'Analyst / Data Scientist',
    does: 'Roams the warehouse through a chat agent, asking questions in plain English.',
    needs: 'Table-level guardrails it cannot wander past.',
    ducks: [
      {
        kind: 'hero',
        body: '#fbbf24',
        ring: '#7dd3fc',
        lane: 2,
        fx: 0.5,
        bobK: 2,
        ph: 0.8,
        osc: 0.05,
        oscK: 1,
        hat: { icon: GiCorkHat, color: '#ca8a04', cells: 3.6, dy: 1.6, flip: true },
      },
      { kind: 'duckling', body: '#a78bfa', lane: 4, fx: 0.08, bobK: 3, ph: 0.7, laps: 1, dir: 1 },
      { kind: 'duckling', body: '#7dd3fc', lane: 5, fx: 0.25, bobK: 2, ph: 4.2, osc: 0.16, oscK: 1 },
      { kind: 'duckling', body: '#f0abfc', lane: 6, fx: 0.45, bobK: 2, ph: 1.3, laps: 2, dir: 1 },
      { kind: 'duckling', body: '#bef264', lane: 4, fx: 0.78, bobK: 5, ph: 1.3, laps: 1, dir: -1 },
      { kind: 'duckling', body: '#fdba74', lane: 5, fx: 0.65, bobK: 3, ph: 3.4, osc: 0.1, oscK: 2 },
      { kind: 'duckling', body: '#fafafa', lane: 6, fx: 0.35, bobK: 2, ph: 5.6, laps: 1, dir: -1 },
    ],
  },
  {
    name: 'The Policy Architect',
    role: 'Security / Platform Lead',
    does: 'Authors per-agent ACL policy from the dashboard or the admin MCP.',
    needs: 'Instant revoke that lands mid-query, plus a full audit trail.',
    ducks: [
      {
        kind: 'hero',
        body: '#a78bfa',
        ring: '#fbbf24',
        lane: 2,
        fx: 0.5,
        bobK: 2,
        ph: 0.3,
        osc: 0.05,
        oscK: 1,
        hat: { icon: GiPointyHat, color: '#34d399', cells: 3.2, dy: 1.1, rotate: -4, flip: true },
      },
      { kind: 'duckling', body: '#7dd3fc', lane: 4, fx: 0.15, bobK: 2, ph: 0.5, osc: 0.16, oscK: 1 },
      { kind: 'duckling', body: '#bef264', lane: 6, fx: 0.5, bobK: 3, ph: 0.7, laps: 1, dir: 1 },
      { kind: 'duckling', body: '#f0abfc', lane: 5, fx: 0.72, bobK: 2, ph: 2, laps: 1, dir: -1 },
    ],
  },
  {
    name: 'The Rogue Agent',
    role: '…the one you are guarding against',
    does: 'Slips on a pirate hat while its owner naps and reaches for customers.ssn.',
    needs: 'To be denied — and to show up in the audit log instead of your data.',
    rogue: true,
    ducks: [
      // the owner is asleep (closed eye + z's); it barely drifts
      {
        kind: 'hero',
        body: '#fbbf24',
        ring: '#f87171',
        sleeping: true,
        lane: 2,
        fx: 0.38,
        bobK: 1.5,
        ph: 0.2,
        osc: 0.02,
        oscK: 0.7,
      },
      // the rogue agent: a duckling that nicked a pirate hat
      {
        kind: 'duckling',
        body: '#bef264',
        lane: 5,
        fx: 0.6,
        bobK: 3,
        ph: 0.3,
        osc: 0.12,
        oscK: 1.2,
        hat: { icon: GiPirateHat, color: '#a1a1aa', cells: 2.8, dy: 0.9, rotate: -8 },
      },
    ],
  },
];

// The persona rows on their own — reused by /customers and the landing page's
// use-cases section. `invite` toggles the trailing "your agent here" row.
export function PersonaRows({ invite = true }: { invite?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {PERSONAS.map((p, i) => (
          <div
            key={p.name}
            className={`rounded-lg border overflow-hidden flex flex-col sm:flex-row ${
              p.rogue ? 'border-red-900/70 bg-red-950/20' : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            {/* the duck and its agents — a square lake, the height of the row */}
            <div className="relative h-44 w-full sm:h-60 sm:w-60 shrink-0">
              <LakePond seed={i + 1} size={14} ducks={p.ducks} className="h-full w-full" />
            </div>

            {/* who they are + what they do / need */}
            <div className="flex flex-1 flex-col justify-center gap-5 p-8">
              <div>
                <h3 className="font-mono font-semibold text-lg text-zinc-50">{p.name}</h3>
                <div className={`font-mono text-xs mt-1 ${p.rogue ? 'text-red-400' : 'text-emerald-400'}`}>
                  {p.role}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">
                    does
                  </div>
                  <p className="text-sm text-zinc-300 leading-relaxed">{p.does}</p>
                </div>
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">
                    needs
                  </div>
                  <p className="text-sm text-zinc-300 leading-relaxed">{p.needs}</p>
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* invitation row */}
        {invite ? (
          <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
            <div>
              <div className="font-mono text-zinc-300">your agent here</div>
              <p className="text-sm text-zinc-500 mt-1">
                Bring your own duck. Free tier is 1 endpoint, 2 agents, full audit — no card required.
              </p>
            </div>
            <Link
              href={appUrl('/dashboard')}
              className="shrink-0 bg-emerald-500 hover:bg-emerald-400 text-[#0c0a09] font-mono font-semibold text-sm px-5 py-2.5 rounded transition-colors"
            >
              start free →
            </Link>
          </div>
        ) : null}
      </div>
  );
}

export function CustomersContent() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <div className="text-center mb-16">
        <h1 className="text-4xl font-mono font-bold text-zinc-50 mb-4">who waddling is for</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          Every team putting agents on their lakehouse — and the one agent you would rather keep on a
          short leash. Same ducks, different hats.
        </p>
      </div>

      <PersonaRows />

      <div className="mt-16 text-center">
        <p className="text-zinc-500 text-sm font-mono">
          not sure which duck you are?{' '}
          <Link href="/docs/quickstart" className="text-zinc-300 hover:text-zinc-50 transition-colors">
            try the quickstart
          </Link>{' '}
          or{' '}
          <Link href="/pricing" className="text-zinc-300 hover:text-zinc-50 transition-colors">
            see pricing
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
