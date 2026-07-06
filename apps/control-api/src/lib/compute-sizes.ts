/**
 * Compute instance-size ladder — the metered-usage dimension.
 *
 * A workspace runs at one of these sizes; session wall-clock is billed at the size's
 * per-hour retail rate (per-second granularity). Rates are cost-plus at ~80% gross
 * margin over Cloud Run COGS ($0.0864/vCPU-hr + $0.009/GiB-hr); the smallest (Duckling)
 * is the base unit the included-compute envelope is denominated in.
 *
 * ONE source of truth, consumed by:
 *  - credits.ts       → per-session debit rate (size $/hr) + the Duckling base rate the
 *                       monthly included-compute grant is priced in.
 *  - the provisioner  → size → Cloud Run {cpu, memory} (apps/dataplane/provisioner).
 *  - billing/pricing  → display + the Stripe compute meter.
 *
 * Undercuts MotherDuck across the board (their Pulse $0.60/hr → Giga $36/hr).
 */
export type ComputeSizeId = 'duckling' | 'mallard' | 'goose' | 'swan';

export interface ComputeSize {
  id: ComputeSizeId;
  label: string;
  /** Cloud Run vCPU allocation. */
  cpu: number;
  /** Cloud Run memory (GiB). Cloud Run allows up to 8 vCPU / 32 GiB — Swan is the ceiling. */
  memoryGb: number;
  /** Retail price per wall-clock hour (USD), billed per-second. */
  usdPerHour: number;
}

/** The default size a workspace provisions at (and the base unit for the compute envelope). */
export const DEFAULT_COMPUTE_SIZE: ComputeSizeId = 'duckling';

export const COMPUTE_SIZES: Record<ComputeSizeId, ComputeSize> = {
  duckling: { id: 'duckling', label: 'Duckling', cpu: 1, memoryGb: 2, usdPerHour: 0.55 },
  mallard: { id: 'mallard', label: 'Mallard', cpu: 2, memoryGb: 8, usdPerHour: 1.25 },
  goose: { id: 'goose', label: 'Goose', cpu: 4, memoryGb: 16, usdPerHour: 2.5 },
  swan: { id: 'swan', label: 'Swan', cpu: 8, memoryGb: 32, usdPerHour: 4.95 },
};

/** Base unit rate: the price of one Duckling-hour. The included-compute envelope is N of these. */
export const DUCKLING_USD_PER_HOUR = COMPUTE_SIZES.duckling.usdPerHour;

/** Order of increasing capability (for pickers / ranking). */
export const COMPUTE_SIZE_ORDER: readonly ComputeSizeId[] = ['duckling', 'mallard', 'goose', 'swan'];

/** Resolve a size id defensively (unknown / legacy → the default). */
export function resolveComputeSize(id: string | null | undefined): ComputeSize {
  return COMPUTE_SIZES[(id ?? '') as ComputeSizeId] ?? COMPUTE_SIZES[DEFAULT_COMPUTE_SIZE];
}
