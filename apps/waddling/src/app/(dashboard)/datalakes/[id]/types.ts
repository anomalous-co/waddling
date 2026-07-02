/**
 * UI-only view models for the data-lake detail page.
 *
 * The real /api/cp/* responses are mapped into these shapes ONCE at the fetch
 * boundary (see page.tsx adapters), so the section components never have to deal
 * with a missing field. Anything the real API does not return (catalog row
 * estimates, workspace size / scratch tables, a gateway endpoint object) is
 * derived or defaulted here rather than guarded in JSX.
 *
 * These intentionally do NOT extend the shared control-schema types — they are a
 * presentation contract local to this page, not an API contract.
 */
import type { SemanticStatus } from '@/components/waddling/status-dot';
import type { DatalakeDetail } from '@/lib/types';

export interface CatalogColumnVM {
  name: string;
  type: string;
}

export interface CatalogTableVM {
  table: string;
  /** Number of columns (for display). */
  columnCount: number;
  /** Full column definitions (name + type). */
  columns?: CatalogColumnVM[];
  /** Estimated row count — the real catalog snapshot does not carry one. */
  rowEstimate?: number;
}

export interface CatalogSchemaVM {
  schema: string;
  tables: CatalogTableVM[];
}

/** Gateway endpoint metadata, derived from the lake slug + runtime state. */
export interface GatewayInfoVM {
  /** The quack: host (without scheme) agents connect to. */
  endpointUrl: string;
  region: string;
  status: SemanticStatus;
}

/** The lake the section components consume. Catalog + gateway are derived from
 *  separate sources; sizeBytes is not returned by the API (chip hidden when absent). */
export interface LakeVM {
  id: string;
  name: string;
  slug: string;
  status: DatalakeDetail['status'];
  region: string;
  catalog: CatalogSchemaVM[];
  gateway?: GatewayInfoVM;
  sizeBytes?: number;
}

export interface AclRuleVM {
  id: string;
  datalakeId: string;
  agentId?: string;
  schema: string;
  table: string;
  verb: 'read' | 'write';
}

export interface WorkspaceTableVM {
  name: string;
  rowCount: number;
  sizeBytes: number;
  lastWriteAt: string;
}

export interface WorkspaceVM {
  id: string;
  agentId: string;
  agentName: string;
  datalakeId: string;
  /** Last live-session start — null when the workspace has never had one. */
  lastActiveAt: string | null;
  /** Workspace file size — not returned by the API (size column hidden when absent). */
  sizeBytes?: number;
  /** Materialized scratch tables — not returned by the API (empty state shown). */
  scratchTables: WorkspaceTableVM[];
}
