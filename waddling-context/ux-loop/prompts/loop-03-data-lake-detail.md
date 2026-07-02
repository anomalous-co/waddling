# Loop 3 build prompt — Data surface + Lake detail (`/lab/data`, `/lab/data/[id]`)

Build the **Data** surface for waddling: where users see their data lakes and drill into one
lake to browse its catalog, see who can reach it, find the gateway endpoint agents dial into,
and view attached workspaces. This is in the ungated `(ux-lab)` design forge with mock data.

waddling context: a **data lake** is a governed DuckLake catalog (schemas → tables). Agents
connect their DuckDB to the lake through a **gateway endpoint** (a `quack:` URL) where the
birdshot extension enforces per-agent table-level ACLs. So a lake has: a **catalog**, a
**gateway/endpoint** (the dial-in point + status), **access** (which agents are granted which
tables), and **workspaces** (per-agent durable scratch DBs). The Data surface folds the old
separate "endpoints/gateways" nav INTO the lake — but the gateway/connection must have a
clear, obvious home (it is how agents actually connect; do not bury it).

Scope discipline: ONLY create/edit under `apps/waddling/src/app/(ux-lab)/**`,
`apps/waddling/src/components/waddling/**`, `apps/waddling/src/app/api/cp/**` (mock handlers),
`apps/waddling/src/lab/fixtures/**`. Do NOT touch `(dashboard)`, `(marketing)`, `(auth)`, or
shared `ui/*`.

## Read first (idioms, types, contracts)
- `apps/waddling/src/components/waddling/*` — REUSE every primitive: PageHeader, SectionCard
  (`headingLevel`), StatusDot (`decorative`, semantic colours), StatPill, EmptyState,
  GoldenPathCard, CodeBlock, CopyButton, Stepper, KeyReveal. Read them so this surface is the
  SAME design language. Do not re-implement what exists.
- `apps/waddling/src/components/dashboard/fetch.ts` — `fetchCp` + envelopes:
  `GET /api/cp/datalakes → { datalakes: DatalakeSummary[] }`,
  `GET /api/cp/datalakes/:id → { datalake: DatalakeDetail }` (mock already returns a catalog —
  read `apps/waddling/src/lab/fixtures/datalake-catalog.ts`),
  `GET /api/cp/workspaces → { workspaces: WorkspaceSummary[] }`,
  `GET /api/cp/acl → { rules: AclRuleRow[] }`.
- `apps/waddling/src/lib/types.ts` — reuse `DatalakeSummary`, `DatalakeDetail`,
  `WorkspaceSummary`, `AclRuleRow`. Extend fixture shapes locally if a field is missing
  (e.g. gateway endpoint URL/region/status, per-lake agent-access summary) and document it.
- `apps/waddling/src/components/dashboard/agent/connect-dialog.tsx` — the `ATTACH 'quack:<endpoint>?token=…'`
  + birdshot INSTALL/LOAD snippet form (mirror it for the lake's Connect section; the endpoint
  host comes from the lake's gateway, the token is the agent key placeholder).

## Deliverable

### 1. NEW reusable primitive — `DetailLayout` (`src/components/waddling/detail-layout.tsx`)
A header + **left section sub-rail** scaffold for any single-entity detail page (used by Lake
detail now, Agent detail in the next loop — make it generic, not lake-specific):
- Props: `title`, optional `status` (StatusDot), optional `meta` (small chips/text under the
  title), `actions` (right-aligned header buttons), and `sections: { id, label, badge?, content }[]`.
- Renders a header band (title + status + meta + actions) and a vertical sub-rail of section
  labels (with optional count badges); selecting one shows its content. Drive the active
  section from the URL (`?section=` or a hash) so it is linkable and back-button friendly.
- A11y: the sub-rail is a real tablist OR a nav with `aria-current`; one h1 (the title) per
  page; section panels are labelled; keyboard operable; visible focus.

### 2. Data index — `src/app/(ux-lab)/lab/data/page.tsx`
- `PageHeader` "Data" + a "New data lake" action (link to `/lab/data/new` — a minimal
  placeholder page is fine this loop, OR reuse an EmptyState "coming soon"; don't 404).
- A list/grid of lakes from `GET /api/cp/datalakes`: each shows name, StatusDot, table count,
  size, and # agents with access; the whole card links to `/lab/data/[id]`. Loading skeletons;
  first-class EmptyState ("No data lakes yet" + create CTA) when empty.
- Optionally a compact toggle between grid and table view (only if cheap; not required).

### 3. Lake detail — `src/app/(ux-lab)/lab/data/[id]/page.tsx`
Use `DetailLayout`. Header: lake name + StatusDot + meta (region, table count, size) +
actions ("Connect an agent" → `/lab/connect`). Sections (sub-rail), in this order:
- **Connect** (default) — the dial-in home: the gateway endpoint URL (CopyButton), region,
  endpoint status, and the `ATTACH 'quack:<endpoint>?token=<agent-key>'` + birdshot
  INSTALL/LOAD snippet in a `CodeBlock`. One line explaining agents connect here. This makes
  the gateway a first-class, obvious destination (do not bury it).
- **Catalog** — schema → table browser from the lake detail catalog. List schemas; under each,
  tables with row counts; selecting a table reveals its columns (name + type) in a panel or
  expandable row. A search box filters tables by name. Use real `<table>` semantics where tabular.
- **Access** — which agents can reach this lake and at what scope: a compact list/matrix of
  agent → granted tables (derive from `GET /api/cp/acl` filtered to this lake, joined with
  agents). Read-only summary with a "Manage access" link/button (can route to `/lab/agents`
  for now). Empty state when no agent is scoped yet (push toward Connect).
- **Workspaces** — per-agent durable workspaces attached to this lake from
  `GET /api/cp/workspaces` (filter to this lake): agent name, last active, size. Light list +
  empty state. (Workspaces = an agent's private governed scratch DB; one line explaining it.)

### 4. Mock handlers / fixtures to add (dev-gated; guard with the NEXT_PUBLIC_CONTROL_API_URL 404 check)
- Extend `GET /api/cp/datalakes/:id` (or the catalog fixture) so a lake detail carries:
  gateway `{ endpointUrl, region, status }`, `tableCount`, `sizeBytes`, and enough catalog
  (schemas → tables → columns with types + row counts) for the Catalog section.
- `GET /api/cp/workspaces → { workspaces: WorkspaceSummary[] }` with ~3 fixtures referencing
  lake ids + agent names + lastActiveAt (now-relative) + size.
- Ensure `GET /api/cp/acl → { rules }` returns a few rules referencing real lake/table/agent
  ids so the Access section is populated (add an acl fixture list if not present).
- Keep `GET /api/cp/datalakes` returning the existing 2 lakes (Event Lake running, Product
  Catalog provisioning) — make sure table counts / sizes are consistent with the detail.

## Quality bar (carry forward Loop 1 + Loop 2 lessons)
- Dark-first; correct in light mode; theme tokens only (no hardcoded colours; semantic status
  via StatusDot).
- A11y graded: ONE h1 per page; sections use h2/h3; sub-rail exposes the active section
  (`aria-current`/tablist semantics); every icon-only control has an accessible name; copy
  buttons announce via aria-live (reuse `CopyButton`); inputs have labels; visible focus;
  keyboard operable; real table semantics for tabular data.
- Forward flow & few screens: lake detail is ONE screen (sub-rail, not many routes); every
  section has a clear next action; no dead ends; "Connect an agent" is reachable from the lake.
- Cohesive with the existing shell + Home + Connect flow — reuse primitives, match spacing
  rhythm (gap-6 sections, rounded-xl cards, ring-1 ring-foreground/10).
- TypeScript strict, no `any` in props; reuse `types.ts`. Run `pnpm run typecheck` (from
  `apps/waddling`) and fix new errors in your files. Do not start a dev server.

## Output
Report: files created/changed, the `/lab/data` and `/lab/data/[id]` behavior, the `DetailLayout`
API (so it can host Agent detail next), new fixtures/types, and typecheck status.
