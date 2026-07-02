# Loop 4 build prompt — Agents roster + Agent detail (`/lab/agents`, `/lab/agents/[id]`)

Build the **Agents** surface: the roster of an org's agents and the single home for managing
ONE agent. This is the counterpart to the Data surface — where Data is "what can be reached",
Agents is "who reaches it". In the ungated `(ux-lab)` design forge with mock data.

waddling context: an **agent** is an AI client (an LLM agent / automation) that connects its
DuckDB to a lake's gateway with an API key (`sk_agent_…`); birdshot enforces its per-table
ACLs. An agent has: identity (name, description, owner, access mode), **keys** (reveal-once;
must be rotatable + per-key revocable), **access** (its ACL grants across lakes), **sessions**
(live + recent connections), and roadmap **memory** (quackboard) + **activity** (audit). The
existing diagnosis (waddling-context/agents-ux-redesign.md) says today the agent concept is
shattered across pages with no key rotation and no suspend — this surface fixes that: ONE home,
sectioned.

Scope discipline: ONLY create/edit under `apps/waddling/src/app/(ux-lab)/**`,
`apps/waddling/src/components/waddling/**`, `apps/waddling/src/app/api/cp/**` (mock handlers),
`apps/waddling/src/lab/fixtures/**`. Do NOT touch `(dashboard)`, `(marketing)`, `(auth)`, or
shared `ui/*`.

## Read first (reuse, match idioms, don't reinvent)
- `apps/waddling/src/components/waddling/detail-layout.tsx` — the agent detail MUST use this
  (header + section sub-rail, URL-driven `?section=`). It already powers Lake detail; read how
  Lake detail (`apps/waddling/src/app/(ux-lab)/lab/data/[id]/page.tsx`) composes it, including
  the header `meta`, `actions`, and section `badge`s, so Agent detail matches that pattern exactly.
- ALL `apps/waddling/src/components/waddling/*` primitives — REUSE: PageHeader, SectionCard
  (`headingLevel`), StatusDot (`decorative`, semantic statuses incl. `suspended`), StatPill,
  EmptyState, CopyButton, CodeBlock, KeyReveal, Stepper. Match spacing rhythm (gap-6, rounded-xl,
  ring-1 ring-foreground/10).
- `apps/waddling/src/components/dashboard/fetch.ts` — `fetchCp` + `cpPost` + envelopes:
  `GET /api/cp/agents → { agents }`, `GET /api/cp/agents/:id → { agent }`,
  `GET /api/cp/acl → { rules }`, `GET /api/cp/sessions → { sessions }`,
  `POST /api/cp/agents/:id/revoke → { ok }`. For per-key + session-kill + suspend you will ADD
  mock handlers (below).
- `apps/waddling/src/lib/types.ts` — reuse `AgentSummary`, `AgentRow`, `AclRuleRow`, session types.
- `apps/waddling/src/lab/fixtures/*` — reuse the existing agents/acl/sessions/datalake fixtures so
  names/ids are CONSISTENT across surfaces (an agent's grants here must reference the same lakes
  + tables shown on the Data surface).
- shadcn `alert-dialog`, `dropdown-menu`, `table`, `badge`, `tabs`, `input` in `components/ui/*`.

## Deliverable

### 1. Agents roster — `src/app/(ux-lab)/lab/agents/page.tsx` (replace placeholder)
- `PageHeader` "Agents" + a primary "Connect an agent" action (→ `/lab/connect`).
- A searchable, sortable roster (shadcn `table` or a tidy list) from `GET /api/cp/agents`. Columns:
  agent name + description, **StatusDot** (active/idle/suspended — reuse the derive-from-lastSeen
  logic the Home page uses; consider extracting it to a shared helper to avoid a third copy),
  mode, last-seen (relative), and **active-session count**. A search box filters by name; a simple
  sort (name / last-seen) is enough. Each row links to `/lab/agents/[id]`.
- Loading skeletons; first-class EmptyState ("No agents yet" + Connect CTA) when empty.
- A row "⋯" menu (shadcn dropdown) with **Suspend/Resume** and **Delete** (Delete opens an
  AlertDialog confirm) — the roster is a valid place to triage without opening the agent.

### 2. Agent detail — `src/app/(ux-lab)/lab/agents/[id]/page.tsx` (NEW) via `DetailLayout`
Header: agent name + StatusDot + meta (owner, mode, last-seen) + actions: **Suspend/Resume**
(secondary) and a "⋯" menu with **Rotate handled in Keys** / **Delete** (AlertDialog confirm).
Sections (sub-rail, in order):
- **Overview** (default) — identity card (name, description, owner, mode, created), and a compact
  "Reachable data" list: which lakes/tables this agent can read/write (derived from its ACL rules),
  linking each lake to `/lab/data/[lakeId]`. Empty state nudging to Access if unscoped.
- **Access** — the agent's ACL grants, **grouped by lake** then table, with read/write verb badges.
  This is the manage view (the Lake-detail Access was read-only org-wide; here it's per-agent).
  Provide an "Add grant" affordance (can open a lightweight dialog OR link to a scope flow — a
  realistic stub is fine) and per-grant **Revoke** (AlertDialog or inline confirm). Empty state.
- **Keys** — the #1 gap fix: list the agent's keys (id, label, created, last-used, masked prefix
  `sk_agent_…`), each with **Revoke** (confirm). An **"Issue new key"** button that returns a
  reveal-once key shown via `KeyReveal` (reuse it) in a dialog/inline panel. At least one key in
  fixtures; revoking the last key should warn.
- **Sessions** — THIS agent's sessions only (filter `GET /api/cp/sessions`), showing lake **names**
  (not UUIDs), last query (truncated), started/duration, and a **Kill** action **with an
  AlertDialog confirm** ("drops a live connection"). Empty state. Link to a future org-wide view.
- **Memory** *(roadmap)* — first-class EmptyState ("Agent memory — coming soon", one line on what
  quackboard agent_memory will show). Badge optional.
- **Activity** *(roadmap)* — first-class EmptyState (audit slice + usage). 
Each section owns its own fetch + loading + empty state (the `AgentSection` composability idea from
the redesign doc). Badges reflect real counts (keys, sessions, grants) where cheap.

### 3. Mock handlers / fixtures to ADD (dev-gated; guard with the NEXT_PUBLIC_CONTROL_API_URL 404 check)
- `GET /api/cp/agents/:id` → `{ agent }` (full AgentRow; reuse the makeFixtureAgents now-relative
  lastSeen logic so status is realistic).
- Agent **keys**: a fixture list + handlers — `GET /api/cp/agents/:id/keys → { keys }`,
  `POST /api/cp/agents/:id/keys → { key }` (reveal-once `sk_agent_…`),
  `POST /api/cp/agents/:id/keys/:keyId/revoke → { ok }`. Define a local `AgentKey` type
  (`{ id, label, maskedPrefix, createdAt, lastUsedAt? }`) if not in types.ts.
- Session **kill**: `POST /api/cp/sessions/:id/kill → { ok }`.
- Agent **suspend/resume**: `POST /api/cp/agents/:id/suspend` and `/resume → { agent }` (flip status).
- Ensure `GET /api/cp/acl` rules + `GET /api/cp/sessions` reference the SAME agent ids/lake/table
  names as existing fixtures (consistency across Data ↔ Agents). Add per-agent sessions if missing.
- These are mock mutations: it's fine to mutate in-memory or just echo success (the UI should
  optimistically reflect the change + toast). Keep it simple but coherent.

## Quality bar (carry forward all prior lessons — these were graded down before)
- ONE h1 per page (PageHeader / DetailLayout title); sections h2/h3.
- **Every destructive action (Delete, Revoke key, Kill session, Suspend) uses a shadcn AlertDialog
  confirm** — no un-guarded irreversible clicks.
- Keyboard: all interactive controls operable + visibly focusable; menus/dialogs are shadcn (already
  accessible); any custom expand/toggle uses a real `<button>` (see the Catalog fix pattern).
- Accessible names on every icon-only control; copy via `CopyButton` (aria-live); real `<table>`
  semantics for tabular data; status via `StatusDot` (semantic tokens, no hardcoded colour).
- Forward flow & few screens: agent detail is ONE screen (sub-rail); no dead ends; Overview→Access,
  Access↔Keys, and "Connect an agent" are all reachable; reveal-once key handled safely.
- Dark-first, correct in light mode, theme tokens only. Cohesive with shell + Home + Connect + Data.
- TypeScript strict, no `any` in props; reuse `types.ts`. Run `pnpm run typecheck` (from
  `apps/waddling`) and fix NEW errors in your files. Do not start a dev server.

## Output
Report: files created/changed, the `/lab/agents` + `/lab/agents/[id]` behavior per section, the new
key/kill/suspend handlers + fixtures, any shared helper you extracted (e.g. agent-status derive),
new types, and typecheck status.
