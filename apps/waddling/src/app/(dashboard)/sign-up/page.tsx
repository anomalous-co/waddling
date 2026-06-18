'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { Input, Label, Button } from '@/components/dashboard/ui';

type Step = 'account' | 'org';

export default function SignUpPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('account');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Account form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Org form
  const [orgName, setOrgName] = useState('');

  const submitAccount = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await authClient.signUp.email({
      name,
      email,
      password,
    });
    setLoading(false);

    if (res.error) {
      setError(res.error.message ?? 'Sign-up failed');
      return;
    }
    setStep('org');
  };

  const submitOrg = async (e: FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) {
      setError('Organization name is required');
      return;
    }
    setLoading(true);
    setError(null);

    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await authClient.organization.create({ name: orgName, slug });
    setLoading(false);

    if (res.error) {
      setError(res.error.message ?? 'Failed to create organization');
      return;
    }
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <span className="font-mono font-bold text-xl text-blue-400">
            waddling
          </span>
          <p className="text-neutral-500 text-sm mt-1">
            Dynamic ACLs for AI agents
          </p>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2 mb-6">
          <StepDot active={step === 'account'} done={step === 'org'} label="1. Account" />
          <div className="flex-1 h-px bg-neutral-800" />
          <StepDot active={step === 'org'} done={false} label="2. Organization" />
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          {step === 'account' && (
            <>
              <h1 className="text-base font-semibold text-neutral-100 mb-5">
                Create account
              </h1>
              <form
                onSubmit={(e) => void submitAccount(e)}
                className="space-y-4"
              >
                <div>
                  <Label htmlFor="name">Full name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                  />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="Min 8 characters"
                    minLength={8}
                  />
                </div>
                {error && (
                  <p className="text-xs text-red-400 rounded border border-red-900 bg-red-950/40 px-3 py-2">
                    {error}
                  </p>
                )}
                <Button
                  variant="primary"
                  className="w-full"
                  type="submit"
                  loading={loading}
                >
                  Continue
                </Button>
              </form>
            </>
          )}

          {step === 'org' && (
            <>
              <h1 className="text-base font-semibold text-neutral-100 mb-1">
                Create organization
              </h1>
              <p className="text-xs text-neutral-500 mb-5">
                Organizations group your endpoints, agents, and team members.
                You can create more later.
              </p>
              <form
                onSubmit={(e) => void submitOrg(e)}
                className="space-y-4"
              >
                <div>
                  <Label htmlFor="org-name">Organization name</Label>
                  <Input
                    id="org-name"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    placeholder="Acme Corp"
                  />
                </div>
                {error && (
                  <p className="text-xs text-red-400 rounded border border-red-900 bg-red-950/40 px-3 py-2">
                    {error}
                  </p>
                )}
                <Button
                  variant="primary"
                  className="w-full"
                  type="submit"
                  loading={loading}
                >
                  Create org and go to dashboard
                </Button>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="w-full text-xs text-neutral-500 hover:text-neutral-300 transition-colors py-1"
                >
                  Skip for now
                </button>
              </form>
            </>
          )}

          {step === 'account' && (
            <p className="text-center text-xs text-neutral-500 mt-4">
              Have an account?{' '}
              <Link
                href="/sign-in"
                className="text-blue-400 hover:text-blue-300"
              >
                Sign in
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={[
          'w-5 h-5 rounded-full border text-xs flex items-center justify-center font-mono font-bold',
          active
            ? 'border-blue-500 bg-[#2563eb] text-white'
            : done
              ? 'border-green-600 bg-[#15803d] text-white'
              : 'border-neutral-700 bg-neutral-800 text-neutral-500',
        ].join(' ')}
      >
        {done ? '✓' : label.charAt(0)}
      </div>
      <span
        className={`text-xs ${active ? 'text-neutral-200' : 'text-neutral-500'}`}
      >
        {label.slice(3)}
      </span>
    </div>
  );
}
