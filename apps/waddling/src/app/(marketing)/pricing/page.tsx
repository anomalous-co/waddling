import type { Metadata } from 'next';
import { PLANS } from '@/lib/plans';
import { appUrl } from '@/lib/site';
import { TrackedLink } from '@/components/tracked-link';

// PLANS shape (from @waddling/control-schema via @/lib/types):
// Plan = { name:'free'|'pro'|'enterprise'; priceId:string; entitlements:{endpoints:number;agents:number;dynamicAcl:boolean;adminMcp:boolean;auditRetentionDays:number} }
// Human copy (prices, bullets, support) lives in PLAN_COPY below; entitlement numbers come from PLANS.
// The $15 Starter tier maps onto the schema's entry plan (`free`) until the schema rename lands.

export const metadata: Metadata = {
  title: 'Pricing — waddling',
  description:
    'Your personal data store starts at $15/mo: one managed memory lake your agents remember how to use. Pro $49/mo and Scale $199/mo add more lakes and more agents.',
};

// Human copy — prices, descriptions, CTAs. Entitlement numbers pulled from PLANS at render time.
const PLAN_COPY = [
  {
    key: 'starter',
    name: 'Starter',
    price: '$15',
    period: 'month',
    tagline: 'Your personal data store.',
    cta: 'start 3-day free trial',
    ctaHref: appUrl('/dashboard'),
    highlight: true,
    features: [
      'First 3 days free — cancel anytime, pay nothing',
      'Your memory lake, fully managed (doesn’t count against limits)',
      '1 data lake for your own data · 3 agents',
      '$15 / mo in usage credits included',
      'Agents connect via MCP — ingest, query, remember',
      'Per-agent access control + instant revoke',
      'Email support',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '$49',
    period: 'month',
    tagline: 'More lakes, more agents.',
    cta: 'start pro',
    ctaHref: appUrl('/dashboard?plan=pro'),
    highlight: false,
    features: [
      '$49 / mo in usage credits included',
      'Up to 5 memory lakes',
      '25 agents',
      'Full dynamic ACL (column · row limit · time window · TTL)',
      'Internal MCP admin server',
      '90-day audit retention',
    ],
  },
  {
    key: 'scale',
    name: 'Scale',
    price: '$199',
    period: 'month',
    tagline: 'Everything in Pro, uncapped.',
    cta: 'start scale',
    ctaHref: appUrl('/dashboard?plan=scale'),
    highlight: false,
    features: [
      '$199 / mo in usage credits included',
      'Unlimited memory lakes',
      'Unlimited agents',
      'Everything in Pro — uncapped',
      '1-year audit retention',
      'Priority email support',
    ],
  },
];

function fmtEntitlement(n: number): string {
  return n === Number.POSITIVE_INFINITY ? 'unlimited' : String(n);
}

export default function PricingPage() {
  // Pull live entitlement numbers from PLANS; human copy stays in PLAN_COPY.
  const starterPlan = PLANS.find((p) => p.name === 'starter');
  const proPlan = PLANS.find((p) => p.name === 'pro');
  const scalePlan = PLANS.find((p) => p.name === 'scale');

  const starterAgents = starterPlan ? fmtEntitlement(starterPlan.entitlements.agents) : '3';
  const starterAudit = starterPlan ? `${starterPlan.entitlements.auditRetentionDays} days` : '30 days';
  const proEndpoints = proPlan ? fmtEntitlement(proPlan.entitlements.endpoints) : '5';
  const proAgents = proPlan ? fmtEntitlement(proPlan.entitlements.agents) : '25';
  const proAudit = proPlan ? `${proPlan.entitlements.auditRetentionDays} days` : '90 days';
  const scaleAudit = scalePlan ? `${scalePlan.entitlements.auditRetentionDays} days` : '365 days';

  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <div className="text-center mb-16">
        <h1 className="text-4xl font-mono font-bold text-zinc-50 mb-4">pricing</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          Every plan includes a managed memory lake your agents remember how to
          use. Higher tiers add more lakes and more agents. No infrastructure to
          run — waddling manages everything.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PLAN_COPY.map((plan) => (
          <div
            key={plan.key}
            className={`rounded-lg border p-8 flex flex-col gap-6 ${
              plan.highlight
                ? 'border-emerald-500 bg-emerald-950/20 shadow-lg shadow-emerald-900/20'
                : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            {plan.highlight && (
              <div className="font-mono text-xs text-emerald-400 border border-emerald-800 bg-emerald-950/40 rounded px-2 py-0.5 self-start">
                start here
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

      {/* Usage-based pricing explainer */}
      <div className="mt-12 border border-zinc-800 rounded-lg p-6 bg-zinc-900/40">
        <h2 className="font-mono font-semibold text-zinc-50 mb-3">how usage works</h2>
        <p className="text-sm text-zinc-400 max-w-3xl leading-relaxed">
          Every plan is <span className="text-zinc-200">prepaid credits</span>. Your monthly
          plan resets your credit balance to its included amount each billing cycle, then usage
          draws it down at{' '}
          <span className="text-emerald-400 font-mono">$0.50 / active session-hour</span>{' '}
          — you only pay while an agent session is live. Run out before the month is up? Top up
          any time (<span className="text-zinc-200 font-mono">$10 minimum</span>); purchased
          credits carry over and are spent after your monthly credits. At a zero balance, serving
          pauses until you top up — no surprise overage bills.
        </p>
      </div>

      {/* Comparison note */}
      <div className="mt-12 border border-zinc-800 rounded-lg p-6">
        <h2 className="font-mono font-semibold text-zinc-50 mb-6">detailed comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-2 pr-4 font-normal">feature</th>
                <th className="text-center py-2 px-4 font-normal text-emerald-400">starter</th>
                <th className="text-center py-2 px-4 font-normal">pro</th>
                <th className="text-center py-2 px-4 font-normal">scale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              <Row label="free trial" starter="3 days" pro="—" scale="—" />
              <Row label="monthly usage credits" starter="$15" pro="$49" scale="$199" />
              <Row label="usage rate" starter="$0.50 / session-hr" pro="$0.50 / session-hr" scale="$0.50 / session-hr" />
              <Row label="memory lake (agents remember)" starter="✓ included" pro="✓ included" scale="✓ included" />
              <Row label="data lakes" starter="1" pro={proEndpoints} scale="unlimited" />
              <Row label="agents" starter={starterAgents} pro={proAgents} scale="unlimited" />
              <Row label="per-agent access control + instant revoke" starter="✓" pro="✓" scale="✓" />
              <Row label="dynamic ACL (column · row · time)" starter="✗" pro="✓" scale="✓" />
              <Row label="admin MCP server" starter="✗" pro="✓" scale="✓" />
              <Row label="audit retention" starter={starterAudit} pro={proAudit} scale={scaleAudit} />
              <Row label="support" starter="email" pro="email" scale="priority email" />
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-10 text-center">
        <p className="text-zinc-500 text-sm font-mono">
          need SSO, dedicated gateways, or an SLA?{' '}
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
  starter: string;
  pro: string;
  scale: string;
}

function Row({ label, starter, pro, scale }: RowProps) {
  return (
    <tr>
      <td className="py-2.5 pr-4 text-zinc-400">{label}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{starter}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{pro}</td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{scale}</td>
    </tr>
  );
}
