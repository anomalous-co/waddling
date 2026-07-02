// UI-only shape for the post-create success screen. NOT a server type — it is
// assembled client-side from the real POST /api/cp/datalakes response
// ({ datalakeId, status }) plus the name/slug the user just submitted, so the
// success view can render without a follow-up fetch. Co-located here (not in
// @/lib/types) because nothing else consumes it.
export interface ProvisionedLake {
  datalakeId: string;
  name: string;
  slug: string;
  status: string;
}
