// The per-(workspace, agent) session actor — the durable owner of one agent's
// encrypted workspace. Keyed [workspaceId, agentId] so every session for that pair
// funnels to ONE actor + ONE FIFO sidecar: a single writer, so the S3 object never
// splits. This is a THIN Rivet wrapper; all orchestration (restore → spawn sidecar →
// init → checkpoint → upload) lives in WorkspaceRunner (workspace-runner.ts), which is
// plain Node and tested end to end in workspace-runner.test.mjs.
//
// SECRET CUSTODY: the workspace key + session JWT + S3 creds are re-vended by the
// control plane on every `configure` (control-plane-managed key custody) and held only
// in the in-memory runner — NEVER persisted in the actor's durable state, which holds
// identity only. After a hibernation the actor is cold; the next `configure`
// re-establishes everything from the re-vended secrets + the S3-restored file.

import { actor } from "rivetkit";
import { WorkspaceRunner, type WorkspaceConfig } from "./workspace-runner.ts";

interface WsState { workspaceId: string; agentId: string }
interface WsVars { runner: WorkspaceRunner | null }

type Ctx = { vars: WsVars; state: WsState; key: ReadonlyArray<unknown> };

function runnerFor(c: Ctx): WorkspaceRunner {
  if (!c.vars.runner) {
    c.vars.runner = new WorkspaceRunner(String(c.key[0]), String(c.key[1]));
    if (!c.state.workspaceId) { c.state.workspaceId = String(c.key[0]); c.state.agentId = String(c.key[1]); }
  }
  return c.vars.runner;
}

export const workspace = actor({
  options: { name: "Agent Workspace", icon: "database", sleepTimeout: 30000 },
  state: { workspaceId: "", agentId: "" } as WsState,
  createVars: (): WsVars => ({ runner: null }),

  // On hibernation: flush + upload the encrypted workspace, then drop the local copy.
  onSleep: async (c) => { if (c.vars.runner) await c.vars.runner.end(); },

  actions: {
    /** Session start (control plane → actor): vend secrets, restore, bring up the sidecar. */
    configure: async (c, cfg: WorkspaceConfig) => { await runnerFor(c as unknown as Ctx).configure(cfg); return { configured: true }; },
    /** Agent query (FIFO on the sidecar) → { columns, rows, rowCount }. */
    query: async (c, sql: string) => runnerFor(c as unknown as Ctx).query(sql),
    /** Agent statement with no result set (FIFO). */
    run: async (c, sql: string) => { await runnerFor(c as unknown as Ctx).run(sql); return { ok: true }; },
    /** Periodic/explicit checkpoint → upload, session stays live. */
    snapshot: async (c) => { await runnerFor(c as unknown as Ctx).snapshot(); return { ok: true }; },
    /** End the session: flush, upload, stop the sidecar. */
    end: async (c) => { if (c.vars.runner) await c.vars.runner.end(); return { ended: true }; },
  },
});
