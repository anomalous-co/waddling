import type { DatalakeSummary } from '@/lib/types';

/** Fixture data lakes for the UX lab. */
export const FIXTURE_DATALAKES: DatalakeSummary[] = [
  {
    id: 'dl_01j8events',
    name: 'Event Lake',
    slug: 'event-lake',
    status: 'running',
    schemas: ['analytics', 'raw'],
  },
  {
    id: 'dl_02j8product',
    name: 'Product Catalog',
    slug: 'product-catalog',
    status: 'provisioning',
  },
];
