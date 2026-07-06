/**
 * /api/cp/onboarding — backend for the self-serve "aha" connect wizard.
 *
 * Auto-provisions a SEEDED demo lake + agent + key + ACL on first visit, then reports
 * live activation (connected / first query) so the wizard can show the payoff.
 *
 * Provisioning is DASHBOARD-KICKED (POST /provision), never the Better Auth org-create
 * hook — a synchronous external call there is exactly what caused the 1101 hung-request
 * failure (see auth.ts). Resource creation is fast control-plane DB work; the only
 * gateway-dependent part (seeding sample data) runs in waitUntil and is retryable.
 *
 *   GET  /status     → { lake, agent, demoTable, demoQuery, connected, firstQuery, provisioning, completed }
 *   POST /provision  → idempotent: demo lake + agent + key + ACL, then seed (background)
 *   POST /agent-key  → mint + reveal a fresh key for the demo agent (reveal-at-connect)
 *   POST /complete   → mark the tour done/dismissed
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { query, queryOne } from '../lib/db';
import { resolveCaller, handle, ok, err, AuthError } from '../lib/cp-shared';
import { buildAuth } from '../lib/auth';
import { provisionOrgCatalog } from '../lib/catalog-provision';
import { ensureMemoryLake } from '../lib/memory-lake';
import { recompileAndPush } from '../lib/gateway-push';
import { makePostHog } from '../lib/posthog';
import type { Env } from '../lib/env';
import { app } from '../index';

// ── The demo: ONE source of truth for table / columns / grant / query / seed ─────
const DEMO = {
  lakeName: 'Demo Lake',
  lakeSlug: 'demo-lake',
  agentName: 'Demo Agent',
  // The lake's DEFAULT schema. birdshot forbids CREATE SCHEMA (forbidden-class) for the
  // restricted agent, so we seed into the schema that already exists at boot rather than
  // making a custom one. The bare (un-qualified) `main.events` write is what birdshot
  // authorizes AND it lands in the lake; an explicit `lake.main.events` write is denied.
  schema: 'main',
  table: 'events',
  // What the wizard tells the user to run — must match the seeded table + the agent grant.
  query: 'SELECT * FROM lake.main.events ORDER BY event_date LIMIT 10',
} as const;

const DEMO_QUALIFIED = `${DEMO.schema}.${DEMO.table}`; // main.events

// Seed = a tiny product-analytics sample. Inline VALUES → no egress needed. Bare target
// (not lake-qualified) so birdshot authorizes it; IF NOT EXISTS makes it idempotent so
// retries (and concurrent kicks) are safe. No CREATE SCHEMA — `main` exists at boot.
const SEED_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${DEMO_QUALIFIED} AS SELECT * FROM (VALUES
  (DATE '2026-01-05', 'signup',  'alice',  0),
  (DATE '2026-01-05', 'query',   'alice',  0),
  (DATE '2026-01-06', 'signup',  'bob',    0),
  (DATE '2026-01-06', 'upgrade', 'alice', 49),
  (DATE '2026-01-07', 'query',   'bob',    0),
  (DATE '2026-01-08', 'signup',  'carol',  0),
  (DATE '2026-01-09', 'upgrade', 'bob',   49),
  (DATE '2026-01-10', 'query',   'carol',  0),
  (DATE '2026-01-11', 'upgrade', 'carol', 99),
  (DATE '2026-01-12', 'query',   'alice',  0)
) AS t(event_date, event_type, user_id, amount_usd)`;

// Capabilities the demo agent gets DIRECTLY (subject_kind='agent' rows union into the
// compile without the owner-delegation machinery). create/etl/write let it seed its own
// demo schema; read powers the aha query. verb is the coarse read/write axis.
const AGENT_GRANTS: { capability: string; verb: 'read' | 'write' }[] = [
  { capability: 'read', verb: 'read' },
  { capability: 'create', verb: 'write' },
  { capability: 'write', verb: 'write' },
  { capability: 'etl', verb: 'write' },
];

interface OnboardingRow {
  org_id: string;
  demo_lake_id: string | null;
  demo_agent_id: string | null;
  seeded_at: string | null;
  completed_at: string | null;
}

const onboarding = new Hono<{ Bindings: Env }>();

// ── helpers ──────────────────────────────────────────────────────────────────────

async function loadRow(orgId: string): Promise<OnboardingRow | null> {
  return queryOne<OnboardingRow>(
    `SELECT org_id, demo_lake_id, demo_agent_id, seeded_at, completed_at
       FROM waddling.org_onboarding WHERE org_id = $1`,
    [orgId],
  );
}

type Ctx = Context<{ Bindings: Env }>;

/** Mint a Better Auth api key bound to the org (uses the caller's session headers). */
async function mintKey(c: Ctx, orgId: string) {
  return buildAuth(c.env).api.createApiKey({
    body: { name: DEMO.agentName, organizationId: orgId, metadata: { agent: DEMO.agentName, onboarding: true } },
    headers: c.req.raw.headers,
  });
}

/**
 * Seed the demo table by connecting AS THE AGENT (its own key) and running the CTAS via
 * the governed etl path — the same chokepoint the ETL fleet uses. Best-effort: the first
 * connect boots the (possibly cold) gateway, so this runs in waitUntil and is retryable
 * (CTAS is IF NOT EXISTS). Returns true once the demo table exists.
 */
async function seedDemo(
  env: Env,
  ctx: ExecutionContext | undefined,
  lakeId: string,
  agentKey: string,
): Promise<boolean> {
  // In-process dispatch onto the same app (a Worker can't reliably fetch its own public
  // domain; the public-URL self-fetch silently fails). Same loopback the /mcp route uses.
  const call = (path: string, body: unknown) =>
    app.fetch(
      new Request(`https://control.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${agentKey}` },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
  const conn = await call('/api/cp/sessions', { datalakeId: lakeId });
  if (!conn.ok) return false;
  const sess = (await conn.json()) as { sessionId?: string; session_id?: string };
  const sessionId = sess.sessionId ?? sess.session_id;
  if (!sessionId) return false;

  const r = await call(`/api/cp/sessions/${encodeURIComponent(sessionId)}/etl`, { sql: SEED_TABLE_SQL });
  return r.ok;
}

/** Background: seed with the given key, then mark seeded_at on success. */
function kickSeed(c: Ctx, orgId: string, lakeId: string, agentKey: string) {
  let exCtx: ExecutionContext | undefined;
  try { exCtx = c.executionCtx; } catch { exCtx = undefined; }
  const work = (async () => {
    try {
      const okSeed = await seedDemo(c.env, exCtx, lakeId, agentKey);
      if (okSeed) {
        await query(`UPDATE waddling.org_onboarding SET seeded_at = now() WHERE org_id = $1 AND seeded_at IS NULL`, [orgId]);
      }
    } catch (e) {
      console.log(`[onboarding] seed failed for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  if (exCtx) exCtx.waitUntil(work); else void work;
}

// ── GET /status ────────────────────────────────────────────────────────────────
onboarding.get('/status', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, false);
    if (!caller.orgId) {
      return ok(c, {
        lake: null, agent: null, demoTable: DEMO_QUALIFIED, demoQuery: DEMO.query,
        connected: false, firstQuery: false, provisioning: false, completed: false,
      });
    }
    const row = await loadRow(caller.orgId);

    const lake = row?.demo_lake_id
      ? await queryOne<{ id: string; name: string; slug: string; status: string }>(
          `SELECT id, name, slug, status FROM waddling.datalake WHERE id = $1`,
          [row.demo_lake_id],
        )
      : null;
    const agent = row?.demo_agent_id
      ? await queryOne<{ id: string; name: string }>(
          `SELECT id, name FROM waddling.agent WHERE id = $1`,
          [row.demo_agent_id],
        )
      : null;

    // Live activation signals (durable reads on existing tables).
    const connected = !!(await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM waddling.agent_session WHERE org_id = $1 LIMIT 1`,
      [caller.orgId],
    ).catch(() => null));
    const firstQuery = !!(await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM waddling.usage_event WHERE org_id = $1 AND kind = 'query' LIMIT 1`,
      [caller.orgId],
    ).catch(() => null));

    // "Ready" = the lake is activated (running) and the agent exists. The demo seed runs
    // in the background and reliably lands within ~15s — well before a human pastes the
    // MCP config and asks their agent to query — so the wizard doesn't block on seeded_at
    // (whose best-effort waitUntil marking can lag). The lake flips to running at provision.
    const provisioning = !row || !lake || lake.status !== 'running' || !agent;

    return ok(c, {
      lake: lake ? { id: lake.id, name: lake.name, slug: lake.slug, status: lake.status } : null,
      agent: agent ? { id: agent.id, name: agent.name } : null,
      demoTable: DEMO_QUALIFIED,
      demoQuery: DEMO.query,
      connected,
      firstQuery,
      provisioning,
      completed: !!row?.completed_at,
    });
  }),
);

// ── POST /provision ──────────────────────────────────────────────────────────────
// Idempotent. First call creates the demo lake + agent + key + ACL and kicks the seed;
// later calls (while unseeded) just re-mint a key and re-kick the seed.
onboarding.post('/provision', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (caller.kind !== 'user') {
      throw new AuthError('session_required', 403, 'Provisioning requires a dashboard session');
    }
    const orgId = caller.orgId;
    let row = await loadRow(orgId);

    // Every paid org gets its memory lake by default — kick creation (row +
    // per-org QB gateway) here so it's warm before the agent's first memory
    // call. Fire-and-forget: the gateway deploy takes ~30-60s and onboarding
    // must not block on it; prepareQbContext lazily heals anything unfinished.
    void ensureMemoryLake(c.env, orgId).catch((e: unknown) => {
      console.log(
        `[onboarding] memory-lake provision deferred for ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

    if (!row || !row.demo_lake_id || !row.demo_agent_id) {
      // ── First-time provision ──
      const slugRow = await queryOne<{ slug: string }>(`SELECT slug FROM "organization" WHERE id = $1`, [orgId]);
      const orgSlug = slugRow?.slug ?? orgId;
      try {
        await provisionOrgCatalog(c.env, orgId, orgSlug);
      } catch {
        // best-effort (idempotent; connect re-checks catalog readiness)
      }

      // Managed demo lake (mirrors datalakes POST; direct insert bypasses the quota gate
      // since this is a system default, and avoids a slug clash via the onboarding guard).
      const serverToken = `srv_${crypto.randomUUID().replace(/-/g, '')}`;
      const catalogSchema = `dl_${DEMO.lakeSlug.replace(/-/g, '_')}`;
      const lakeRow = await queryOne<{ id: string }>(
        `INSERT INTO waddling.datalake
           (org_id, name, slug, catalog_dsn, data_path, region, encrypted, server_token, status,
            storage_provider, storage_endpoint, storage_region, storage_url_style, storage_use_ssl,
            catalog_mode, catalog_schema, kind)
         VALUES ($1,$2,$3,'','managed-r2','auto',false,$4,'provisioning',
                 'config','','auto','path',false,'managed-postgres',$5,'lake')
         ON CONFLICT (org_id, slug) DO UPDATE SET slug = waddling.datalake.slug
         RETURNING id`,
        [orgId, DEMO.lakeName, DEMO.lakeSlug, serverToken, catalogSchema],
      );
      const lakeId = lakeRow!.id;

      // Activate the lake (provisioning → running). In prod the dev stand-in is 403
      // ("Stage D owns boot"), but Stage-D auto-boot of a NEW managed lake isn't wired —
      // and a managed lake is cheap (R2 + a scale-to-zero Neon catalog), so onboarding
      // owns the one-time activation. This only flips the lifecycle status that connect
      // gates on; the real gateway container still boots lazily on the first connect
      // (the snapshot push), and scales back to zero when idle.
      await query(`UPDATE waddling.datalake SET status = 'running', updated_at = now() WHERE id = $1`, [lakeId]);

      // Demo agent + its first key (used to seed; the user reveals a fresh one at connect).
      const key = await mintKey(c, orgId);
      const agentRow = await queryOne<{ id: string }>(
        `INSERT INTO waddling.agent (org_id, name, description, api_key_id, default_role, mode, status)
         VALUES ($1,$2,$3,$4,'reader','autonomous','active')
         RETURNING id`,
        [orgId, DEMO.agentName, 'Auto-provisioned for onboarding', key.id],
      );
      const agentId = agentRow!.id;

      // Direct agent grants on the demo schema (seed + read).
      for (const g of AGENT_GRANTS) {
        await query(
          `INSERT INTO waddling.acl_rule
             (org_id, datalake_id, agent_id, subject_kind, capability,
              schema_name, table_name, columns, verb, effect, created_by)
           VALUES ($1,$2,$3,'agent',$4,$5,'*',NULL,$6,'allow',$7)`,
          [orgId, lakeId, agentId, g.capability, DEMO.schema, g.verb, caller.callerId],
        );
      }
      try { await recompileAndPush(c, lakeId); } catch { /* gateway boots on seed connect */ }

      await query(
        `INSERT INTO waddling.org_onboarding (org_id, demo_lake_id, demo_agent_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (org_id) DO UPDATE SET demo_lake_id = $2, demo_agent_id = $3`,
        [orgId, lakeId, agentId],
      );

      makePostHog(c.env, (() => { try { return c.executionCtx; } catch { return undefined; } })()).capture({
        distinctId: caller.callerId,
        event: 'onboarding_provisioned',
        properties: { via: 'wizard' },
        groups: { organization: orgId },
      });

      kickSeed(c, orgId, lakeId, key.key);
      row = await loadRow(orgId);
    } else if (!row.seeded_at) {
      // ── Retry seed (resources exist, sample data hasn't landed) ──
      const key = await mintKey(c, orgId);
      await query(`UPDATE waddling.agent SET api_key_id = $2 WHERE id = $1`, [row.demo_agent_id, key.id]);
      kickSeed(c, orgId, row.demo_lake_id!, key.key);
    }

    return ok(c, { ok: true, provisioning: !row?.seeded_at });
  }),
);

// ── POST /agent-key ──────────────────────────────────────────────────────────────
// Reveal-at-connect: mint a fresh key, rebind the demo agent to it, return the plaintext
// ONCE. Any previous key is left orphaned (no longer bound → resolves to no agent).
onboarding.post('/agent-key', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (caller.kind !== 'user') {
      throw new AuthError('session_required', 403, 'Revealing a key requires a dashboard session');
    }
    const row = await loadRow(caller.orgId);
    if (!row?.demo_agent_id) {
      return err(c, 'not_provisioned', 409, 'Demo agent is still being set up — try again in a moment');
    }
    const key = await mintKey(c, caller.orgId);
    await query(`UPDATE waddling.agent SET api_key_id = $2 WHERE id = $1`, [row.demo_agent_id, key.id]);
    return ok(c, { key: key.key });
  }),
);

// ── POST /complete ───────────────────────────────────────────────────────────────
onboarding.post('/complete', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    await query(
      `INSERT INTO waddling.org_onboarding (org_id, completed_at)
       VALUES ($1, now())
       ON CONFLICT (org_id) DO UPDATE SET completed_at = now()`,
      [caller.orgId],
    );
    return ok(c, { ok: true });
  }),
);

export { onboarding };
