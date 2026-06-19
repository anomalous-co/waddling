'use client';

/**
 * Device-link claim form (FUNNEL / Stream B, self-contained).
 *
 * Posts to /api/cp/device-link/claim with the session cookie. On success it
 * shows the "return to your terminal" screen — the agent is polling and will
 * pick up the freshly-minted API key on its next poll.
 *
 * Inline-styled (no dashboard component imports) to keep /link self-contained.
 */
import { useState, type FormEvent } from 'react';
import { cpUrl } from '@/lib/control-api';

interface OrgOption {
  id: string;
  name: string;
}

const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 ' +
  'placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none';

export function ClaimForm({
  initialCode,
  orgs,
}: {
  initialCode: string;
  orgs: OrgOption[];
}) {
  const [code, setCode] = useState(initialCode);
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [agentName, setAgentName] = useState('claude-code');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(cpUrl('/api/cp/device-link/claim'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, orgId, agentName }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setError(body.detail ?? body.error ?? 'Could not claim this code.');
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="h-5 w-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 10.5l3.5 3.5L15 6" />
          </svg>
        </div>
        <h1 className="text-base font-semibold text-neutral-100">
          Return to your terminal
        </h1>
        <p className="text-sm text-neutral-400">
          Your agent is now connected. It will detect the link automatically and
          continue what you asked it to do — you can close this tab.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <h1 className="text-base font-semibold text-neutral-100">
        Connect this agent
      </h1>

      <div>
        <label htmlFor="code" className="block text-xs text-neutral-400 mb-1">
          Code
        </label>
        <input
          id="code"
          className={`${inputCls} font-mono tracking-widest uppercase`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          required
          autoFocus={!initialCode}
        />
      </div>

      <div>
        <label htmlFor="org" className="block text-xs text-neutral-400 mb-1">
          Organization
        </label>
        <select
          id="org"
          className={inputCls}
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          required
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="agentName" className="block text-xs text-neutral-400 mb-1">
          Agent name
        </label>
        <input
          id="agentName"
          className={inputCls}
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="claude-code"
          required
        />
      </div>

      {error && (
        <p className="text-xs text-red-400 rounded border border-red-900 bg-red-950/40 px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full inline-flex items-center justify-center rounded border border-blue-500 bg-[#2563eb] px-3.5 py-1.5 text-sm font-medium text-white hover:bg-[#3b82f6] disabled:opacity-60"
      >
        {loading ? 'Connecting…' : 'Connect agent'}
      </button>
    </form>
  );
}
