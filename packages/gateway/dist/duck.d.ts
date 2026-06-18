import { type DuckDBConnection } from "@duckdb/node-api";
import type { GatewayConfig } from "./config";
import type { BirdshotSnapshot } from "@waddling/control-schema";
/**
 * Normalize a DuckDB row tree to JSON-safe values (BigInt → Number, value
 * wrappers → their readable toString()). Mirrors packages/db/src/analytics.ts.
 */
export declare function normalize(value: unknown): unknown;
export interface DuckRuntime {
    connection: DuckDBConnection;
    config: GatewayConfig;
    /** Run a query and return JSON-safe columns + row tuples. */
    query(sql: string, cap?: number): Promise<{
        columns: string[];
        rows: unknown[][];
        rowCount: number;
        truncated: boolean;
    }>;
    /** Run a statement with no result. */
    run(sql: string): Promise<void>;
}
/** Boot DuckDB, load birdshot, create the S3 secret, ATTACH the lake, serve quack. */
export declare function bootDuckRuntime(config: GatewayConfig): Promise<DuckRuntime>;
export interface DescribedColumn {
    name: string;
    type: string;
    nullable?: boolean;
}
export interface DescribedTable {
    schema: string;
    table: string;
    columns: DescribedColumn[];
}
/**
 * Introspect the attached lake's columns + types via `duckdb_columns()` (the same
 * function packages/db/src/schema.ts uses for the web editor's autocomplete).
 * Runs on the gateway's own (ungated) connection — the CONTROL PLANE filters the
 * result down to the requesting agent's grants before any of it reaches a client
 * (the describe route intersects against `granted.tables`, which is the non-leak
 * boundary). We therefore deliberately do NOT filter by catalog here: that filter
 * can only ever *exclude* the real lake tables (a DuckLake attach may not report
 * its catalog as the alias) and adds no safety the grant intersection doesn't
 * already provide. Only internal schemas are dropped. Optionally restricted to a
 * set of "schema.table" refs to avoid shipping the whole catalog.
 */
export declare function describeTables(rt: DuckRuntime, only?: {
    schema: string;
    table: string;
}[]): Promise<DescribedTable[]>;
/**
 * Apply a full birdshot policy snapshot atomically (reset → set → commit).
 * Mirrors the compiler output in ARCHITECTURE.md §3e. Auth config (issuer,
 * audience, JWKS) is pulled from the gateway config / JWKS endpoint.
 */
export declare function applySnapshot(rt: DuckRuntime, snapshot: BirdshotSnapshot, auth?: {
    issuer: string;
    audience: string;
    jwks?: {
        kid: string;
        n: string;
        e: string;
    }[];
}): Promise<void>;
/** Instant revocation → in-memory denylist; next query for the subject denied. */
export declare function birdshotRevoke(rt: DuckRuntime, kind: "user" | "jti" | "session", id: string, reason: string, expiresUs?: number): Promise<void>;
/** birdshot_status() → parsed object (auth mode, policy size, session/audit). */
export declare function birdshotStatus(rt: DuckRuntime): Promise<unknown>;
/** Current DuckLake snapshot info for status reporting. */
export declare function ducklakeSnapshot(rt: DuckRuntime): Promise<unknown>;
