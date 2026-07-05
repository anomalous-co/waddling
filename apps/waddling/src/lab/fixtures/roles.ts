/**
 * Birdshot role fixtures for the UX lab.
 *
 *   GET /api/cp/roles?datalakeId= → { roles: [{ name, memberCount }] }
 *
 * The org's named roles, for the Picker's "add role" combobox + grant-to-role.
 * Real production data comes from control-api; this only serves local/lab.
 */

export interface RoleSummary {
  name: string;
  memberCount: number;
}

const ROLES_BY_LAKE: Record<string, RoleSummary[]> = {
  dl_01j8events: [
    { name: 'analyst', memberCount: 3 },
    { name: 'reader', memberCount: 8 },
    { name: 'writer', memberCount: 2 },
    { name: 'admin', memberCount: 1 },
  ],
  dl_02j8product: [
    { name: 'reader', memberCount: 1 },
    { name: 'admin', memberCount: 1 },
  ],
};

export function makeRoles(datalakeId: string): RoleSummary[] {
  return ROLES_BY_LAKE[datalakeId] ?? [{ name: 'reader', memberCount: 0 }, { name: 'admin', memberCount: 0 }];
}
