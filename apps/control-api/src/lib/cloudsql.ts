/**
 * Per-org Postgres provisioning on the shared GCP Cloud SQL instance.
 *
 * Each waddling org gets its OWN database + login role inside ONE shared Cloud SQL Postgres
 * instance. That database is the DuckLake metadata catalog the gateway ATTACHes via
 * `ducklake:postgres:<dsn>` on :5432. The gateway container speaks the raw PG wire with mTLS
 * client certs; control-api reaches the SAME instance only through Hyperdrive (which carries
 * the mTLS client cert server-side), so control-api itself holds no cert material.
 *
 * Provisioning is plain SQL over the request's Hyperdrive pool (db.ts `query`). No Cloud SQL
 * Admin API / OAuth: `CREATE DATABASE` works through Hyperdrive as a lone statement. It
 * CANNOT run inside a transaction block, so every statement here is an individual `query()`,
 * never `withTransaction`.
 *
 * Isolation: each org database REVOKEs CONNECT from PUBLIC and GRANTs it only to that org's
 * role, so a role cannot reach another org's database (denied at the server). Ownership is
 * NOT transferred — PG16 requires the admin to be able to SET ROLE to the new owner; GRANT
 * CREATE is enough for the org role to create its DuckLake metadata schema, which is all it
 * needs. The minted DSN never leaves the server (sealed before persisting).
 */
import { randomBytes } from 'node:crypto';
import { query, queryOne } from './db';
import type { Env } from './env';

export interface CloudSqlProvisionResult {
  /** The per-org database name — the durable handle stored in org_catalog.database_name. */
  database: string;
  /** libpq key=value DSN to the org database, WITH password but WITHOUT cert paths. The
   *  gateway injects sslcert/sslkey/sslrootcert at ATTACH time. Seal before persisting. */
  dsn: string;
}

/** True when the shared Cloud SQL instance is configured (PG_HOST set). Mirrors the old
 *  Neon null-check so callers can degrade with a 503 instead of throwing. */
export function cloudSqlConfigured(env: Env): boolean {
  return !!env.PG_HOST;
}

/** Derive a safe Postgres identifier (db/role) from an orgId: lowercase, ≤63 chars, and
 *  guaranteed to start with a letter (the constant prefix ensures that). DDL identifiers
 *  cannot be parameterized, so this is validated and injected as a literal — nothing past
 *  the sanitized orgId is attacker-controlled. */
function ident(prefix: string, orgId: string): string {
  const id = (prefix + orgId).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error(`derived identifier is not a safe pg identifier: ${id}`);
  }
  return id;
}
export const orgDbName = (orgId: string): string => ident('waddling_org_', orgId);
export const orgRoleName = (orgId: string): string => ident('orguser_', orgId);

/** Alphanumeric password — embeds in a libpq key=value DSN with no quoting/escaping. */
function genPassword(): string {
  let s = '';
  while (s.length < 40) s += randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  return s.slice(0, 40);
}

/**
 * Idempotently create the org's database + login role on the shared instance and return the
 * database name + a fresh DSN. The role password is (re)set on every call, so a re-provision
 * always yields a connectable DSN that matches the role. Statements run as individual
 * queries because `CREATE DATABASE` cannot be transactional.
 */
export async function provisionOrgDatabase(env: Env, orgId: string): Promise<CloudSqlProvisionResult> {
  const db = orgDbName(orgId);
  const role = orgRoleName(orgId);
  const password = genPassword();

  // Database — CREATE DATABASE has no IF NOT EXISTS, so guard on the catalog.
  const dbExists = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM pg_database WHERE datname = $1`,
    [db],
  );
  if (!dbExists) await query(`CREATE DATABASE "${db}"`);

  // Login role — rotate the password whether or not it already exists.
  const roleExists = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  if (roleExists) await query(`ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}'`);
  else await query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);

  // Isolation + grants (idempotent). PUBLIC loses CONNECT so no other org's role can reach
  // this database; the org role gets CONNECT/TEMP and CREATE (to make its DuckLake schema).
  await query(`REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC`);
  await query(`GRANT CONNECT, TEMP, CREATE ON DATABASE "${db}" TO "${role}"`);

  const port = env.PG_PORT || '5432';
  const dsn = `host=${env.PG_HOST} port=${port} dbname=${db} user=${role} password=${password} sslmode=verify-ca`;
  return { database: db, dsn };
}
