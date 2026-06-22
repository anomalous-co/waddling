import Link from 'next/link';
import type { Metadata } from 'next';
import { PLANS } from '@/lib/plans';
import { appUrl } from '@/lib/site';
import { TrackedLink } from '@/components/tracked-link';

// PLANS shape (from @waddling/control-schema via @/lib/types):
// Plan = { name:'free'|'pro'|'enterprise'; priceId:string; entitlements:{endpoints:number;agents:number;dynamicAcl:boolean;adminMcp:boolean;auditRetentionDays:number} }
// Human copy (prices, bullets, support) lives in PLAN_COPY below; entitlement numbers come from PLANS.

export const metadata: Metadata = {
  title: 'Pricing — waddling',
  description: 'Free to start. Pro for dynamic ACLs. Enterprise for dedicated gateways and SSO.',
};

// Human copy — prices, descriptions, CTAs. Entitlement numbers pulled from PLANS at render time.
const PLAN_COPY = [
  {
    key: 'free',
    name: 'Free',
    price: '$0',
    period: 'forever',
    tagline: 'Audit and monitor. No credit card.',
    cta: 'start free',
    ctaHref: appUrl('/dashboard'),
    highlight: false,
    features: [
      '1 data lake · 2 agents',
      'Static reader / writer roles',
      'Audit log (7-day retention)',
      'Dashboard + usage view',
      'Community support',
      // dynamic ACL: false
      'No dynamic column/row/time ACL',
      'No admin MCP server',
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '$99',
    period: 'seat / month',
    tagline: 'Full dynamic ACL for your agents.',
    cta: 'start pro trial',
    ctaHref: appUrl('/dashboard?plan=pro'),
    highlight: true,
    features: [
      'Up to 5 data lakes',
      '25 agents',
      'Full dynamic ACL (column · row limit · time window · TTL · instant revoke)',
      'Internal MCP admin server',
      '90-day audit retention',
      'Policy compiler + birdshot snapshot push',
      'Email support',
    ],
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: 'contact sales',
    tagline: 'Dedicated gateways, SSO, and SLA.',
    cta: 'talk to us',
    ctaHref: '/enterprise',
    highlight: false,
    features: [
      'Unlimited data lakes + agents',
      'Dedicated isolated gateways',
      'Dedicated encrypted R2 buckets',
      'SSO / SAML',
      '1-year audit retention',
      'Uptime SLA',
      'Priority support + onboarding',
    ],
  },
];

function fmtEntitlement(n: number): string {
  return n === Number.POSITIVE_INFINITY ? 'unlimited' : String(n);
}

export default function PricingPage() {
  // Pull live entitlement numbers from PLANS (W1); human copy stays in PLAN_COPY.
  const freePlan = PLANS.find((p) => p.name === 'free');
  const proPlan = PLANS.find((p) => p.name === 'pro');
  const entPlan = PLANS.find((p) => p.name === 'enterprise');

  const freeEndpoints = freePlan ? fmtEntitlement(freePlan.entitlements.endpoints) : '1';
  const freeAgents = freePlan ? fmtEntitlement(freePlan.entitlements.agents) : '2';
  const freeAudit = freePlan ? `${freePlan.entitlements.auditRetentionDays} days` : '30 days';
  const proEndpoints = proPlan ? fmtEntitlement(proPlan.entitlements.endpoints) : '5';
  const proAgents = proPlan ? fmtEntitlement(proPlan.entitlements.agents) : '25';
  const proAudit = proPlan ? `${proPlan.entitlements.auditRetentionDays} days` : '90 days';
  const entAudit = entPlan ? `${entPlan.entitlements.auditRetentionDays} days` : '365 days';

  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <div className="text-center mb-16">
        <h1 className="text-4xl font-mono font-bold text-zinc-50 mb-4">pricing</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          Start free. Add dynamic ACL when your agents need it. No infrastructure to run —
          waddling manages the DuckDB gateways.
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
                most popular
              </div>
            )}
            <div>
              <div className="font-mono text-xl font-bold text-zinc-50 mb-1">{plan.name}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-mono font-bold text-zinc-50">{plan.price}</span>
                {plan.price !== 'Custom' && (
                  <span className="text-zinc-500 font-mono text-sm">/ {plan.period}</span>
                )}
              </div>
              <div className="text-sm text-zinc-400 mt-2 font-mono">{plan.tagline}</div>
            </div>

            <ul className="flex-1 space-y-2.5">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <span
                    className={`mt-0.5 shrink-0 font-mono ${
                      f.startsWith('No ') ? 'text-zinc-600' : 'text-emerald-400'
                    }`}
                  >
                    {f.startsWith('No ') ? '✗' : '✓'}
                  </span>
                  <span className={f.startsWith('No ') ? 'text-zinc-500' : 'text-zinc-300'}>
                    {f}
                  </span>
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

      {/* Comparison note */}
      <div className="mt-16 border border-zinc-800 rounded-lg p-6">
        <h2 className="font-mono font-semibold text-zinc-50 mb-6">detailed comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-2 pr-4 font-normal">feature</th>
                <th className="text-center py-2 px-4 font-normal">free</th>
                <th className="text-center py-2 px-4 font-normal text-emerald-400">pro</th>
                <th className="text-center py-2 px-4 font-normal">enterprise</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              <Row label="data lakes" free={freeEndpoints} pro={proEndpoints} enterprise="unlimited" />
              <Row label="agents" free={freeAgents} pro={proAgents} enterprise="unlimited" />
              <Row label="dynamic ACL (column · row · time)" free="✗" pro="✓" enterprise="✓" proGreen />
              <Row label="instant revoke (birdshot denylist)" free="✗" pro="✓" enterprise="✓" proGreen />
              <Row label="admin MCP server" free="✗" pro="✓" enterprise="✓" proGreen />
              <Row label="audit retention" free={freeAudit} pro={proAudit} enterprise={entAudit} />
              <Row label="dedicated gateway" free="✗" pro="✗" enterprise="✓" />
              <Row label="dedicated R2 bucket" free="✗" pro="✗" enterprise="✓" />
              <Row label="SSO / SAML" free="✗" pro="✗" enterprise="✓" />
              <Row label="SLA" free="✗" pro="✗" enterprise="✓" />
              <Row label="support" free="community" pro="email" enterprise="priority + onboarding" />
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-10 text-center">
        <p className="text-zinc-500 text-sm font-mono">
          questions?{' '}
          <a href="mailto:hello@getwaddling.com" className="text-zinc-300 hover:text-zinc-50 transition-colors">
            hello@getwaddling.com
          </a>
          {' · '}
          <Link href="/enterprise" className="text-zinc-300 hover:text-zinc-50 transition-colors">
            enterprise contact form
          </Link>
        </p>
      </div>
    </main>
  );
}

interface RowProps {
  label: string;
  free: string;
  pro: string;
  enterprise: string;
  proGreen?: boolean;
}

function Row({ label, free, pro, enterprise, proGreen }: RowProps) {
  return (
    <tr>
      <td className="py-2.5 pr-4 text-zinc-400">{label}</td>
      <td className="py-2.5 px-4 text-center text-zinc-500">{free}</td>
      <td className={`py-2.5 px-4 text-center ${proGreen && pro === '✓' ? 'text-emerald-400' : 'text-zinc-300'}`}>
        {pro}
      </td>
      <td className="py-2.5 px-4 text-center text-zinc-300">{enterprise}</td>
    </tr>
  );
}
