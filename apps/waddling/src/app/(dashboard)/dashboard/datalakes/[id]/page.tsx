'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Copy, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { GatewayPanel } from '@/components/dashboard/gateway-panel';
import { WorkspacesPanel } from '@/components/dashboard/workspaces-panel';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type {
  DatalakeRuntime,
  GatewayRuntimeState,
  TableInfo,
} from '@/lib/types';

// Birdshot gateway health, returned by GET /api/cp/datalakes/:id alongside the
// datalake. Not part of the shared DatalakeDetail contract (best-effort, omitted
// when the gateway is unreachable), so it's typed locally where it's read.
interface BirdshotStatus {
  authMode: string;
  policySize: number;
  sessionCount: number;
  auditRingDepth: number;
}

// Gateways are never user-created: they're a scale-to-zero pool that only
// surfaces as a data lake's runtime status (see GatewayRuntimeState). The detail
// response extends the shared DatalakeDetail with the fields the dashboard shows.
interface DatalakeDetail {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  runtime?: DatalakeRuntime;
  catalogDsn?: string;
  dataPath?: string;
  region?: string;
  encrypted?: boolean;
  createdAt?: string;
  schemas?: TableInfo[];
  birdshotStatus?: BirdshotStatus;
  duckLakeSnapshotLag?: number;
}

// The agent-facing quack address is derived from the data lake slug (host/port
// are no longer returned by the API). Per-tenant CF data-plane ingress over
// HTTPS:443, so the port is omitted (443 is the quack default). Change here if
// the convention shifts.
function gatewayAddrFor(slug: string): string {
  return `quack:gw-${slug}.getwaddling.com`;
}

// Human-readable runtime line for the status block.
const RUNTIME_LABEL: Record<GatewayRuntimeState, string> = {
  running: 'Running',
  asleep: 'Asleep — wakes on demand',
  provisioning: 'Provisioning',
  error: 'Error',
  unconfigured: 'Not configured',
};

// ── Sub-components (module scope — no nested definitions) ─────────────────────

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function DatalakeDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function RuntimeBlock({ runtime }: { runtime: DatalakeRuntime }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-xs text-muted-foreground">Gateway</span>
      <span className="flex items-center gap-2 text-sm">
        <StatusBadge status={runtime.state} />
        {runtime.state === 'running' && runtime.replicas > 0 ? (
          <span className="text-muted-foreground">
            {runtime.replicas}{' '}
            {runtime.replicas === 1 ? 'replica' : 'replicas'}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {RUNTIME_LABEL[runtime.state]}
          </span>
        )}
      </span>
    </div>
  );
}

function AttachCard({
  addr,
  datalakeId,
}: {
  addr: string;
  datalakeId: string;
}) {
  const sql = `ATTACH '${addr}' AS lake (TOKEN '<session_jwt>', DISABLE_SSL false)\n-- Get a session JWT via: POST /api/cp/sessions  or  waddling_connect({ datalake_id: '${datalakeId}' })`;

  const handleCopy = () => {
    void navigator.clipboard.writeText(sql).then(() => {
      toast('Copied');
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Connect</CardTitle>
            <CardDescription>
              Copy this ATTACH string into your agent's DuckDB instance.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <Copy data-icon="inline-start" />
            Copy
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-md bg-muted px-4 py-3 text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all">
          {sql}
        </pre>
      </CardContent>
    </Card>
  );
}

function ProvisioningCard({
  onRefresh,
  onProvisionLocally,
  provisioning,
  provisionError,
}: {
  onRefresh: () => void;
  onProvisionLocally: () => void;
  provisioning: boolean;
  provisionError: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Provisioning</CardTitle>
        <CardDescription>
          Setting up the governed gateway in front of your storage.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" />
            Gateway is starting up…
          </li>
          <li className="flex items-center gap-2">
            <span className="w-3 text-center text-xs">2</span>
            Catalog &amp; storage attach
          </li>
          <li className="flex items-center gap-2">
            <span className="w-3 text-center text-xs">3</span>
            Your <code className="font-mono">ATTACH</code> string appears here
            once it&apos;s running
          </li>
        </ol>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw data-icon="inline-start" />
            Refresh status
          </Button>
          {process.env.NODE_ENV !== 'production' ? (
            <>
              <Button
                variant="default"
                size="sm"
                disabled={provisioning}
                onClick={onProvisionLocally}
              >
                {provisioning ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : null}
                Provision locally
              </Button>
              <span className="text-xs text-muted-foreground">
                Production boot is automatic; this button is the local stand-in.
              </span>
            </>
          ) : null}
        </div>

        {provisionError ? (
          <p className="text-xs text-red-500 dark:text-red-400">{provisionError}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SchemasCard({ schemas }: { schemas?: TableInfo[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Schemas &amp; Tables</CardTitle>
        <CardDescription>
          Tables accessible through this data lake (filtered to your granted ACLs).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!schemas || schemas.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No schema data available</EmptyTitle>
              <EmptyDescription>
                Schema information appears here once the gateway is running and
                has completed its first catalog snapshot.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-6">
            {schemas.map((tbl, idx) => (
              <div key={`${tbl.schema}.${tbl.table}`} className="flex flex-col gap-2">
                {idx > 0 ? <Separator /> : null}
                <p className="font-mono text-xs text-muted-foreground">
                  <span>{tbl.schema}.</span>
                  <span className="text-foreground font-semibold">{tbl.table}</span>
                  {tbl.rowEstimate !== undefined ? (
                    <span className="ml-2 text-muted-foreground/70">
                      ~{tbl.rowEstimate.toLocaleString()} rows
                    </span>
                  ) : null}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Nullable</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tbl.columns.map((col) => (
                      <TableRow key={col.name}>
                        <TableCell className="font-mono text-xs">{col.name}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {col.type}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {col.nullable ? 'yes' : 'no'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DatalakeDetailPage() {
  const params = useParams<{ id: string }>();
  const [dl, setDl] = useState<DatalakeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<{ datalake: DatalakeDetail }>(
      `/api/cp/datalakes/${params.id}`,
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      setDl(res.data.datalake);
      setError(null);
    }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the gateway is booting, poll until it reports running (or errors).
  // `runtime` is absent until the backend lands the reshape; fall back to the
  // lifecycle `status` so booting data lakes still poll.
  const runtimeState = dl?.runtime?.state ?? dl?.status;
  useEffect(() => {
    if (runtimeState !== 'provisioning') return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [runtimeState, load]);

  // Local-only: complete provisioning without the orchestrator. Resolves the
  // stored (encrypted) credentials server-side and flips the data lake to running.
  const provisionLocally = useCallback(async () => {
    setProvisionError(null);
    setProvisioning(true);
    const res = await cpPost(`/api/cp/datalakes/${params.id}/provision`, {});
    setProvisioning(false);
    if (!res.ok) setProvisionError(res.error);
    else void load();
  }, [params.id, load]);

  const handleRetry = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  if (loading) return <DatalakeDetailSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load data lake</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button variant="outline" size="sm" onClick={handleRetry}>
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  if (!dl) return null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {dl.name}
        </h1>
        <p className="text-sm text-muted-foreground font-mono">{dl.slug}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Status card */}
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <DetailRow label="Status">
              <StatusBadge status={dl.status} />
            </DetailRow>
            {dl.runtime ? <RuntimeBlock runtime={dl.runtime} /> : null}
            <DetailRow label="Slug">
              <code className="font-mono text-xs">{dl.slug}</code>
            </DetailRow>
            {dl.region ? (
              <DetailRow label="Region">{dl.region}</DetailRow>
            ) : null}
            {dl.encrypted !== undefined ? (
              <DetailRow label="Encrypted">{dl.encrypted ? 'Yes' : 'No'}</DetailRow>
            ) : null}
            {dl.createdAt ? (
              <DetailRow label="Created">
                {new Date(dl.createdAt).toLocaleString()}
              </DetailRow>
            ) : null}
          </CardContent>
        </Card>

        {/* Gateway health card */}
        <Card>
          <CardHeader>
            <CardTitle>Gateway health</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {dl.birdshotStatus ? (
              <>
                <DetailRow label="Auth mode">{dl.birdshotStatus.authMode}</DetailRow>
                <DetailRow label="Policy size">
                  {dl.birdshotStatus.policySize} rules
                </DetailRow>
                <DetailRow label="Sessions">
                  {dl.birdshotStatus.sessionCount} active
                </DetailRow>
                <DetailRow label="Audit ring">
                  {dl.birdshotStatus.auditRingDepth} entries
                </DetailRow>
                {dl.duckLakeSnapshotLag !== undefined ? (
                  <DetailRow label="Snapshot lag">
                    {dl.duckLakeSnapshotLag}ms
                  </DetailRow>
                ) : null}
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No gateway data</EmptyTitle>
                  <EmptyDescription>
                    Health metrics appear once the gateway is running.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      {runtimeState === 'provisioning' ? (
        <ProvisioningCard
          onRefresh={() => void load()}
          onProvisionLocally={() => void provisionLocally()}
          provisioning={provisioning}
          provisionError={provisionError}
        />
      ) : null}

      <AttachCard addr={gatewayAddrFor(dl.slug)} datalakeId={dl.id} />

      <SchemasCard schemas={dl.schemas} />

      {/* Gateway lifecycle + workspace recovery (Steps 1–5, 7) */}
      <GatewayPanel datalakeId={dl.id} />
      <WorkspacesPanel datalakeId={dl.id} />
    </div>
  );
}
