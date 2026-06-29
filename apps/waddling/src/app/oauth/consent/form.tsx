'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { CONTROL_API_BASE } from '@/lib/control-api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { AccessEditor } from '@/components/dashboard/access-editor';
import { flattenGrants, type AccessModel } from '@/lib/access-diff';
import { BrandMark } from '@/components/brand-mark';
import type { DatalakeSummary } from '@/lib/types';

// Human-readable blurbs for the OAuth scopes the MCP flow requests.
const SCOPE_LABELS: Record<string, string> = {
  openid: 'Verify your identity',
  profile: 'Read your basic profile (name)',
  email: 'Read your email address',
  offline_access: 'Stay connected without re-approving each session',
};

export function ConsentForm() {
  const searchParams = useSearchParams();
  const consentCode = searchParams.get('consent_code');
  // client_id from the OAuth query string — used as the clientId key in the delegation row.
  const rawClientId = searchParams.get('client_id') ?? '';
  const clientId = rawClientId || 'An application';
  const scopes = (searchParams.get('scope') ?? '')
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean);

  // ── Scope picker state ────────────────────────────────────────────────────────
  // The same catalog-aware editor used in agent create/settings, in catalogOnly mode.
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);
  const [model, setModel] = useState<AccessModel>({ grants: [], policies: [] });

  // Fetch the user's datalakes so the editor's lake picker can list them. Failure is
  // non-fatal: the editor just shows no lakes to scope.
  useEffect(() => {
    fetch(`${CONTROL_API_BASE}/api/cp/datalakes`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body: { datalakes?: DatalakeSummary[] }) => {
        setDatalakes(body.datalakes ?? []);
      })
      .catch(() => {
        // non-fatal — leave datalakes empty
      });
  }, []);

  // ── Consent state ─────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState<null | 'accept' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);

  // At least one table capability must be granted to allow.
  const noGrants = !model.grants.some((g) => g.caps.length > 0);

  const decide = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'deny');
    setError(null);
    try {
      // On Allow, write the delegation scope BEFORE the Better Auth consent POST.
      // The consent POST navigates away on success so any in-flight request is lost.
      // Delegation failure BLOCKS: completing consent with no delegation would hand the
      // agent an empty grant set (it connects but can do nothing) — surface the error and
      // stop instead of silently approving.
      if (accept && rawClientId) {
        // Map the editor's catalog grants to delegation rows — one row per
        // (lake, schema, table, capability). Delegations can only express catalog
        // capabilities (no pattern column), which is why the editor runs catalogOnly.
        // Drop any grant without a concrete lake (the backend rejects empty datalakeId).
        const rules = flattenGrants(model.grants).filter((r) => r.datalakeId);
        const results = await Promise.all(
          rules.map((r) =>
            fetch(`${CONTROL_API_BASE}/api/cp/delegations`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                clientId: rawClientId,
                datalakeId: r.datalakeId,
                schema: r.schema,
                table: r.table,
                capability: r.capability,
              }),
            }),
          ),
        );
        const failed = results.find((r) => !r.ok);
        if (failed) {
          const data = (await failed.json().catch(() => ({}))) as { detail?: string; error?: string };
          setError(
            data.detail ??
            'Could not grant the agent access to your data. If you are not an org owner or admin, ask one to grant you access to this data lake first.',
          );
          setBusy(null);
          return;
        }
      }

      const res = await fetch(`${CONTROL_API_BASE}/api/auth/oauth2/consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });
      if (res.status === 401) {
        // No session (page opened cold) — authenticate, then come back here.
        window.location.href = `/sign-in?next=${encodeURIComponent(
          `/oauth/consent${window.location.search}`,
        )}`;
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { redirectURI?: string; error_description?: string };
      if (!res.ok || !data.redirectURI) {
        setError(data.error_description ?? 'Could not complete the request. The approval may have expired — reconnect the agent to retry.');
        setBusy(null);
        return;
      }
      // Hand the browser back to the agent's callback (carries the auth code, or an
      // access_denied error on deny).
      window.location.href = data.redirectURI;
    } catch {
      setError('Network error contacting the authorization server.');
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <BrandMark />
          <p className="text-sm text-muted-foreground">Authorize an agent</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck data-icon="inline-start" className="text-primary" />
              {clientId} wants to connect to your Waddling workspace
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!consentCode ? (
              <Alert variant="destructive">
                <AlertTitle>Invalid request</AlertTitle>
                <AlertDescription>
                  This approval link is missing its consent code. Start the connection again from your agent.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-col gap-4">
                {scopes.length > 0 ? (
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      It will be allowed to
                    </p>
                    <ul className="flex flex-col gap-1.5 text-sm">
                      {scopes.map((s) => (
                        <li key={s} className="flex items-start gap-2">
                          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                          <span>{SCOPE_LABELS[s] ?? s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* ── Scope picker — same editor as agent create/settings ──── */}
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Data access scope
                  </p>
                  <div className="h-80 overflow-hidden rounded-md border bg-background/40 p-3">
                    <AccessEditor
                      datalakes={datalakes.map((dl) => ({ id: dl.id, name: dl.name }))}
                      value={model}
                      onChange={setModel}
                      catalogOnly
                    />
                  </div>
                </div>

                {noGrants ? (
                  <Alert>
                    <AlertTitle>No access selected</AlertTitle>
                    <AlertDescription>
                      Grant at least one table capability to allow access.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Request failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    disabled={busy !== null}
                    onClick={() => void decide(false)}
                  >
                    {busy === 'deny' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    Deny
                  </Button>
                  <Button
                    type="button"
                    className="flex-1"
                    disabled={busy !== null || noGrants}
                    onClick={() => void decide(true)}
                  >
                    {busy === 'accept' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    Allow
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          You can revoke access at any time from your dashboard.
        </p>
      </div>
    </div>
  );
}
