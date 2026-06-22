/**
 * Governed star-schema load — the fleet acts as a normal agent.
 *
 * Authenticate with the source's sk_agent_ key, open ONE governed session
 * against the target lake, then issue the star schema's statements (a schema
 * prelude + each table in targetModel.order) SEQUENTIALLY on that SAME session.
 *
 * One session is load-bearing: a session is keyed per agent and connecting
 * supersedes a prior live session, so reconnecting mid-build would kill the
 * build in progress. Never reconnect inside the loop.
 *
 * Each statement runs on the gateway's trusted connection (read_parquet egress
 * + the lake write) but ONLY after birdshot authorizes that exact statement
 * against the agent's grants. Denials and cold-session errors are surfaced as
 * typed errors so the workflow logs them structurally rather than as opaque 500s.
 */

import type { Env } from '../env';
import type { PipelineSpec } from '../types';
import { assertGlob, assertIdent } from './validate';

/** A birdshot authorization denial (HTTP 403 from /etl). */
export class AuthorizationDeniedError extends Error {
  constructor(
    public reason: string,
    public table?: string,
  ) {
    super(`authorization_denied${table ? ` on ${table}` : ''}: ${reason}`);
    this.name = 'AuthorizationDeniedError';
  }
}

/** The session was cold (needs_connect / needs_configure) — a 409 from /etl. */
export class SessionNotReadyError extends Error {
  constructor(
    public phase: string,
    public reason: string,
  ) {
    super(`${phase}: ${reason}`);
    this.name = 'SessionNotReadyError';
  }
}

interface EtlResponse {
  ok?: boolean;
  phase?: string;
  error?: string;
  reason?: string;
  authorizeDecision?: unknown;
}

export interface StarBuildResult {
  sessionId: string;
  statements: number;
  rows: number;
}

export async function runStarBuild(env: Env, spec: PipelineSpec): Promise<StarBuildResult> {
  const base = (env.CONTROL_API_BASE || '').replace(/\/+$/, '');
  const key = String(env[spec.agentKeySecret] ?? '').trim();
  // The spec carries the target datalake; an unfilled `<…>` placeholder falls
  // back to env.DATALAKE_ID so deploy-time config can supply it once.
  const specLake = spec.datalakeId?.trim();
  const datalakeId =
    specLake && !specLake.startsWith('<') ? specLake : (env.DATALAKE_ID || '').trim();
  if (!base) throw new Error('CONTROL_API_BASE is not set');
  if (!key) throw new Error(`agent key secret ${spec.agentKeySecret} is not set`);
  if (!datalakeId) throw new Error('datalakeId is not set (spec.datalakeId / env.DATALAKE_ID)');

  const model = spec.targetModel;
  const schema = assertIdent('schema', model.schema);
  const stagingGlob = assertGlob(spec.stagingGlob);

  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  // 1. Open ONE governed session. This supersedes any prior live session for
  //    this agent, so periodic reconnects don't accumulate.
  const cRes = await fetch(`${base}/api/cp/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ datalakeId }),
  });
  if (!cRes.ok) {
    throw new Error(`connect ${cRes.status}: ${(await cRes.text()).slice(0, 300)}`);
  }
  const { sessionId } = (await cRes.json()) as { sessionId: string };
  const post = (sql: string) => runEtl(base, sessionId, headers, sql);

  // 2. Schema prelude: a fresh lake has no `marketing` schema, and
  //    CREATE OR REPLACE TABLE marketing.<t> does NOT create it. Try to create it
  //    on the same session before the CTASes. This statement is tolerant: if the
  //    agent's grants don't authorize a bare CREATE SCHEMA (schema creation may
  //    instead be handled by grant provisioning — see README), a denial here is
  //    NOT fatal; the table CTASes below land in the pre-provisioned schema. A
  //    denial on an actual table, by contrast, hard-fails.
  const prelude = await post(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  if (!prelude.ok && !prelude.denied) {
    throw prelude.error ?? new Error('schema prelude failed');
  }

  // 3. The star schema, in declared order (dims before fact). Each table's
  //    idents are validated; the SQL is a single idempotent CREATE OR REPLACE.
  let rows = 0;
  let statements = prelude.ok ? 1 : 0;
  for (const name of model.order) {
    const table = model.tables[name];
    if (!table) throw new Error(`targetModel.order references unknown table: ${name}`);
    assertIdent('table', table.name);
    const r = await post(table.sql({ stagingGlob }).trim());
    if (!r.ok) throw r.error ?? new Error(`etl failed on ${name}`);
    statements += 1;
    if (typeof r.rows === 'number') rows += r.rows;
  }

  return { sessionId, statements, rows };
}

/** One /etl POST. `denied` distinguishes a birdshot authz denial (recoverable
 *  for the tolerant schema prelude) from a hard failure. */
async function runEtl(
  base: string,
  sessionId: string,
  headers: Record<string, string>,
  sql: string,
): Promise<{ ok: boolean; denied: boolean; rows?: number; error?: Error }> {
  const eRes = await fetch(`${base}/api/cp/sessions/${encodeURIComponent(sessionId)}/etl`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql }),
  });
  const j = (await eRes.json().catch(() => ({}))) as EtlResponse & { rows?: number };

  if (eRes.status === 403 && j.error === 'authorization_denied') {
    return { ok: false, denied: true, error: new AuthorizationDeniedError(j.reason ?? 'denied') };
  }
  if (eRes.status === 409 && (j.error === 'needs_connect' || j.error === 'needs_configure')) {
    return { ok: false, denied: false, error: new SessionNotReadyError(j.error, j.reason ?? 'cold session') };
  }
  if (!eRes.ok || j.ok !== true) {
    return {
      ok: false,
      denied: false,
      error: new Error(`etl ${eRes.status}: ${j.error ?? j.reason ?? JSON.stringify(j).slice(0, 300)}`),
    };
  }
  return { ok: true, denied: false, rows: j.rows };
}
