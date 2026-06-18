'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Card,
  CardHeader,
  Badge,
  Button,
  statusVariant,
  Spinner,
  ErrorState,
  EmptyState,
  SectionTitle,
  Table,
  Td,
} from '@/components/dashboard/ui';
import { fetchCp } from '@/components/dashboard/fetch';
import type { EndpointSummary } from '@/lib/types';

export default function EndpointsPage() {
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<{ endpoints: EndpointSummary[] }>('/api/cp/endpoints');
    if (!res.ok) {
      setError(res.error);
    } else {
      setEndpoints(res.data.endpoints);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          <Link href="/dashboard/endpoints/new">
            <Button variant="primary" size="sm">
              + New endpoint
            </Button>
          </Link>
        }
      >
        Endpoints
      </SectionTitle>
      <Card>
        <CardHeader
          title="Lakehouse endpoints"
          subtitle="Each endpoint is a governed DuckDB gateway attached to a DuckLake."
        />
        {endpoints.length === 0 ? (
          <EmptyState
            title="No endpoints yet"
            description="Connect your object storage and waddling provisions a governed gateway in front of it."
            action={
              <Link href="/dashboard/endpoints/new">
                <Button variant="primary" size="sm">
                  + Create your first endpoint
                </Button>
              </Link>
            }
          />
        ) : (
          <Table headers={['Name', 'Slug', 'Status', 'Schemas', '']}>
            {endpoints.map((ep) => (
              <tr key={ep.id}>
                <Td>
                  <Link
                    href={`/dashboard/endpoints/${ep.id}`}
                    className="text-blue-400 hover:underline font-medium"
                  >
                    {ep.name}
                  </Link>
                </Td>
                <Td mono>{ep.slug}</Td>
                <Td>
                  <Badge variant={statusVariant(ep.status)}>{ep.status}</Badge>
                </Td>
                <Td>{ep.schemas?.join(', ') ?? '—'}</Td>
                <Td>
                  <Link
                    href={`/dashboard/endpoints/${ep.id}`}
                    className="text-xs text-neutral-500 hover:text-neutral-300"
                  >
                    Details →
                  </Link>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
