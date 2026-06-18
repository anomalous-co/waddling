'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import {
  Card,
  CardHeader,
  Badge,
  Button,
  statusVariant,
  Spinner,
  ErrorState,
  SectionTitle,
  CodeBlock,
  Table,
  Td,
} from '@/components/dashboard/ui';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type { EndpointStatus, TableInfo } from '@/lib/types';

interface EndpointDetail {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  gatewayHost?: string;
  quackPort?: number;
  catalogDsn?: string;
  dataPath?: string;
  region?: string;
  encrypted?: boolean;
  createdAt?: string;
  schemas?: TableInfo[];
  birdshotStatus?: EndpointStatus['birdshotStatus'];
  duckLakeSnapshotLag?: number;
}

function AttachString({
  host,
  port,
  endpointId,
}: {
  host: string;
  port: number;
  endpointId: string;
}) {
  const sql = `ATTACH 'quack:${host}:${port}' AS lake (TOKEN '<session_jwt>', DISABLE_SSL false)
-- Get a session JWT via: POST /api/cp/sessions  or  waddling_connect({ endpoint_id: '${endpointId}' })`;
  return (
    <div>
      <p className="text-xs text-neutral-500 mb-1">ATTACH string</p>
      <CodeBlock code={sql} />
    </div>
  );
}

export default function EndpointDetailPage() {
  const params = useParams<{ id: string }>();
  const [ep, setEp] = useState<EndpointDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<{ endpoint: EndpointDetail }>(
      `/api/cp/endpoints/${params.id}`,
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      setEp(res.data.endpoint);
    }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the gateway is booting, poll until it reports running (or errors).
  useEffect(() => {
    if (ep?.status !== 'provisioning') return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [ep?.status, load]);

  // Local-only: complete provisioning without the W3 orchestrator. Resolves the
  // stored (encrypted) credentials server-side and flips the endpoint to running.
  const provisionLocally = useCallback(async () => {
    setProvisionError(null);
    setProvisioning(true);
    const res = await cpPost(`/api/cp/endpoints/${params.id}/provision`, {});
    setProvisioning(false);
    if (!res.ok) setProvisionError(res.error);
    else void load();
  }, [params.id, load]);

  if (loading)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;
  if (!ep) return null;

  return (
    <div className="space-y-4">
      <SectionTitle>
        Endpoint: <span className="font-mono text-blue-300">{ep.name}</span>
      </SectionTitle>

      {/* Status + meta */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Status" />
          <div className="space-y-2">
            <Row label="Status">
              <Badge variant={statusVariant(ep.status)}>{ep.status}</Badge>
            </Row>
            <Row label="Slug">
              <code className="font-mono text-xs text-neutral-300">{ep.slug}</code>
            </Row>
            {ep.region && <Row label="Region">{ep.region}</Row>}
            {ep.encrypted !== undefined && (
              <Row label="Encrypted">{ep.encrypted ? 'Yes' : 'No'}</Row>
            )}
            {ep.createdAt && (
              <Row label="Created">
                {new Date(ep.createdAt).toLocaleString()}
              </Row>
            )}
          </div>
        </Card>

        {ep.birdshotStatus && (
          <Card>
            <CardHeader title="Gateway health" />
            <div className="space-y-2">
              <Row label="Auth mode">{ep.birdshotStatus.authMode}</Row>
              <Row label="Policy size">
                {ep.birdshotStatus.policySize} rules
              </Row>
              <Row label="Sessions">
                {ep.birdshotStatus.sessionCount} active
              </Row>
              <Row label="Audit ring">
                {ep.birdshotStatus.auditRingDepth} entries
              </Row>
              {ep.duckLakeSnapshotLag !== undefined && (
                <Row label="Snapshot lag">
                  {ep.duckLakeSnapshotLag}ms
                </Row>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* Provisioning — gateway not yet live */}
      {ep.status === 'provisioning' && (
        <Card>
          <CardHeader
            title="Provisioning"
            subtitle="Setting up the governed gateway in front of your storage."
          />
          <ol className="space-y-2 text-sm text-neutral-400">
            <li className="flex items-center gap-2">
              <Spinner size="sm" /> Gateway is starting up…
            </li>
            <li className="flex items-center gap-2 text-neutral-600">
              <span className="w-3 text-center">2</span> Catalog &amp; storage attach
            </li>
            <li className="flex items-center gap-2 text-neutral-600">
              <span className="w-3 text-center">3</span> Your <code>ATTACH</code> string appears
              here once it&apos;s running
            </li>
          </ol>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Refresh status
            </Button>
            {/* Local dev only: no W3 orchestrator, so finish the boot by hand.
                Hidden in production (the route itself also 403s there). */}
            {process.env.NODE_ENV !== 'production' && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  loading={provisioning}
                  onClick={() => void provisionLocally()}
                >
                  Provision locally
                </Button>
                <span className="text-xs text-neutral-600">
                  Production boot is automatic; this button is the local stand-in.
                </span>
              </>
            )}
          </div>
          {provisionError && (
            <p className="mt-2 text-xs text-red-400">{provisionError}</p>
          )}
        </Card>
      )}

      {/* ATTACH string */}
      {ep.gatewayHost && ep.quackPort && (
        <Card>
          <CardHeader
            title="Connect"
            subtitle="Copy this ATTACH string into your agent's DuckDB instance."
          />
          <AttachString
            host={ep.gatewayHost}
            port={ep.quackPort}
            endpointId={ep.id}
          />
        </Card>
      )}

      {/* Schemas */}
      <Card>
        <CardHeader
          title="Schemas & Tables"
          subtitle="Tables accessible through this endpoint (filtered to your granted ACLs)."
        />
        {!ep.schemas || ep.schemas.length === 0 ? (
          <p className="text-sm text-neutral-500">No schema data available.</p>
        ) : (
          <div className="space-y-4">
            {ep.schemas.map((tbl) => (
              <div key={`${tbl.schema}.${tbl.table}`}>
                <p className="text-xs font-mono text-neutral-400 mb-1">
                  <span className="text-neutral-500">{tbl.schema}.</span>
                  <span className="text-green-300">{tbl.table}</span>
                  {tbl.rowEstimate !== undefined && (
                    <span className="ml-2 text-neutral-600">
                      ~{tbl.rowEstimate.toLocaleString()} rows
                    </span>
                  )}
                </p>
                <Table headers={['Column', 'Type', 'Nullable']}>
                  {tbl.columns.map((col) => (
                    <tr key={col.name}>
                      <Td mono>{col.name}</Td>
                      <Td mono>{col.type}</Td>
                      <Td>{col.nullable ? 'yes' : 'no'}</Td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm text-neutral-300">{children}</span>
    </div>
  );
}
