import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Enterprise — waddling',
  description: 'Dedicated DuckDB gateways, SSO/SAML, encrypted lake storage, and uptime SLA for production workloads.',
};

export default function EnterprisePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-20">
      <div className="mb-14">
        <div className="inline-block font-mono text-xs text-blue-400 border border-blue-900 bg-blue-950/40 rounded px-2 py-1 mb-5">
          enterprise
        </div>
        <h1 className="text-4xl font-mono font-bold text-zinc-50 mb-4">
          dedicated infrastructure for production lakehouses
        </h1>
        <p className="text-zinc-400 text-lg max-w-2xl leading-relaxed">
          Enterprise customers get isolated DuckDB gateways, dedicated R2 storage, SSO, a 1-year audit
          trail, and an uptime SLA — everything you need to put AI agents in production on sensitive data.
        </p>
      </div>

      {/* Feature grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-16">
        <EnterpriseFeature
          title="Dedicated gateways"
          body="Your org gets its own isolated DuckDB gateway processes — no noisy-neighbour risk, predictable query latency, and a fixed quack endpoint you can firewall."
        />
        <EnterpriseFeature
          title="Dedicated R2 buckets"
          body="Lake data and extension binaries land in a bucket provisioned only for your org. You own the access policy; waddling provisions and monitors it."
        />
        <EnterpriseFeature
          title="SSO / SAML"
          body="Connect your IdP (Okta, Azure AD, Google Workspace, any SAML 2.0 provider) for dashboard and admin MCP auth. Provision org members automatically via SCIM."
        />
        <EnterpriseFeature
          title="1-year audit retention"
          body="Every auth decision, query, grant, and revoke — stored for 12 months and queryable via the admin MCP or dashboard export. Satisfies SOC 2 + GDPR audit requirements."
        />
        <EnterpriseFeature
          title="Uptime SLA"
          body="99.9% monthly uptime SLA on gateway availability, with dedicated incident escalation and a named customer success contact."
        />
        <EnterpriseFeature
          title="Priority support + onboarding"
          body="Dedicated Slack channel, architecture review, hands-on onboarding for your first lakehouse and agent fleet."
        />
        <EnterpriseFeature
          title="Unlimited agents + endpoints"
          body="Scale your agent fleet without counting. Connect multiple lakehouses (prod, staging, per-tenant) under one org, each with its own isolated gateway and ACL namespace."
        />
        <EnterpriseFeature
          title="Encrypted lake storage"
          body="DuckLake catalog and Parquet data encrypted at rest in your dedicated R2 bucket. Bring your own KMS key (Enterprise+)."
        />
      </div>

      {/* Setup overview */}
      <div className="border border-zinc-800 rounded-lg p-8 mb-16">
        <h2 className="font-mono font-semibold text-zinc-50 mb-6">enterprise setup overview</h2>
        <ol className="space-y-5">
          <SetupStep
            n={1}
            title="Provision a dedicated R2 bucket"
            body="We create s3://waddling-<org>-lake in Cloudflare R2. You get read/write credentials scoped only to your bucket. Your DuckLake data path becomes s3://waddling-<org>-lake/."
          />
          <SetupStep
            n={2}
            title="Point your DuckLake catalog at our managed Postgres"
            body="Your DuckLake catalog_dsn points to a schema-isolated Postgres 16 instance we provision. Or bring your own Postgres — we just need a DSN with schema CREATE rights."
          />
          <SetupStep
            n={3}
            title="Dedicated gateway endpoint"
            body="We spin up your isolated quack gateway (gw-<your-slug>.getwaddling.com) and load the birdshot extension. Your agents ATTACH to this fixed endpoint. You firewall it by org IP if needed."
          />
          <SetupStep
            n={4}
            title="Connect SSO (optional but recommended)"
            body="Configure your SAML IdP in the dashboard settings → SSO tab. Works with Okta, Azure AD, Google Workspace, and any SAML 2.0 provider."
          />
          <SetupStep
            n={5}
            title="Define your agent fleet + ACL policies"
            body="Create agents, assign API keys, and build ACL rules from the dashboard or the admin MCP server. The policy compiler pushes birdshot snapshots to your dedicated gateway."
          />
        </ol>
        <div className="mt-6 font-mono text-sm">
          <a
            href="/docs/enterprise-setup"
            className="text-blue-400 hover:text-blue-300 transition-colors"
          >
            full enterprise setup guide →
          </a>
        </div>
      </div>

      {/* Contact form */}
      <div className="border border-zinc-800 rounded-lg p-8 bg-zinc-900/50">
        <h2 className="font-mono font-semibold text-zinc-50 mb-2">contact sales</h2>
        <p className="text-zinc-400 text-sm mb-6 font-mono">
          Tell us about your lakehouse setup and agent fleet. We&apos;ll get back to you within one business day.
        </p>
        {/* Server action / mailto fallback */}
        <form
          action="mailto:enterprise@getwaddling.com"
          method="GET"
          className="space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="name" name="name" type="text" placeholder="Ada Lovelace" />
            <FormField label="work email" name="email" type="email" placeholder="ada@company.io" />
          </div>
          <FormField label="company" name="company" type="text" placeholder="Acme Corp" />
          <div>
            <label className="block font-mono text-xs text-zinc-400 mb-1.5">
              tell us about your use case
            </label>
            <textarea
              name="body"
              rows={4}
              placeholder="e.g. 10 analyst agents on a 50TB DuckLake, need column-level ACL for PII tables, SOC 2 required..."
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
            />
          </div>
          <button
            type="submit"
            className="bg-[#2563eb] hover:bg-[#3b82f6] text-white font-mono font-semibold text-sm px-5 py-2.5 rounded transition-colors"
          >
            send →
          </button>
        </form>
        <p className="text-zinc-600 text-xs font-mono mt-4">
          or email directly:{' '}
          <a href="mailto:enterprise@getwaddling.com" className="text-zinc-400 hover:text-zinc-300 transition-colors">
            enterprise@getwaddling.com
          </a>
        </p>
      </div>
    </main>
  );
}

interface EnterpriseFeatureProps {
  title: string;
  body: string;
}

function EnterpriseFeature({ title, body }: EnterpriseFeatureProps) {
  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/30">
      <h3 className="font-mono font-semibold text-zinc-50 mb-2 text-sm">{title}</h3>
      <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
    </div>
  );
}

interface SetupStepProps {
  n: number;
  title: string;
  body: string;
}

function SetupStep({ n, title, body }: SetupStepProps) {
  return (
    <li className="flex gap-4">
      <span className="font-mono text-sm text-zinc-600 w-5 shrink-0 pt-0.5">{n}.</span>
      <div>
        <div className="font-mono text-sm font-semibold text-zinc-200 mb-1">{title}</div>
        <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
      </div>
    </li>
  );
}

interface FormFieldProps {
  label: string;
  name: string;
  type: string;
  placeholder: string;
}

function FormField({ label, name, type, placeholder }: FormFieldProps) {
  return (
    <div>
      <label className="block font-mono text-xs text-zinc-400 mb-1.5">{label}</label>
      <input
        type={type}
        name={name}
        placeholder={placeholder}
        className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
      />
    </div>
  );
}
