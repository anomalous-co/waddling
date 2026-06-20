'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { CONTROL_API_BASE } from '@/lib/control-api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  // selectedLake: null = all lakes (no datalake_id filter on the delegation)
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);
  const [selectedLake, setSelectedLake] = useState<string | null>(null);
  const [capRead, setCapRead] = useState(true);
  const [capWrite, setCapWrite] = useState(false);

  // Fetch the user's datalakes so the picker can list them. Failure is non-fatal:
  // the picker just shows only the "All data lakes" option.
  useEffect(() => {
    fetch(`${CONTROL_API_BASE}/api/cp/datalakes`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body: { datalakes?: DatalakeSummary[] }) => {
        setDatalakes(body.datalakes ?? []);
      })
      .catch(() => {
        // non-fatal — leave datalakes empty, "All data lakes" remains the only option
      });
  }, []);

  // ── Consent state ─────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState<null | 'accept' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);

  // At least one capability must be checked to allow.
  const noCapability = !capRead && !capWrite;

  const decide = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'deny');
    setError(null);
    try {
      // On Allow, write the delegation scope BEFORE the Better Auth consent POST.
      // The consent POST navigates away on success so any in-flight request is lost.
      // Delegation failure is non-blocking: proceed to consent regardless.
      if (accept && rawClientId) {
        const capabilities = [
          ...(capRead ? ['read' as const] : []),
          ...(capWrite ? ['write' as const] : []),
        ];
        // One delegation row per capability (the delegation schema takes one capability each).
        await Promise.allSettled(
          capabilities.map((capability) =>
            fetch(`${CONTROL_API_BASE}/api/cp/delegations`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                clientId: rawClientId,
                datalakeId: selectedLake ?? undefined,
                schema: '*',
                table: '*',
                capability,
              }),
            }),
          ),
        );
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
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <BrandMark />
          <p className="text-sm text-muted-foreground">Authorize an agent</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck data-icon="inline-start" className="text-primary" />
              Connect {clientId}?
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
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{clientId}</span> wants to connect to your
                  waddling workspace and act on your behalf. It will query your data lakes only through your
                  organization&rsquo;s access policies.
                </p>

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

                {/* ── Scope picker ─────────────────────────────────────────── */}
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Data access scope
                  </p>
                  <div className="flex flex-col gap-3">
                    {/* Datalake selector */}
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">Data lake</Label>
                      <Select
                        value={selectedLake ?? '__all__'}
                        onValueChange={(v) => setSelectedLake(v === '__all__' ? null : v)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">All data lakes</SelectItem>
                          {datalakes.map((dl) => (
                            <SelectItem key={dl.id} value={dl.id}>
                              {dl.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Capability checkboxes */}
                    <div className="flex flex-col gap-2">
                      <Label className="text-xs text-muted-foreground">Capabilities</Label>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="cap-read"
                          checked={capRead}
                          onCheckedChange={(v) => setCapRead(!!v)}
                        />
                        <Label htmlFor="cap-read" className="text-sm font-normal">
                          Read — query tables
                        </Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="cap-write"
                          checked={capWrite}
                          onCheckedChange={(v) => setCapWrite(!!v)}
                        />
                        <Label htmlFor="cap-write" className="text-sm font-normal">
                          Write — insert, update, delete rows
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>

                {noCapability ? (
                  <Alert>
                    <AlertTitle>No capability selected</AlertTitle>
                    <AlertDescription>
                      Select at least one capability to allow access.
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
                    disabled={busy !== null || noCapability}
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
