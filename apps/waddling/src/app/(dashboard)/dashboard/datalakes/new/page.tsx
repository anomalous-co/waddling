'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ChevronDown, ChevronRight, CreditCard, Sparkles, Plug, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { cpPost } from '@/components/dashboard/fetch';
import type { CreateDatalakeInput } from '@/lib/types';

type Mode = 'managed' | 'byo';
// Object-store presets — pick the platform, we set the connection style for you.
type StoreKind = 'r2' | 's3' | 'minio';
const STORE_PRESETS: Record<StoreKind, { label: string; urlStyle: 'vhost' | 'path'; useSsl: boolean; needsEndpoint: boolean; endpointPlaceholder: string }> = {
  r2: { label: 'Cloudflare R2', urlStyle: 'path', useSsl: true, needsEndpoint: true, endpointPlaceholder: '<account-id>.r2.cloudflarestorage.com' },
  s3: { label: 'Amazon S3', urlStyle: 'vhost', useSsl: true, needsEndpoint: false, endpointPlaceholder: '(none — AWS default)' },
  minio: { label: 'MinIO / other S3', urlStyle: 'path', useSsl: true, needsEndpoint: true, endpointPlaceholder: 'minio.example.com:9000' },
};

// Derive a url-safe slug from a display name (matches the API's [a-z0-9-] rule).
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export default function NewDatalakePage() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('managed');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [region, setRegion] = useState('auto');
  const [encrypted, setEncrypted] = useState(true);

  // BYO object store
  const [storeKind, setStoreKind] = useState<StoreKind>('r2');
  const [bucket, setBucket] = useState('');
  const [endpointHost, setEndpointHost] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');

  // Advanced — BYO catalog (BYO mode only)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [catalogDsn, setCatalogDsn] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const preset = STORE_PRESETS[storeKind];

  const canSubmit =
    !!name.trim() &&
    !!effectiveSlug &&
    (mode === 'managed' ||
      (!!bucket.trim() && !!keyId.trim() && !!secret.trim() && (!preset.needsEndpoint || !!endpointHost.trim())));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSlugError(null);
    setQuotaError(null);
    setSubmitting(true);

    const base = { name: name.trim(), slug: effectiveSlug, region, encrypted };
    let body: CreateDatalakeInput;
    if (mode === 'managed') {
      // Nothing to configure — the backend provisions the catalog + bucket.
      body = { ...base, managed: true };
    } else {
      // Normalize a bare bucket (optionally bucket/prefix) into an s3:// DATA_PATH.
      const b = bucket.trim().replace(/^s3:\/\//i, '').replace(/^\/+|\/+$/g, '');
      body = {
        ...base,
        storage: {
          dataPath: `s3://${b}/`,
          provider: 'config',
          keyId: keyId.trim(),
          secret,
          ...(preset.needsEndpoint && endpointHost.trim() ? { endpoint: endpointHost.trim() } : {}),
          urlStyle: preset.urlStyle,
          useSsl: preset.useSsl,
        },
        ...(showAdvanced && catalogDsn.trim() ? { catalogDsn: catalogDsn.trim() } : {}),
      };
    }

    const res = await cpPost<{ datalakeId: string; status: string }>('/api/cp/datalakes', body);
    setSubmitting(false);

    if (!res.ok) {
      if (res.status === 402) setQuotaError(res.error);
      else if (res.code === 'slug_taken' || res.error === 'slug_taken') setSlugError('A data lake with that slug already exists.');
      else toast.error(res.error);
      return;
    }
    toast.success('Data lake created');
    router.push(`/dashboard/datalakes/${res.data.datalakeId}`);
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create data lake</h1>
        <p className="text-sm text-muted-foreground">
          A governed DuckLake your agents query through waddling.
        </p>
      </div>

      {quotaError ? (
        <Alert variant="destructive">
          <CreditCard />
          <AlertTitle>Upgrade required</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            {quotaError}
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/billing">
                <CreditCard data-icon="inline-start" />
                View billing
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
            <CardDescription>Name your data lake.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Analytics lake"
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="slug">Slug</FieldLabel>
                <Input
                  id="slug"
                  value={effectiveSlug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(slugify(e.target.value));
                  }}
                  placeholder="analytics-lake"
                />
                <FieldDescription>
                  url-safe id (a-z 0-9 -){slugEdited ? '' : ' · auto from name'}
                </FieldDescription>
                {slugError ? <FieldError>{slugError}</FieldError> : null}
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Storage</CardTitle>
            <CardDescription>Where the lake&apos;s data files live.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ModeCard
                active={mode === 'managed'}
                onClick={() => setMode('managed')}
                icon={<Sparkles className="size-4" />}
                title="Managed"
                badge="Recommended"
                desc="waddling provisions an isolated Postgres catalog and an encrypted bucket. Nothing to configure."
              />
              <ModeCard
                active={mode === 'byo'}
                onClick={() => setMode('byo')}
                icon={<Plug className="size-4" />}
                title="Bring your own"
                desc="Connect an existing S3 / R2 / MinIO bucket you already have."
              />
            </div>

            {mode === 'byo' ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="storeKind">Object store</FieldLabel>
                  <Select value={storeKind} onValueChange={(v) => setStoreKind(v as StoreKind)}>
                    <SelectTrigger id="storeKind" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STORE_PRESETS) as StoreKind[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {STORE_PRESETS[k].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>Sets the connection style for you ({preset.urlStyle}-style{preset.useSsl ? ', SSL' : ''}).</FieldDescription>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="bucket">Bucket</FieldLabel>
                    <Input
                      id="bucket"
                      value={bucket}
                      onChange={(e) => setBucket(e.target.value)}
                      placeholder="my-lake-bucket"
                      className="font-mono"
                    />
                    <FieldDescription>Just the bucket name (we build the s3:// path).</FieldDescription>
                  </Field>
                  {preset.needsEndpoint ? (
                    <Field>
                      <FieldLabel htmlFor="endpointHost">Endpoint host</FieldLabel>
                      <Input
                        id="endpointHost"
                        value={endpointHost}
                        onChange={(e) => setEndpointHost(e.target.value)}
                        placeholder={preset.endpointPlaceholder}
                        className="font-mono"
                      />
                      <FieldDescription>Host only — no https://, no bucket.</FieldDescription>
                    </Field>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="keyId">Access key ID</FieldLabel>
                    <Input
                      id="keyId"
                      value={keyId}
                      onChange={(e) => setKeyId(e.target.value)}
                      placeholder="AKIA…"
                      autoComplete="off"
                      className="font-mono"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="secret">Secret access key</FieldLabel>
                    <Input
                      id="secret"
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="off"
                      className="font-mono"
                    />
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="region">Region</FieldLabel>
                    <Select value={region} onValueChange={(v) => setRegion(v)}>
                      <SelectTrigger id="region" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">auto (R2)</SelectItem>
                        <SelectItem value="us-east-1">us-east-1</SelectItem>
                        <SelectItem value="us-west-2">us-west-2</SelectItem>
                        <SelectItem value="eu-west-1">eu-west-1</SelectItem>
                        <SelectItem value="eu-north-1">eu-north-1</SelectItem>
                        <SelectItem value="ap-southeast-1">ap-southeast-1</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>Use <code>auto</code> for R2.</FieldDescription>
                  </Field>
                  <Field orientation="horizontal" className="items-end pb-1">
                    <FieldLabel htmlFor="encrypted">Encrypt at rest</FieldLabel>
                    <Switch id="encrypted" checked={encrypted} onCheckedChange={setEncrypted} />
                  </Field>
                </div>
              </FieldGroup>
            ) : null}
          </CardContent>
        </Card>

        {mode === 'byo' ? (
          <Card>
            <CardContent>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowAdvanced((v) => !v)}
                className="w-full justify-start text-muted-foreground"
              >
                {showAdvanced ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
                Advanced — bring your own catalog
                <span className="ml-1 text-muted-foreground/60">(provisioned by default)</span>
              </Button>
              {showAdvanced ? (
                <div className="mt-4">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="catalogDsn">Catalog DSN</FieldLabel>
                      <Input
                        id="catalogDsn"
                        value={catalogDsn}
                        onChange={(e) => setCatalogDsn(e.target.value)}
                        placeholder="postgres://user:pass@host:5432/ducklake"
                        className="font-mono"
                      />
                      <FieldDescription>
                        Postgres DSN for the DuckLake metadata catalog. Leave blank and waddling provisions one. Stored encrypted.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/datalakes">Cancel</Link>
          </Button>
          <Button type="submit" disabled={!canSubmit || submitting}>
            {submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
            Create data lake
          </Button>
        </div>
      </form>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  badge,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  badge?: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col gap-2 rounded-md border p-4 text-left transition-colors',
        active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('text-muted-foreground', active && 'text-primary')}>{icon}</span>
        <span className="text-sm font-medium">{title}</span>
        {badge ? (
          <span className="ml-auto rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{badge}</span>
        ) : null}
        {active && !badge ? <Check className="ml-auto size-4 text-primary" /> : null}
      </div>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}
