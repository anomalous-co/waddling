'use client';

import { useState, useId, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { ChevronLeft, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/waddling/page-header';
import { SectionCard } from '@/components/waddling/section-card';
import { Stepper } from '@/components/waddling/stepper';
import { RadioSegments } from '@/components/waddling/radio-segments';
import { CodeBlock } from '@/components/waddling/code-block';
import { useSetBreadcrumbTitle } from '@/components/waddling/app-shell';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';
import { cpPost } from '@/components/dashboard/fetch';

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STEPS = [{ label: 'Configure' }, { label: 'Provision' }];

const REGIONS = [
  { value: 'us-west-1', label: 'US West (Oregon)' },
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'eu-west-1', label: 'EU West (Ireland)' },
] as const;

type StorageKind = 'managed' | 'byo';

interface ProvisionedLake {
  id: string;
  name: string;
  slug: string;
  status: string;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewDataLakePage() {
  useSetBreadcrumbTitle('New data lake');

  const { openConnect } = useConnectAgent();

  const [phase, setPhase] = useState<'form' | 'success'>('form');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [region, setRegion] = useState('us-west-1');
  const [storage, setStorage] = useState<StorageKind>('managed');
  const [byoEndpoint, setByoEndpoint] = useState('');
  const [byoBucket, setByoBucket] = useState('');
  // BYO credentials are held in form state for UX only — never sent to the server.
  // A real implementation would hand them to a credential broker that encrypts
  // them server-side before persisting; the POST body never carries raw secrets.
  const [byoAccessKey, setByoAccessKey] = useState('');
  const [byoSecret, setByoSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ProvisionedLake | null>(null);

  const slug = deriveSlug(name);

  const nameId = useId();
  const regionId = useId();
  const storageId = useId();
  const byoEndpointId = useId();
  const byoBucketId = useId();
  const byoAccessKeyId = useId();
  const byoSecretId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const successHeadingRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the success heading when the view flips, so keyboard / SR
  // users get a signal the form was replaced (focus would otherwise drop to body).
  useEffect(() => {
    if (phase === 'success') successHeadingRef.current?.focus();
  }, [phase]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setNameError('');

      if (!name.trim()) {
        setNameError('Lake name is required.');
        nameRef.current?.focus();
        return;
      }

      setPending(true);

      const res = await cpPost<{ datalake: ProvisionedLake }>('/api/cp/datalakes', {
        name: name.trim(),
        slug,
        region,
        storage: {
          kind: storage,
          // BYO: pass endpoint + bucket; omit access key and secret — a real
          // implementation uses a credential broker (never raw secrets in transit).
          ...(storage === 'byo' && {
            endpoint: byoEndpoint.trim(),
            bucket: byoBucket.trim(),
          }),
        },
      });

      setPending(false);

      if (!res.ok) {
        setNameError('Could not create data lake. Please try again.');
        nameRef.current?.focus();
        return;
      }

      setResult(res.data.datalake);
      setPhase('success');
    },
    [name, slug, region, storage, byoEndpoint, byoBucket],
  );

  const handleReset = useCallback(() => {
    setPhase('form');
    setName('');
    setNameError('');
    setRegion('us-west-1');
    setStorage('managed');
    setByoEndpoint('');
    setByoBucket('');
    setByoAccessKey('');
    setByoSecret('');
    setResult(null);
  }, []);

  const stepperCurrent = phase === 'form' ? 0 : 1;
  const gatewayEndpoint = result ? `${result.slug}.gw.getwaddling.com` : '';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New data lake"
        description="Configure a governed DuckLake catalog with encrypted object storage."
        breadcrumb={
          <Link
            href="/lab/data"
            className="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            Data
          </Link>
        }
      />

      <Stepper steps={STEPS} current={stepperCurrent} />

      {phase === 'form' && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          noValidate
          className="flex flex-col gap-6"
        >
          {/* ── Name & region ───────────────────────────────────────────── */}
          <SectionCard title="Name & region" headingLevel={2}>
            <div className="flex flex-col gap-4">
              {/* Lake name */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={nameId}>
                  Lake name{' '}
                  <span aria-hidden="true" className="text-destructive">
                    *
                  </span>
                </Label>
                <Input
                  ref={nameRef}
                  id={nameId}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (nameError) setNameError('');
                  }}
                  placeholder="e.g. Event Lake"
                  autoComplete="off"
                  aria-required="true"
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? `${nameId}-error` : undefined}
                  className={cn(nameError && 'border-destructive')}
                />
                {nameError && (
                  <p
                    id={`${nameId}-error`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {nameError}
                  </p>
                )}
                {/* Slug preview — aria-live so screen readers catch updates as the
                    user types, without interrupting their flow (polite = waits for
                    the current utterance to finish). */}
                <p
                  aria-live="polite"
                  className="text-xs text-muted-foreground"
                >
                  {slug ? (
                    <>
                      Slug:{' '}
                      <span className="font-mono">{slug}</span>
                    </>
                  ) : (
                    'A URL-safe slug will be derived from the name.'
                  )}
                </p>
              </div>

              {/* Region */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={regionId}>Region</Label>
                <select
                  id={regionId}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </SectionCard>

          {/* ── Storage ─────────────────────────────────────────────────── */}
          <SectionCard title="Storage" headingLevel={2}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <span id={storageId} className="text-sm font-medium leading-none">
                  Storage type
                </span>
                <RadioSegments
                  value={storage}
                  onChange={setStorage}
                  ariaLabelledby={storageId}
                  options={[
                    { value: 'managed', label: 'Managed' },
                    { value: 'byo', label: 'Bring your own' },
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  {storage === 'managed'
                    ? 'waddling provisions and manages encrypted object storage for this lake.'
                    : 'Connect your own S3-compatible bucket. Credentials are encrypted at rest; waddling never logs them.'}
                </p>
              </div>

              {storage === 'byo' && (
                <div className="flex flex-col gap-3 border-t pt-4">
                  <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                    Demo only — do not paste real credentials.
                  </p>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={byoEndpointId}>Endpoint URL</Label>
                    <Input
                      id={byoEndpointId}
                      value={byoEndpoint}
                      onChange={(e) => setByoEndpoint(e.target.value)}
                      placeholder="https://s3.amazonaws.com"
                      autoComplete="off"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={byoBucketId}>Bucket</Label>
                    <Input
                      id={byoBucketId}
                      value={byoBucket}
                      onChange={(e) => setByoBucket(e.target.value)}
                      placeholder="my-analytics-bucket"
                      autoComplete="off"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={byoAccessKeyId}>Access key ID</Label>
                    <Input
                      id={byoAccessKeyId}
                      value={byoAccessKey}
                      onChange={(e) => setByoAccessKey(e.target.value)}
                      placeholder="AKIA…EXAMPLE"
                      autoComplete="off"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={byoSecretId}>Secret access key</Label>
                    <Input
                      id={byoSecretId}
                      type="password"
                      value={byoSecret}
                      onChange={(e) => setByoSecret(e.target.value)}
                      placeholder="Secret access key"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur">
            <Button type="submit" disabled={pending}>
              {pending ? 'Provisioning…' : 'Create data lake'}
            </Button>
          </div>
        </form>
      )}

      {phase === 'success' && result && (
        <div className="flex flex-col gap-6">
          {/* ── Provisioning status ──────────────────────────────────────── */}
          <SectionCard title="Data lake provisioning" headingLevel={2}>
            <div className="flex items-start gap-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
                <Check className="size-5 text-emerald-500" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p
                  ref={successHeadingRef}
                  tabIndex={-1}
                  className="font-semibold leading-tight outline-none"
                >
                  <span className="font-mono">{result.name}</span> is provisioning
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your governed DuckLake catalog is being set up. It&apos;ll be
                  queryable once active.
                </p>
              </div>
            </div>
          </SectionCard>

          {/* ── Gateway endpoint ─────────────────────────────────────────── */}
          <SectionCard title="Gateway endpoint" headingLevel={2}>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Agents connect to this endpoint. It becomes active once the lake
                finishes provisioning.
              </p>
              <CodeBlock
                code={gatewayEndpoint}
                label="endpoint"
                copyLabel="Copy gateway endpoint"
              />
            </div>
          </SectionCard>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={handleReset}>
              Create another
            </Button>
            <Button variant="outline" asChild>
              <Link href="/lab/data">Back to Data</Link>
            </Button>
            <Button onClick={() => openConnect()}>
              Connect an agent
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
