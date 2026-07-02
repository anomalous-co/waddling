'use client';

import { useState, useId, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { ChevronLeft, Check, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/waddling/page-header';
import { SectionCard } from '@/components/waddling/section-card';
import { Stepper } from '@/components/waddling/stepper';
import { RadioSegments } from '@/components/waddling/radio-segments';
import { CodeBlock } from '@/components/waddling/code-block';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';
import { cpPost } from '@/components/dashboard/fetch';
import type { CreateDatalakeInput } from '@/lib/types';
import type { ProvisionedLake } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Derive a url-safe slug from a display name (matches the API's [a-z0-9-] rule).
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STEPS = [{ label: 'Configure' }, { label: 'Provision' }];

type StorageKind = 'managed' | 'byo';

// Object-store presets — pick the platform, we set the connection style for you.
// urlStyle/useSsl are real StorageSchema fields with real access consequences, so
// they come from the chosen platform rather than a guess (mirrors the prod create
// contract — a wrong urlStyle silently breaks S3/R2 reads).
type StoreKind = 'r2' | 's3' | 'minio';
const STORE_PRESETS: Record<
  StoreKind,
  { label: string; urlStyle: 'vhost' | 'path'; useSsl: boolean; needsEndpoint: boolean; endpointPlaceholder: string }
> = {
  r2: { label: 'Cloudflare R2', urlStyle: 'path', useSsl: true, needsEndpoint: true, endpointPlaceholder: '<account-id>.r2.cloudflarestorage.com' },
  s3: { label: 'Amazon S3', urlStyle: 'vhost', useSsl: true, needsEndpoint: false, endpointPlaceholder: '(none — AWS default)' },
  minio: { label: 'MinIO / other S3', urlStyle: 'path', useSsl: true, needsEndpoint: true, endpointPlaceholder: 'minio.example.com:9000' },
};

const REGIONS = [
  { value: 'auto', label: 'auto (R2)' },
  { value: 'us-east-1', label: 'us-east-1' },
  { value: 'us-west-2', label: 'us-west-2' },
  { value: 'eu-west-1', label: 'eu-west-1' },
  { value: 'eu-north-1', label: 'eu-north-1' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1' },
] as const;

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewDataLakePage() {
  const { openConnect } = useConnectAgent();

  const [phase, setPhase] = useState<'form' | 'success'>('form');

  // Basics
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState('');
  const [region, setRegion] = useState('auto');

  // Storage
  const [storage, setStorage] = useState<StorageKind>('managed');
  const [encrypted, setEncrypted] = useState(true);
  const [storeKind, setStoreKind] = useState<StoreKind>('r2');
  const [bucket, setBucket] = useState('');
  const [endpointHost, setEndpointHost] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secret, setSecret] = useState('');

  // Advanced — BYO catalog (BYO mode only)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [catalogDsn, setCatalogDsn] = useState('');

  const [pending, setPending] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [result, setResult] = useState<ProvisionedLake | null>(null);

  const nameId = useId();
  const slugId = useId();
  const regionId = useId();
  const storageId = useId();
  const storeKindId = useId();
  const bucketId = useId();
  const endpointId = useId();
  const accessKeyId = useId();
  const secretId = useId();
  const catalogDsnId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const successHeadingRef = useRef<HTMLParagraphElement>(null);

  const effectiveSlug = slugEdited ? slug : deriveSlug(name);
  const preset = STORE_PRESETS[storeKind];

  // Move focus to the success heading when the view flips, so keyboard / SR
  // users get a signal the form was replaced (focus would otherwise drop to body).
  useEffect(() => {
    if (phase === 'success') successHeadingRef.current?.focus();
  }, [phase]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setNameError('');
      setSlugError('');
      setQuotaError('');

      if (!name.trim()) {
        setNameError('Lake name is required.');
        nameRef.current?.focus();
        return;
      }
      if (!effectiveSlug) {
        setSlugError('A url-safe slug is required.');
        return;
      }
      if (storage === 'byo' && (!bucket.trim() || !accessKey.trim() || !secret.trim() || (preset.needsEndpoint && !endpointHost.trim()))) {
        // The submit button guards this, but keep the check so a programmatic
        // submit never POSTs an incomplete BYO descriptor.
        return;
      }

      setPending(true);

      const base = { name: name.trim(), slug: effectiveSlug, region, encrypted };
      let body: CreateDatalakeInput;
      if (storage === 'managed') {
        // Nothing to configure — the backend provisions the catalog + bucket.
        body = { ...base, managed: true };
      } else {
        // Normalise a bare bucket (optionally bucket/prefix) into an s3:// DATA_PATH,
        // and send REAL credentials (encrypted at rest server-side; migration 005).
        const b = bucket.trim().replace(/^s3:\/\//i, '').replace(/^\/+|\/+$/g, '');
        body = {
          ...base,
          storage: {
            dataPath: `s3://${b}/`,
            provider: 'config',
            keyId: accessKey.trim(),
            secret,
            ...(preset.needsEndpoint && endpointHost.trim() ? { endpoint: endpointHost.trim() } : {}),
            urlStyle: preset.urlStyle,
            useSsl: preset.useSsl,
          },
          ...(showAdvanced && catalogDsn.trim() ? { catalogDsn: catalogDsn.trim() } : {}),
        };
      }

      const res = await cpPost<{ datalakeId: string; status: string }>('/api/cp/datalakes', body);
      setPending(false);

      if (!res.ok) {
        if (res.status === 402) {
          setQuotaError(res.error);
        } else if (res.code === 'slug_taken' || res.error === 'slug_taken') {
          setSlugError('A data lake with that slug already exists.');
        } else {
          toast.error(res.error || 'Could not create data lake. Please try again.');
        }
        return;
      }

      setResult({ datalakeId: res.data.datalakeId, name: name.trim(), slug: effectiveSlug, status: res.data.status });
      setPhase('success');
    },
    [name, effectiveSlug, region, encrypted, storage, bucket, accessKey, secret, endpointHost, preset, showAdvanced, catalogDsn],
  );

  const handleReset = useCallback(() => {
    setPhase('form');
    setName('');
    setNameError('');
    setSlug('');
    setSlugEdited(false);
    setSlugError('');
    setRegion('auto');
    setStorage('managed');
    setEncrypted(true);
    setStoreKind('r2');
    setBucket('');
    setEndpointHost('');
    setAccessKey('');
    setSecret('');
    setShowAdvanced(false);
    setCatalogDsn('');
    setQuotaError('');
    setResult(null);
  }, []);

  const canSubmit =
    !!name.trim() &&
    !!effectiveSlug &&
    (storage === 'managed' ||
      (!!bucket.trim() && !!accessKey.trim() && !!secret.trim() && (!preset.needsEndpoint || !!endpointHost.trim())));

  const stepperCurrent = phase === 'form' ? 0 : 1;
  // Real gateway address format (matches the datalake detail page's AttachCard).
  const gatewayEndpoint = result ? `gw-${result.slug}.getwaddling.com` : '';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New data lake"
        description="Configure a governed DuckLake catalog with encrypted object storage."
        breadcrumb={
          <Link
            href="/datalakes"
            className="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            Data lakes
          </Link>
        }
      />

      <Stepper steps={STEPS} current={stepperCurrent} />

      {quotaError && (
        <Alert variant="destructive">
          <CreditCard />
          <AlertTitle>Upgrade required</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            {quotaError}
            <Button asChild variant="outline" size="sm">
              <Link href="/billing">
                <CreditCard data-icon="inline-start" />
                View billing
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {phase === 'form' && (
        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="flex flex-col gap-6">
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
                  autoFocus
                  aria-required="true"
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? `${nameId}-error` : undefined}
                  className={cn(nameError && 'border-destructive')}
                />
                {nameError && (
                  <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
                    {nameError}
                  </p>
                )}
              </div>

              {/* Slug — derived from name by default, editable for collisions */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={slugId}>Slug</Label>
                <Input
                  id={slugId}
                  value={effectiveSlug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(deriveSlug(e.target.value));
                    if (slugError) setSlugError('');
                  }}
                  placeholder="event-lake"
                  autoComplete="off"
                  aria-invalid={!!slugError}
                  aria-describedby={slugError ? `${slugId}-error` : undefined}
                  className={cn('font-mono', slugError && 'border-destructive')}
                />
                {slugError ? (
                  <p id={`${slugId}-error`} role="alert" className="text-xs text-destructive">
                    {slugError}
                  </p>
                ) : (
                  <p aria-live="polite" className="text-xs text-muted-foreground">
                    url-safe id (a-z 0-9 -){slugEdited ? '' : ' · auto from name'}
                  </p>
                )}
              </div>

              {/* Region */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={regionId}>Region</Label>
                <select id={regionId} value={region} onChange={(e) => setRegion(e.target.value)} className={selectClass}>
                  {REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Use <code>auto</code> for R2.
                </p>
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
                    ? 'waddling provisions and manages an isolated Postgres catalog and an encrypted bucket. Nothing to configure.'
                    : 'Connect your own S3 / R2 / MinIO bucket. Credentials are encrypted at rest; waddling never logs them.'}
                </p>
              </div>

              {storage === 'byo' && (
                <div className="flex flex-col gap-3 border-t pt-4">
                  {/* Object store */}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={storeKindId}>Object store</Label>
                    <select
                      id={storeKindId}
                      value={storeKind}
                      onChange={(e) => setStoreKind(e.target.value as StoreKind)}
                      className={selectClass}
                    >
                      {(Object.keys(STORE_PRESETS) as StoreKind[]).map((k) => (
                        <option key={k} value={k}>
                          {STORE_PRESETS[k].label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Sets the connection style for you ({preset.urlStyle}-style{preset.useSsl ? ', SSL' : ''}).
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={bucketId}>Bucket</Label>
                      <Input
                        id={bucketId}
                        value={bucket}
                        onChange={(e) => setBucket(e.target.value)}
                        placeholder="my-lake-bucket"
                        autoComplete="off"
                        className="font-mono"
                      />
                      <p className="text-xs text-muted-foreground">Just the bucket name (we build the s3:// path).</p>
                    </div>
                    {preset.needsEndpoint && (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={endpointId}>Endpoint host</Label>
                        <Input
                          id={endpointId}
                          value={endpointHost}
                          onChange={(e) => setEndpointHost(e.target.value)}
                          placeholder={preset.endpointPlaceholder}
                          autoComplete="off"
                          className="font-mono"
                        />
                        <p className="text-xs text-muted-foreground">Host only — no https://, no bucket.</p>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={accessKeyId}>Access key ID</Label>
                      <Input
                        id={accessKeyId}
                        value={accessKey}
                        onChange={(e) => setAccessKey(e.target.value)}
                        placeholder="AKIA…"
                        autoComplete="off"
                        className="font-mono"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={secretId}>Secret access key</Label>
                      <Input
                        id={secretId}
                        type="password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        placeholder="••••••••"
                        autoComplete="new-password"
                        className="font-mono"
                      />
                    </div>
                  </div>

                  {/* Encrypt at rest */}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={encrypted}
                      onChange={(e) => setEncrypted(e.target.checked)}
                      className="size-4 rounded border-input"
                    />
                    Encrypt at rest
                  </label>

                  {/* Advanced — BYO catalog */}
                  <div className="border-t pt-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAdvanced((v) => !v)}
                      className="text-muted-foreground"
                    >
                      Advanced — bring your own catalog
                      <span className="ml-1 text-muted-foreground/60">(provisioned by default)</span>
                    </Button>
                    {showAdvanced && (
                      <div className="mt-3 flex flex-col gap-1.5">
                        <Label htmlFor={catalogDsnId}>Catalog DSN</Label>
                        <Input
                          id={catalogDsnId}
                          value={catalogDsn}
                          onChange={(e) => setCatalogDsn(e.target.value)}
                          placeholder="postgres://user:pass@host:5432/ducklake"
                          autoComplete="off"
                          className="font-mono"
                        />
                        <p className="text-xs text-muted-foreground">
                          Postgres DSN for the DuckLake metadata catalog. Leave blank and waddling provisions one. Stored encrypted.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur">
            <Button asChild variant="outline">
              <Link href="/datalakes">Cancel</Link>
            </Button>
            <Button type="submit" disabled={!canSubmit || pending}>
              {pending ? 'Creating…' : 'Create data lake'}
            </Button>
          </div>
        </form>
      )}

      {phase === 'success' && result && (
        <div className="flex flex-col gap-6">
          {/* ── Provisioning status ──────────────────────────────────────── */}
          <SectionCard title="Data lake created" headingLevel={2}>
            <div className="flex items-start gap-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
                <Check className="size-5 text-emerald-500" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p ref={successHeadingRef} tabIndex={-1} className="font-semibold leading-tight outline-none">
                  <span className="font-mono">{result.name}</span> is ready
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your governed DuckLake catalog is live. The gateway boots on the first agent connection and scales back
                  to zero when idle.
                </p>
              </div>
            </div>
          </SectionCard>

          {/* ── Gateway endpoint ─────────────────────────────────────────── */}
          <SectionCard title="Gateway endpoint" headingLevel={2}>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Agents attach to this endpoint through the governed gateway.</p>
              <CodeBlock code={`quack:${gatewayEndpoint}`} label="endpoint" copyLabel="Copy gateway endpoint" />
            </div>
          </SectionCard>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={handleReset}>
              Create another
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/datalakes/${result.datalakeId}`}>Open data lake</Link>
            </Button>
            <Button onClick={() => openConnect()}>Connect an agent</Button>
          </div>
        </div>
      )}
    </div>
  );
}
