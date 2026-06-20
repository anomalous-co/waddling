'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Check, Copy, RefreshCw, Plug } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { toast } from 'sonner';
import type {
  DatalakeSummary,
  AgentSummary,
  DeviceLinkInit,
} from '@/lib/types';

// ── Colocated helpers (module scope — never nested inside components) ──────────

// The agent-facing quack address is derived from the data lake slug (host/port
// are no longer returned by the API). Per-tenant CF data-plane ingress over
// HTTPS:443, so the port is omitted (443 is the quack default). Keep this in
// sync with gatewayAddrFor in datalakes/[id]/page.tsx.
function attachSqlFor(datalake: DatalakeSummary | null): string {
  if (!datalake) {
    return [
      '-- Create a data lake first, then these statements connect your DuckDB',
      "CREATE SECRET (TYPE quack, TOKEN '<session_jwt>', SCOPE 'quack:<host>');",
      "ATTACH 'quack:<host>' AS lake (disable_ssl true);",
    ].join('\n');
  }
  const addr = `quack:gw-${datalake.slug}.getwaddling.com`;
  return [
    `-- Run these in your DuckDB to connect to the ${datalake.name} lake`,
    `CREATE SECRET (TYPE quack, TOKEN '<session_jwt>', SCOPE '${addr}');`,
    `ATTACH '${addr}' AS lake (disable_ssl true);`,
  ].join('\n');
}

const MCP_JSON = JSON.stringify(
  {
    mcpServers: {
      waddling: {
        command: 'npx',
        args: ['-y', '@waddling/mcp@latest'],
        env: {
          WADDLING_URL: 'https://api.getwaddling.com',
          WADDLING_API_KEY: '<your-agent-key>',
        },
      },
    },
  },
  null,
  2,
);

const EXTENSION_SQL = [
  'SET allow_unsigned_extensions = true;',
  "INSTALL birdshot FROM 'https://ext.getwaddling.com';",
  'LOAD birdshot;',
].join('\n');

// ── Sub-components ─────────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => toast('Copied'));
  }, [code]);

  return (
    <div className="relative rounded-lg border bg-muted/50">
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-7 text-muted-foreground hover:text-foreground"
        onClick={copy}
        aria-label="Copy to clipboard"
      >
        <Copy />
      </Button>
      <pre className="overflow-x-auto p-4 pr-10 font-mono text-xs leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}

function StepNumber({ n, done }: { n: number; done: boolean }) {
  return (
    <div
      className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2 font-mono text-sm font-semibold ${
        done
          ? 'border-green-500 bg-green-500/10 text-green-700 dark:text-green-400'
          : 'border-muted-foreground/40 text-muted-foreground'
      }`}
    >
      {done ? <Check className="size-4" /> : n}
    </div>
  );
}

function DeviceCodePanel() {
  const [linkData, setLinkData] = useState<DeviceLinkInit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = useCallback(async () => {
    setLoading(true);
    setError(null);
    const deviceId = crypto.randomUUID();
    const res = await cpPost<DeviceLinkInit>('/api/cp/device-link', { deviceId });
    if (res.ok) {
      setLinkData(res.data);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  const copyCode = useCallback(() => {
    if (!linkData?.code) return;
    void navigator.clipboard.writeText(linkData.code).then(() => toast('Copied'));
  }, [linkData]);

  if (!linkData) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Your agent displays a short code; you claim it here to bind a new API key to your
          account automatically.
        </p>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Failed to mint code</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              {error}
              <Button variant="outline" size="sm" onClick={() => void mint()}>
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <div>
          <Button onClick={() => void mint()} disabled={loading}>
            {loading ? (
              <>
                <RefreshCw data-icon="inline-start" className="animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Plug data-icon="inline-start" />
                Generate device code
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  const expiresAt = new Date(linkData.expiresAt);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Share this code with your agent or paste it at{' '}
        <a
          href={linkData.verifyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-4"
        >
          {linkData.verifyUrl}
        </a>
        . Expires at {expiresAt.toLocaleTimeString()}.
      </p>
      <div className="flex items-center gap-3">
        <span className="font-mono text-3xl font-bold tracking-widest text-foreground">
          {linkData.code}
        </span>
        <Button variant="outline" size="sm" onClick={copyCode}>
          <Copy data-icon="inline-start" />
          Copy
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setLinkData(null);
            void mint();
          }}
        >
          <RefreshCw data-icon="inline-start" />
          New code
        </Button>
      </div>
    </div>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function OnboardingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [datalakes, setDatalakes] = useState<DatalakeSummary[] | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [endRes, agentRes] = await Promise.all([
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
    ]);

    if (!endRes.ok || !agentRes.ok) {
      setError('Failed to load onboarding data');
      setLoading(false);
      return;
    }

    setDatalakes(endRes.data.datalakes ?? []);
    setAgents(agentRes.data.agents ?? []);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <OnboardingSkeleton />;

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load onboarding</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const hasDatalake = (datalakes?.length ?? 0) > 0;
  const hasAgent = (agents?.length ?? 0) > 0;
  const firstDatalake = datalakes?.[0] ?? null;
  const firstAgent = agents?.[0] ?? null;

  const attachSql = attachSqlFor(firstDatalake);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect</h1>
        <p className="text-sm text-muted-foreground">
          Get your first agent querying a governed data lake in four steps.
        </p>
      </div>

      {/* ── Step 1: Create a data lake ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <StepNumber n={1} done={hasDatalake} />
            <div className="flex flex-col gap-1">
              <CardTitle>Create a data lake</CardTitle>
              <CardDescription>
                Provision a data lake that governs access to your DuckLake.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {hasDatalake ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{firstDatalake!.name}</span>
              <StatusBadge status={firstDatalake!.status} />
              {(datalakes?.length ?? 0) > 1 ? (
                <Badge variant="secondary" className="text-xs">
                  +{(datalakes?.length ?? 0) - 1} more
                </Badge>
              ) : null}
              <Link
                href="/dashboard/datalakes"
                className="ml-auto text-xs text-primary underline-offset-4 hover:underline"
              >
                View all
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <p className="text-sm text-muted-foreground">
                No data lakes yet. Create one to get started.
              </p>
              <Button asChild size="sm">
                <Link href="/dashboard/datalakes/new">Create data lake</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Create an agent ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <StepNumber n={2} done={hasAgent} />
            <div className="flex flex-col gap-1">
              <CardTitle>Create an agent</CardTitle>
              <CardDescription>
                Register the LLM agent that will query your lake.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {hasAgent ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{firstAgent!.name}</span>
              <StatusBadge status={firstAgent!.status} />
              {(agents?.length ?? 0) > 1 ? (
                <Badge variant="secondary" className="text-xs">
                  +{(agents?.length ?? 0) - 1} more
                </Badge>
              ) : null}
              <Link
                href="/dashboard/agents"
                className="ml-auto text-xs text-primary underline-offset-4 hover:underline"
              >
                View all
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <p className="text-sm text-muted-foreground">
                No agents yet. Create one to issue a governed API key.
              </p>
              <Button asChild size="sm">
                <Link href="/dashboard/agents">Create agent</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 3: Connect your agent ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <StepNumber n={3} done={false} />
            <div className="flex flex-col gap-1">
              <CardTitle>Connect your agent</CardTitle>
              <CardDescription>
                Pick the integration method that matches your setup.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="mcp">
            <TabsList>
              <TabsTrigger value="mcp">MCP server</TabsTrigger>
              <TabsTrigger value="attach">ATTACH string</TabsTrigger>
              <TabsTrigger value="device">Device code</TabsTrigger>
              <TabsTrigger value="extension">Install extension</TabsTrigger>
            </TabsList>

            {/* MCP server */}
            <TabsContent value="mcp" className="mt-4">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Add this to your Claude (or any MCP-compatible) config file. The MCP server
                  handles auth, session management, and governed query forwarding automatically.
                </p>
                <CodeBlock code={MCP_JSON} />
                <p className="text-xs text-muted-foreground">
                  Replace{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">&lt;your-agent-key&gt;</code>{' '}
                  with the API key shown when you created your agent.
                </p>
              </div>
            </TabsContent>

            {/* ATTACH string */}
            <TabsContent value="attach" className="mt-4">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Use these SQL statements directly in your DuckDB session. The{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">&lt;session_jwt&gt;</code>{' '}
                  is minted by{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">waddling_connect</code> via
                  the MCP server.
                </p>
                <CodeBlock code={attachSql} />
                {!firstDatalake ? (
                  <p className="text-xs text-muted-foreground">
                    The connect string is filled in once you{' '}
                    <span className="font-medium text-foreground">
                      create a data lake
                    </span>{' '}
                    above.
                  </p>
                ) : null}
              </div>
            </TabsContent>

            {/* Device code */}
            <TabsContent value="device" className="mt-4">
              <DeviceCodePanel />
            </TabsContent>

            {/* Install extension */}
            <TabsContent value="extension" className="mt-4">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Load the birdshot extension in any DuckDB v1.5.3 instance. Required when your
                  agent runs its own local governed DuckDB rather than connecting through the
                  waddling gateway.
                </p>
                <CodeBlock code={EXTENSION_SQL} />
                <p className="text-xs text-muted-foreground">
                  DuckDB version pinned at{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">v1.5.3</code>. The
                  extension is served via CDN at{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">
                    https://ext.getwaddling.com
                  </code>
                  .
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* ── Step 4: Set access ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <StepNumber n={4} done={false} />
            <div className="flex flex-col gap-1">
              <CardTitle>
                Set access{' '}
                <Badge variant="secondary" className="ml-1 align-middle text-xs font-normal">
                  optional
                </Badge>
              </CardTitle>
              <CardDescription>
                Define per-agent table-level ACL rules. Without rules, agents have no access.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <p className="text-sm text-muted-foreground">
              Grant read or write access to specific tables, columns, or time windows.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/acl">Configure access</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <p className="text-xs text-muted-foreground">
        Need help?{' '}
        <a
          href="https://docs.getwaddling.com"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          Read the docs
        </a>
        {' '}or reach out at{' '}
        <a
          href="mailto:support@getwaddling.com"
          className="text-primary underline-offset-4 hover:underline"
        >
          support@getwaddling.com
        </a>
        .
      </p>
    </div>
  );
}
