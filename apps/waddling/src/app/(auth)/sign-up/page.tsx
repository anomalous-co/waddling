'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Loader2, Check, MailCheck } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { useFunnel } from '@/lib/funnel';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

type Step = 'account' | 'verify';

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
  const funnel = useFunnel();
  const startedRef = useRef(false);
  const [step, setStep] = useState<Step>('account');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fire `signup_started` once, on the first interaction with the account form.
  const markStarted = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    funnel.signupStarted();
  };

  // Account form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Where the verification link returns the (now auto-signed-in) user. MUST be an
  // absolute, trusted origin: Better Auth redirects here verbatim after
  // autoSignInAfterVerification, so a relative path would resolve against the API
  // origin (api.*) instead of the app. /onboarding creates the org + collects billing —
  // none of which can run at sign-up time, because requireEmailVerification means
  // sign-up returns no session until the email is verified.
  const onboardingUrl = () =>
    typeof window !== 'undefined' ? `${window.location.origin}/onboarding` : '/onboarding';

  const submitAccount = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: onboardingUrl(),
    });
    setLoading(false);

    if (res.error) {
      setError(res.error.message ?? 'Sign-up failed');
      return;
    }
    // Stitch the anonymous visitor to the new user so the marketing → signup funnel
    // connects. The authoritative `signup_completed` event fires server-side.
    const user = res.data?.user;
    if (user) funnel.identifyUser(user.id, { email: user.email, name: user.name });
    // requireEmailVerification is on → sign-up returned no session (token: null) and
    // dispatched a verification email. Org creation + billing happen in /onboarding,
    // reached only after the verify link signs the user in.
    setStep('verify');
  };

  const [resent, setResent] = useState(false);
  const resend = async () => {
    setResent(false);
    setError(null);
    const res = await authClient.sendVerificationEmail({ email, callbackURL: onboardingUrl() });
    if (res.error) {
      setError(res.error.message ?? 'Could not resend the verification email');
      return;
    }
    setResent(true);
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
          <StepDot active={step === 'account'} done={step === 'verify'} label="1. Account" />
          <Separator className="flex-1" />
          <StepDot active={step === 'verify'} done={false} label="2. Verify email" />
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
                        onChange={(e) => {
                          markStarted();
                          setName(e.target.value);
                        }}
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
                        onChange={(e) => {
                          markStarted();
                          setEmail(e.target.value);
                        }}
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
                        onChange={(e) => {
                          markStarted();
                          setPassword(e.target.value);
                        }}
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
                <CardTitle>Check your email</CardTitle>
                <CardDescription>
                  We sent a verification link to <strong>{email}</strong>. Click it to finish
                  setting up your account — you&apos;ll pick an organization and plan next.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col items-center gap-4 py-2 text-center">
                  <MailCheck className="size-8 text-primary" />
                  <p className="text-sm text-muted-foreground">
                    Didn&apos;t get it? Check your spam folder, or resend below.
                  </p>

                  {error ? (
                    <Alert variant="destructive">
                      <AlertTitle>Could not resend</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}
                  {resent ? (
                    <p className="text-sm text-green-600">Verification email sent again.</p>
                  ) : null}

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => void resend()}
                  >
                    Resend verification email
                  </Button>

                  <p className="text-xs text-muted-foreground">
                    Wrong address?{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setStep('account');
                        setResent(false);
                        setError(null);
                      }}
                      className="text-primary hover:underline"
                    >
                      Start over
                    </button>
                  </p>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
