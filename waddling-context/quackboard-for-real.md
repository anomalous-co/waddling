# Quackboard for real — design + transport scope

Status: **scoping doc** (not yet built). Written 2026-06-30 after recon established that the
lab Quackboard UI models a feature that does not exist in the backend. This doc defines the
honest, buildable Quackboard and the work to make it real on the all-GCP stack.

See also: `apps/control-api/src/routes/quackboard.ts`, the gateway quackboard schema in
`apps/dataplane/gateway-cloudrun/gateway-src/duck.ts`, and the memory note
`quackboard-ui-vs-backend-reality`.

---

## 1. What the lab UI assumes vs. what exists

**Lab UI model** (`apps/waddling/src/lab/fixtures/quackboard.ts`): a chat app —
`ProjectGroup → Topic → QbEntry(message|observe|remember|handoff)`, plus per-agent memory
dropdowns and an "all memories" view. Endpoints it calls:
`GET /api/cp/quackboard/groups|activity|memory`.

**Real backend** (per-org governed DuckDB, one Sandbox/actor per org, durable to object
storage). Tables actually bootstrapped at gateway boot:

| Table | Columns (abridged) | Written by | Read by |
|---|---|---|---|
| `observations` | agent_role, content, refs JSON, **topic TEXT**, ts | `qb_observe` | `qb_recall` (BM25), `qb_query` |
| `agent_memory` | agent_role, key, content, ts | `qb_remember` (trusted) | `qb_mine` (self only, trusted) |
| `subscriptions` | agent_role, pattern, match_type, topic | `qb_subscribe` | fan-out on observe |
| `notifications` | to_role, sub_id, snippet, is_read, ts | observe fan-out | `qb_inbox` |
| `messages`,`boundaries`,`objectives`,`claims` | — | **nobody (dead)** | `qb_query` only |

**The gaps:**
- **No `project_groups`, no `topics` table, no channels.** `topic` is a flat nullable string
  on `observations`/`subscriptions`. The group→topic hierarchy is pure fixture invention.
- **No chat.** `messages` exists but has no writer; there is no agent↔agent or human↔agent
  chat primitive. The `kind: 'message'|'handoff'` entries are fiction.
- **No org-wide admin read.** Every existing read runs as ONE agent identity, birdshot-gated.
  `agent_memory` is birdshot-ungranted (private by construction) and only readable per-agent
  via the trusted `/qb/mine` (WHERE agent_role = caller).

---

## 2. The honest Quackboard (what we should build)

Drop the chat/topics/groups fiction. Surface what the substrate actually is — an **agent
coordination board**:

1. **Activity feed** — the shared `observations` corpus (every agent's findings), newest
   first, with the optional flat `topic` string shown as a lightweight tag/filter (not a
   hierarchy). This is real, governed, and already RW-granted to every active agent.
2. **Memories browser** — per-agent `agent_memory` (key + content + updatedAt), with an
   agent picker and an org-wide "all memories" view for admins.
3. *(optional later)* **Pub/sub view** — subscriptions + notifications, to show what agents
   are watching and what fired.

This maps cleanly onto the real tables and needs no schema invention. The `QbEntry.kind`
collapses to the real `observe` (+ `remember` surfaced in the memories tab, not the feed).

If a true human-facing *chat* is wanted, that is a separate, larger feature: new
`messages`-style tables with writers, agent-facing MCP tools to post, and a real
topic/channel model. Not in this scope.

---

## 3. Endpoints to build

Reshape the lab's three GETs onto the real model (control-api `routes/quackboard.ts`,
extend in place):

- `GET /api/cp/quackboard/activity` → `{ entries: QbEntry[] }`
  Run, as any active org agent, `SELECT id, agent_role, content, topic, ts FROM observations
  ORDER BY ts DESC LIMIT …` via the existing `gatedQuery`→`/qb/query` seam (grants already
  permit it). Join `agent_role`→`waddling.agent.name` in control-plane Postgres for display
  names. `kind` is always `'observe'`.
- `GET /api/cp/quackboard/memory` → `{ entries: QbMemoryEntry[] }`
  Needs the ONE new data-plane primitive (below): a trusted org-wide `agent_memory` read.
  Per-agent filter via `?agentId=`.
- `GET /api/cp/quackboard/groups` → **either drop**, or return a derived
  `{ topics: distinct(observations.topic) }` list so the UI's tag filter has values. No
  `project_groups`.

Admin gating: the org-wide memory view is owner/admin only (mirror `team.ts` `isAdmin`).

### The one genuinely-missing primitive

`agent_memory` is birdshot-ungranted, so the gated path can never read it. An "all memories"
view requires a new **trusted** gateway endpoint on the un-gated control connection:

- Gateway (`apps/dataplane/gateway-cloudrun/entrypoint.mjs`): add `/ctrl/qb-memory-all` →
  `SELECT agent_role, key, content, ts FROM agent_memory [WHERE agent_role = $role]` — model
  exactly on the existing `/ctrl/qb-mine` (which is the same query WITH the role filter).
- control-api: a `dpFetch('/qb/memory-all', …)` wrapper alongside the existing qb dpFetch
  calls.

This is the only new backend capability; everything else is reshaping existing reads.

---

## 4. The transport gap (the real blocker on all-GCP)

`routes/quackboard.ts` reaches the data plane via `dpFetch` → `env.DATAPLANE.fetch(...)`,
the **Cloudflare service binding** to the `QuackboardDO`. On the GCP/Node control-api
(`server.ts`) `env.DATAPLANE` is a **503 stub**, and the CF `QuackboardDO` is not part of an
all-GCP stack. So today the entire qb_* family (and therefore any Quackboard UI) is **not
wired end-to-end on GCP**.

To make Quackboard real on GCP, the quackboard data plane must be reached the same way the
lake gateways already are — over HTTP to a Cloud Run gateway, not a CF binding:

1. **Run the quackboard as a Cloud Run gateway** (the `gateway-cloudrun` image already has
   `QUACKBOARD_SCHEMA` + the `/ctrl/qb-*` trusted endpoints). One per org, addressed like the
   lake gateways (the org's `kind='quackboard'` `waddling.datalake` row already carries a
   `gateway_url` after migration 021).
2. **Route control-api's qb calls through the HTTP transport.** The `/qb/*` paths
   (`/qb/configure`, `/qb/query`, `/qb/recall`, `/qb/remember`, `/qb/mine`) are the CF
   worker's verbs; the Cloud Run gateway speaks `/ctrl/qb-*`. Reconcile: either add the
   `/qb/*` routes to the Cloud Run gateway, or switch `dpFetch` to call `gatewayClientFor(ep)`
   (the transport-agnostic client that already mints Cloud Run identity tokens and works on
   both CF and GCP — used by the lake `sessions.ts`). The latter is the consistent choice.
3. **Provision/boot path** — ensure the org quackboard gets a `gateway_url` and boots like a
   lake (the lazy-boot-at-create fix from the data-lake activation work applies).

This is the bulk of the effort: it is data-plane/transport work, not UI wiring.

---

## 5. Phased plan

- **P0 — transport**: route control-api qb_* through `gatewayClientFor` / Cloud Run gateway;
  prove the existing MCP `waddling_qb_*` tools work end-to-end on GCP (live-verifiable with a
  throwaway org + sk_ agent key). This unblocks everything and is independently valuable (the
  qb MCP tools are currently dark on GCP).
- **P1 — read endpoints**: `activity` + `memory` (with the new `/ctrl/qb-memory-all` trusted
  primitive) + the derived `topics` list.
- **P2 — UI**: rebuild the Quackboard page on the honest model (feed + memories browser),
  retiring the chat/topics/groups fixtures. Reuse the lab page's layout shell where it fits
  the real model.

P0 is the gate. Until the quackboard data plane is reachable from the GCP control-api, no
Quackboard UI can show real data.
