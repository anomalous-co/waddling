'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Check } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

type Step = 'account' | 'org';

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
        className={cn(
          'flex size-5 items-center justify-center rounded-full border text-xs font-mono font-bold',
          active
            ? 'border-primary bg-primary text-primary-foreground'
            : done
              ? 'border-green-600 bg-green-700 text-white'
              : 'border-border bg-muted text-muted-foreground',
        )}
      >
        {done ? <Check className="size-3" /> : label.charAt(0)}
      </div>
      <span className={cn('text-xs', active ? 'text-foreground' : 'text-muted-foreground')}>
        {label.slice(3)}
      </span>
    </div>
  );
}

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

    const res = await authClient.signUp.email({ name, email, password });
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
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="text-center">
          <span className="font-mono text-xl font-bold text-primary">waddling</span>
          <p className="mt-1 text-sm text-muted-foreground">Dynamic ACLs for AI agents</p>
        </div>

        {/* Step progress */}
        <div className="flex items-center gap-2">
          <StepDot active={step === 'account'} done={step === 'org'} label="1. Account" />
          <Separator className="flex-1" />
          <StepDot active={step === 'org'} done={false} label="2. Organization" />
        </div>

        <Card>
          {step === 'account' ? (
            <>
              <CardHeader>
                <CardTitle>Create account</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={(e) => void submitAccount(e)}>
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor="name">Full name</FieldLabel>
                      <Input
                        id="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        autoComplete="name"
                        placeholder="Ada Lovelace"
                      />
                    </Field>

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
                        autoComplete="new-password"
                        placeholder="Min 8 characters"
                        minLength={8}
                      />
                    </Field>

                    {error ? (
                      <Alert variant="destructive">
                        <AlertTitle>Could not create account</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    ) : null}

                    <Button type="submit" disabled={loading} className="w-full">
                      {loading ? (
                        <Loader2 data-icon="inline-start" className="animate-spin" />
                      ) : null}
                      Continue
                    </Button>
                  </FieldGroup>
                </form>

                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Have an account?{' '}
                  <Link href="/sign-in" className="text-primary hover:underline">
                    Sign in
                  </Link>
                </p>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>Create organization</CardTitle>
                <CardDescription>
                  Organizations group your data lakes, agents, and team members. You can create more
                  later.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={(e) => void submitOrg(e)}>
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
                      <Input
                        id="org-name"
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        required
                        placeholder="Acme Corp"
                      />
                    </Field>

                    {error ? (
                      <Alert variant="destructive">
                        <AlertTitle>Could not create organization</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    ) : null}

                    <Button type="submit" disabled={loading} className="w-full">
                      {loading ? (
                        <Loader2 data-icon="inline-start" className="animate-spin" />
                      ) : null}
                      Create org and go to dashboard
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full text-muted-foreground"
                      onClick={() => router.push('/dashboard')}
                    >
                      Skip for now
                    </Button>
                  </FieldGroup>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
