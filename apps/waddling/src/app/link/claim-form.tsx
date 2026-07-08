'use client';

/**
 * Device-link claim form (FUNNEL / Stream B, self-contained).
 *
 * Posts to /api/cp/device-link/claim with the session cookie. On success it
 * shows the "return to your terminal" screen — the agent is polling and will
 * pick up the freshly-minted API key on its next poll.
 */
import { useState, type FormEvent } from 'react';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { cpUrl } from '@/lib/control-api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

interface OrgOption {
  id: string;
  name: string;
}

export function ClaimForm({
  initialCode,
  orgs,
}: {
  initialCode: string;
  orgs: OrgOption[];
}) {
  const [code, setCode] = useState(initialCode);
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [agentName, setAgentName] = useState('claude-code');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setExpired(false);
    try {
      const res = await fetch(cpUrl('/api/cp/device-link/claim'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, orgId, agentName }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        // Codes live 15 minutes. A first-time user who signs up + verifies email + onboards
        // can blow that TTL before reaching this form — the reliable recovery is to re-run
        // the tool for a fresh code (now instant, since they're signed-in with an org).
        if (body.error === 'invalid_code') {
          setExpired(true);
        } else {
          setError(body.detail ?? body.error ?? 'Could not claim this code.');
        }
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle2 className="size-10 text-primary" />
          <CardTitle className="text-base">Return to your terminal</CardTitle>
          <p className="text-sm text-muted-foreground">
            Your agent is now connected. It will detect the link automatically and continue what you
            asked it to do — you can close this tab.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (expired) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <CardTitle className="text-base">This link expired</CardTitle>
          <p className="text-sm text-muted-foreground">
            Connection codes are valid for 15 minutes. Your account is all set now — head back to
            your terminal and ask your agent to connect again (it will run{' '}
            <code className="font-mono">waddling_signup</code>), then open the fresh link. It only
            takes a few seconds this time.
          </p>
          <Button variant="outline" onClick={() => setExpired(false)}>
            Enter a new code manually
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect this agent</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="code">Code</FieldLabel>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX"
                required
                autoFocus={!initialCode}
                className="font-mono uppercase tracking-widest"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="org">Organization</FieldLabel>
              <Select value={orgId} onValueChange={setOrgId}>
                <SelectTrigger id="org" className="w-full">
                  <SelectValue placeholder="Select organization" />
                </SelectTrigger>
                <SelectContent>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="agentName">Agent name</FieldLabel>
              <Input
                id="agentName"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="claude-code"
                required
              />
            </Field>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Could not connect agent</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {loading ? 'Connecting…' : 'Connect agent'}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
