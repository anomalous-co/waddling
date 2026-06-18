// Prove: a managed, resumable, per-agent DuckDB whose private working set
// survives a reschedule — agent runs nothing locally.
//
//   actor spawns DuckDB sidecar → agent writes a private table →
//   hibernate (persist file to Rivet KV, kill sidecar, WIPE local file) →
//   query again → actor restores the DB from KV, respawns → data is still there.
//
// The local-file wipe is the honesty check: step [4] can only succeed if Rivet's
// actor KV actually carried the database across the eviction.
//
// Run order: rivet-engine → `npm run dev` → `npm run verify:managed`

import { createClient } from "rivetkit/client";
import type { registry } from "./registry.ts";

const RIVET = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";

function pass(m: string): never { console.log(`\n✅ PASS — ${m}`); process.exit(0); }
function fail(m: string): never { console.error(`\n❌ FAIL — ${m}`); process.exit(1); }

async function main(): Promise<void> {
  const c = createClient<typeof registry>(RIVET);
  const me = c.agentSidecar.getOrCreate(["agent-007"]);

  await me.start();
  console.log("[1] agent's managed DuckDB sidecar started (nothing runs on the agent)");

  await me.run("CREATE TABLE IF NOT EXISTS notes(id INTEGER, body VARCHAR)");
  await me.run("DELETE FROM notes");
  await me.run("INSERT INTO notes VALUES (1,'remember this'),(2,'and this')");
  const before = (await me.query("SELECT * FROM notes ORDER BY id")) as { rows: unknown[] };
  console.log("[2] agent wrote a PRIVATE table →", before.rows);

  const h = await me.hibernate();
  console.log("[3] hibernated: persisted to Rivet KV + WIPED local file →", h);

  const after = (await me.query("SELECT * FROM notes ORDER BY id")) as { rows: unknown[] };
  console.log("[4] queried after wake (DB had to come from KV) →", after.rows);

  if (JSON.stringify(after.rows) !== JSON.stringify(before.rows)) {
    fail(`working set did not survive — before=${JSON.stringify(before.rows)} after=${JSON.stringify(after.rows)}`);
  }
  pass("managed per-agent DuckDB survived eviction via Rivet actor KV (private working set intact)");
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
