'use client';

import { useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { Input, Label, Button } from '@/components/dashboard/ui';

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await authClient.signIn.email({ email, password });
    setLoading(false);

    if (res.error) {
      setError(res.error.message ?? 'Sign-in failed');
      return;
    }
    router.push(next);
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

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="text-base font-semibold text-neutral-100 mb-5">
            Sign in
          </h1>

          <form onSubmit={(e) => void submit(e)} className="space-y-4">
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
                autoComplete="current-password"
                placeholder="••••••••"
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
              Sign in
            </Button>
          </form>

          <p className="text-center text-xs text-neutral-500 mt-4">
            No account?{' '}
            <Link
              href="/sign-up"
              className="text-blue-400 hover:text-blue-300"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
