'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  Button,
  Input,
  Select,
  Label,
  SectionTitle,
  UpgradeBanner,
} from '@/components/dashboard/ui';
import { cpPost } from '@/components/dashboard/fetch';
import type { CreateEndpointInput } from '@/lib/types';

type Provider = 'config' | 'credential_chain';

// Derive a url-safe slug from a display name (matches the API's [a-z0-9-] rule).
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function NewEndpointPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [region, setRegion] = useState('auto');
  const [encrypted, setEncrypted] = useState(true);

  // Storage (BYO object store)
  const [dataPath, setDataPath] = useState('');
  const [provider, setProvider] = useState<Provider>('config');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [urlStyle, setUrlStyle] = useState<'vhost' | 'path'>('vhost');
  const [useSsl, setUseSsl] = useState(true);

  // Advanced — BYO catalog
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [catalogDsn, setCatalogDsn] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const needsCreds = provider === 'config';
  const isS3 = /^s3:\/\//i.test(dataPath);
  const canSubmit =
    name.trim() &&
    effectiveSlug &&
    dataPath.trim() &&
    (!needsCreds || !isS3 || (keyId.trim() && secret.trim()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSlugError(null);
    setQuotaError(null);
    setSubmitting(true);

    const body: CreateEndpointInput = {
      name: name.trim(),
      slug: effectiveSlug,
      region,
      encrypted,
      storage: {
        dataPath: dataPath.trim(),
        provider,
        ...(needsCreds ? { keyId: keyId.trim(), secret } : {}),
        ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
        urlStyle,
        useSsl,
      },
      ...(showAdvanced && catalogDsn.trim() ? { catalogDsn: catalogDsn.trim() } : {}),
    };

    const res = await cpPost<{ endpointId: string; status: string }>(
      '/api/cp/endpoints',
      body,
    );
    setSubmitting(false);

    if (!res.ok) {
      if (res.status === 402) setQuotaError(res.error);
      else if (res.code === 'slug_taken' || res.error === 'slug_taken')
        setSlugError('An endpoint with that slug already exists.');
      else setError(res.error);
      return;
    }
    router.push(`/dashboard/endpoints/${res.data.endpointId}`);
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <SectionTitle
        action={
          <Link
            href="/dashboard/endpoints"
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            ← Endpoints
          </Link>
        }
      >
        Create endpoint
      </SectionTitle>

      {quotaError && <UpgradeBanner message={quotaError} />}

      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader
            title="Basics"
            subtitle="A governed DuckDB gateway attached to a DuckLake."
          />
          <div className="space-y-3">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Analytics lake"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(slugify(e.target.value));
                }}
                placeholder="analytics-lake"
              />
              <p className="mt-1 text-xs text-neutral-600">
                url-safe id (a-z 0-9 -){slugEdited ? '' : ' · auto from name'}
              </p>
              {slugError && <p className="mt-1 text-xs text-red-400">{slugError}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="region">Region</Label>
                <Select
                  id="region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  <option value="auto">auto</option>
                  <option value="us-east-1">us-east-1</option>
                  <option value="us-west-2">us-west-2</option>
                  <option value="eu-west-1">eu-west-1</option>
                  <option value="eu-north-1">eu-north-1</option>
                  <option value="ap-southeast-1">ap-southeast-1</option>
                </Select>
              </div>
              <div className="flex items-end pb-1.5">
                <label className="flex items-center gap-2 text-sm text-neutral-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={encrypted}
                    onChange={(e) => setEncrypted(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Encrypt data at rest
                </label>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Storage"
            subtitle="Your S3 / R2 / MinIO bucket — where the lake's Parquet data files live. Credentials are encrypted at rest."
          />
          <div className="space-y-3">
            <div>
              <Label htmlFor="dataPath">Data path</Label>
              <Input
                id="dataPath"
                value={dataPath}
                onChange={(e) => setDataPath(e.target.value)}
                placeholder="s3://my-bucket/lake/"
                className="font-mono"
              />
              <p className="mt-1 text-xs text-neutral-600">
                The DuckLake DATA_PATH. Must end in <code>/</code>.
              </p>
            </div>

            <div>
              <Label htmlFor="provider">Credentials</Label>
              <Select
                id="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
              >
                <option value="config">Access key + secret</option>
                <option value="credential_chain">Instance role (credential chain)</option>
              </Select>
            </div>

            {needsCreds && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="keyId">Access key ID</Label>
                  <Input
                    id="keyId"
                    value={keyId}
                    onChange={(e) => setKeyId(e.target.value)}
                    placeholder="AKIA…"
                    autoComplete="off"
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label htmlFor="secret">Secret access key</Label>
                  <Input
                    id="secret"
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="off"
                    className="font-mono"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="endpoint">Endpoint host</Label>
                <Input
                  id="endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="(R2 / MinIO only)"
                  className="font-mono"
                />
                <p className="mt-1 text-xs text-neutral-600">Leave blank for AWS S3.</p>
              </div>
              <div>
                <Label htmlFor="urlStyle">URL style</Label>
                <Select
                  id="urlStyle"
                  value={urlStyle}
                  onChange={(e) => setUrlStyle(e.target.value as 'vhost' | 'path')}
                >
                  <option value="vhost">vhost (S3 / R2)</option>
                  <option value="path">path (MinIO)</option>
                </Select>
                <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useSsl}
                    onChange={(e) => setUseSsl(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Use SSL
                </label>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-2 text-left text-xs font-medium text-neutral-400 hover:text-neutral-200"
          >
            <span className="text-neutral-600">{showAdvanced ? '▾' : '▸'}</span>
            Advanced — bring your own catalog
            <span className="text-neutral-600">(managed by default)</span>
          </button>
          {showAdvanced && (
            <div className="mt-3">
              <Label htmlFor="catalogDsn">Catalog DSN</Label>
              <Input
                id="catalogDsn"
                value={catalogDsn}
                onChange={(e) => setCatalogDsn(e.target.value)}
                placeholder="postgres://user:pass@host:5432/ducklake"
                className="font-mono"
              />
              <p className="mt-1 text-xs text-neutral-600">
                Postgres DSN for the DuckLake metadata catalog. Leave blank and waddling
                provisions one for you. Stored encrypted.
              </p>
            </div>
          )}
        </Card>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Link href="/dashboard/endpoints">
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </Link>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={!canSubmit}
          >
            Create endpoint
          </Button>
        </div>
      </form>
    </div>
  );
}
