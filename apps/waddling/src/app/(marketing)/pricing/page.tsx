import type { Metadata } from 'next';
import { appUrl } from '@/lib/site';
import { TrackedLink } from '@/components/tracked-link';

// Display copy is hardcoded on purpose: the PLANS schema is being rewritten in
// parallel and its field names are in flux, so the marketing surface depends
// only on these literals — never on PLANS.find(...) — to stay decoupled.

export const metadata: Metadata = {
  title: 'Pricing — waddling',
  description:
    'A governed agent data lake with dynamic, per-user access control. Free 7-day trial, no card. Then Pro $29, Max $99, or Scale $299/mo — base subscription + an included storage & compute envelope + metered usage.',
};

// Tier display copy. Numbers here are the single source of truth for this page.
const PLAN_COPY = [
  {
    key: 'free',
    name: 'Free',
    price: '$0',
    period: 'month',
    tagline: '7-day trial — no card required.',
    cta: 'start free — 7 days, no card',
    ctaHref: appUrl('/dashboard'),
    highlight: false,
    features: [
      '7-day free trial — no credit card, cancel anytime',
      '1 user · 1 data lake',
      '5 GB storage · 5 compute-hours included',
      'Dynamic per-agent ACLs — column · row · time · TTL',
      'Agents connect via MCP — ingest, query, remember',
      'Managed memory lake (doesn’t count toward your lakes)',
      '7-day audit retention · email support',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '$29',
    period: 'month',
    tagline: 'For a working team of agents.',
    cta: 'start free — 7 days, no card',
    ctaHref: appUrl('/dashboard?plan=pro'),
    highlight: true,
    features: [
      '3 users · 2 data lakes',
      '50 GB storage · 25 compute-hours included',
      'Dynamic per-agent ACLs + instant revoke',
      'Metered compute on the Duckling → Swan ladder',
      '30-day audit retention',
      'Email support',
    ],
  },
  {
    key: 'max',
    name: 'Max',
    price: '$99',
    period: 'month',
    tagline: 'More seats, more lakes, admin control.',
    cta: 'start free — 7 days, no card',
    ctaHref: appUrl('/dashboard?plan=max'),
    highlight: false,
    features: [
      '10 users · 10 data lakes',
      '500 GB storage · 75 compute-hours included',
      'Everything in Pro',
      'Admin MCP server for governance & audit',
      '90-day audit retention',
      'Email support',
    ],
  },
  {
    key: 'scale',
    name: 'Scale',
    price: '$299',
    period: 'month',
    tagline: 'Uncapped seats and lakes.',
    cta: 'start free — 7 days, no card',
    ctaHref: appUrl('/dashboard?plan=scale'),
    highlight: false,
    features: [
      'Unlimited users · unlimited data lakes',
      '2 TB storage · 200 compute-hours included',
      'Everything in Max',
      'Admin MCP server + priority support',
      '1-year audit retention',
      'SSO & dedicated gateways — talk to us',
    ],
  },
];

// Compute instance-size ladder — the metered dimension, billed per-second.
const COMPUTE_SIZES = [
  { size: 'Duckling', spec: '1 vCPU / 2 GiB', rate: '$0.55 / hr', note: 'baseline (1×)' },
  { size: 'Mallard', spec: '2 vCPU / 8 GiB', rate: '$1.25 / hr', note: '~2.3× a Duckling' },
  { size: 'Goose', spec: '4 vCPU / 16 GiB', rate: '$2.50 / hr', note: '~4.5× a Duckling' },
  { size: 'Swan', spec: '8 vCPU / 32 GiB', rate: '$4.95 / hr', note: '~9× a Duckling' },
  { size: 'Custom', spec: 'dedicated', rate: 'contact us', note: 'reserved & isolated' },
];

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <div className="text-center mb-16">
        <h1 className="text-4xl font-mono font-bold text-zinc-50 mb-4">pricing</h1>
        <p className="text-zinc-400 max-w-2xl mx-auto">
          A governed data lake your agents share, with dynamic per-user access
          control. Every plan is a flat monthly base that includes an envelope
          of storage and compute-hours, then meters usage on top. Start free —
          7 days, no card.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {PLAN_COPY.map((plan) => (
          <div
            key={plan.key}
            className={`rounded-lg border p-6 flex flex-col gap-6 ${
              plan.highlight
                ? 'border-emerald-500 bg-emerald-950/20 shadow-lg shadow-emerald-900/20'
                : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            {plan.highlight && (
              <div className="font-mono text-xs text-emerald-400 border border-emerald-800 bg-emerald-950/40 rounded px-2 py-0.5 self-start">
                most popular
              </div>
            )}
            <div>
              <div className="font-mono text-xl font-bold text-zinc-50 mb-1">{plan.name}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-mono font-bold text-zinc-50">{plan.price}</span>
                <span className="text-zinc-500 font-mono text-sm">/ {plan.period}</span>
              </div>
              <div className="text-sm text-zinc-400 mt-2 font-mono">{plan.tagline}</div>
            </div>

            <ul className="flex-1 space-y-2.5">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0 font-mono text-emerald-400">✓</span>
                  <span className="text-zinc-300">{f}</span>
                </li>
              ))}
            </ul>

            <TrackedLink
              href={plan.ctaHref}
              location="pricing"
              text={plan.cta}
              plan={plan.key}
              className={`block text-center font-mono font-semibold text-sm py-2.5 px-4 rounded transition-colors ${
                plan.highlight
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-[#0c0a09]'
                  : 'border border-zinc-700 text-zinc-300 hover:text-zinc-50 hover:border-zinc-500'
              }`}
            >
              {plan.cta}
            </TrackedLink>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-zinc-500 font-mono text-center">
        The managed memory lake is quota-exempt — it never counts toward your data-lake total.
      </p>

      {/* How pricing works: base + included envelope + metered usage */}
      <div className="mt-12 border border-zinc-800 rounded-lg p-6 bg-zinc-900/40">
        <h2 className="font-mono font-semibold text-zinc-50 mb-3">how pricing works</h2>
        <p className="text-sm text-zinc-400 max-w-3xl leading-relaxed">
          Each plan is a flat monthly <span className="text-zinc-200">base</span> that comes
          with an <span className="text-zinc-200">included envelope</span> — a block of storage
          and compute-hours you can use without thinking about it. Go beyond the envelope and
          you pay <span className="text-zinc-200">metered usage</span> only for what you use:{' '}
          <span className="text-emerald-400 font-mono">$0.55 / compute-hour</span> (Duckling
          equivalent, billed per-second) and{' '}
          <span className="text-emerald-400 font-mono">$0.04 / GB-month</span> of storage over
          your included amount. No prepaid credits, no top-ups — just base plus what you use.
        </p>
      </div>

      {/* Compute instance-size ladder */}
      <div className="mt-12 border border-zinc-800 rounded-lg p-6">
        <h2 className="font-mono font-semibold text-zinc-50 mb-2">compute sizes</h2>
        <p className="text-sm text-zinc-400 max-w-3xl leading-relaxed mb-6">
          Pick the machine your agents run on. Every size is billed per-second and draws down
          your included compute-hours by its weight — a Swan-hour burns the allowance about 9×
          as fast as a Duckling-hour. Metered overage is always priced at the Duckling rate ×
          weight.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-2 pr-4 font-normal">size</th>
                <th className="text-left py-2 px-4 font-normal">vCPU / memory</th>
                <th className="text-center py-2 px-4 font-normal text-emerald-400">price</th>
                <th className="text-left py-2 pl-4 font-normal">relative</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {COMPUTE_SIZES.map((c) => (
                <tr key={c.size}>
                  <td className="py-2.5 pr-4 text-zinc-200">{c.size}</td>
                  <td className="py-2.5 px-4 text-zinc-400">{c.spec}</td>
                  <td className="py-2.5 px-4 text-center text-emerald-400">{c.rate}</td>
                  <td className="py-2.5 pl-4 text-zinc-500">{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-6 rounded border border-emerald-900/60 bg-emerald-950/20 px-4 py-3">
          <p className="text-sm text-zinc-300 leading-relaxed">
            <span className="font-mono text-emerald-400">vs MotherDuck:</span> their Pulse runs
            $0.60/hr — our Duckling undercuts it at{' '}
            <span className="font-mono text-zinc-100">$0.55</span>. Their Giga tops out at
            $36/hr — our biggest, the Swan, is{' '}
            <span className="font-mono text-zinc-100">$4.95</span>. Same DuckDB, a fraction of
            the price.
          </p>
        </div>
      </div>

      {/* Detailed comparison */}
      <div className="mt-12 border border-zinc-800 rounded-lg p-6">
        <h2 className="font-mono font-semibold text-zinc-50 mb-6">detailed comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-2 pr-4 font-normal">feature</th>
                <th className="text-center py-2 px-4 font-normal">Free</th>
                <th className="text-center py-2 px-4 font-normal text-emerald-400">Pro</th>
                <th className="text-center py-2 px-4 font-normal">Max</th>
                <th className="text-center py-2 px-4 font-normal">Scale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              <Row label="free trial" free="7 days, no card" pro="7 days, no card" max="7 days, no card" scale="7 days, no card" />
              <Row label="monthly base" free="$0" pro="$29" max="$99" scale="$299" />
              <Row label="users (seats)" free="1" pro="3" max="10" scale="unlimited" />
              <Row label="data lakes" free="1" pro="2" max="10" scale="unlimited" />
              <Row label="included storage" free="5 GB" pro="50 GB" max="500 GB" scale="2 TB" />
              <Row label="included compute-hrs" free="5" pro="25" max="75" scale="200" />
              <Row label="dynamic ACL (column · row · time)" free="✓" pro="✓" max="✓" scale="✓" />
              <Row label="admin MCP server" free="✗" pro="✗" max="✓" scale="✓" />
              <Row label="audit retention" free="7 days" pro="30 days" max="90 days" scale="365 days" />
              <Row label="support" free="email" pro="email" max="email" scale="priority email" />
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-10 text-center">
        <p className="text-zinc-500 text-sm font-mono">
          need SSO, dedicated gateways, custom compute, or an SLA?{' '}
          <a href="mailto:hello@getwaddling.com" className="text-zinc-300 hover:text-zinc-50 transition-colors">
            hello@getwaddling.com
          </a>
        </p>
      </div>
    </main>
  );
}

interface RowProps {
  label: string;
  free: string;
  pro: string;
  max: string;
  scale: string;
}

function Row({ label, free, pro, max, scale }: RowProps) {
  return (
    <tr>
      <td className="py-2.5 pr-4 text-zinc-400">{label}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{free}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{pro}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{max}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{scale}</td>
    </tr>
  );
}
