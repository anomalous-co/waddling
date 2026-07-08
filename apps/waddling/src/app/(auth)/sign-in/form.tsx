'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { CONTROL_API_BASE } from '@/lib/control-api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { BrandMark } from '@/components/brand-mark';
import { safeNextPath } from '@/lib/utils';

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // A validated same-origin return target. Defaults to the dashboard; used verbatim in
  // router.push below and carried onward to sign-up.
  const safeNext = safeNextPath(searchParams.get('next'));
  const next = safeNext ?? '/dashboard';
  // Carry `next` onward to sign-up so a user without an account (e.g. one funneled here
  // from the MCP device-link at /link?code=…) keeps the same return target through
  // account creation → onboarding → back to claim.
  const signUpHref = safeNext ? `/sign-up?next=${encodeURIComponent(safeNext)}` : '/sign-up';

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
    // OAuth/MCP resume: Better Auth redirected an unauthenticated authorize here with
    // the full OAuth query (client_id, redirect_uri, scope, prompt=consent, …). Now
    // that a session exists, full-navigate back to the API authorize endpoint to
    // continue the flow (→ consent screen → back to the agent). Otherwise normal nav.
    if (searchParams.get('client_id')) {
      window.location.href = `${CONTROL_API_BASE}/api/auth/mcp/authorize${window.location.search}`;
      return;
    }
    router.push(next);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <BrandMark />
          <p className="text-sm text-muted-foreground">Dynamic ACLs for AI agents</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void submit(e)}>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="••••••••"
                  />
                </Field>

                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Sign-in failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                  Sign in
                </Button>
              </FieldGroup>
            </form>

            <p className="mt-4 text-center text-xs text-muted-foreground">
              No account?{' '}
              <Link href={signUpHref} className="text-primary hover:underline">
                Create one
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
