# Loop 1 build prompt — App shell + golden-path Home/Overview

You are building the new UI/UX for **waddling** (Next.js App Router, shadcn/ui, Tailwind,
dark-first theme). waddling governs AI-agent access to analytics data lakes: users provision
**agents**, connect agent DuckDB instances to org **data lakes** via a **gateway/endpoint**,
scope **table-level access (ACLs)**, watch live **sessions**, and use a shared agent memory
board (**quackboard**). Team features let principals delegate scoped access to agents.

This is an **isolated design-forge route** — do NOT touch the real `(dashboard)` surface or
its components. Build under the ungated `(ux-lab)` group with mock data, so it renders with
no auth and no backend.

## What already exists (use it, don't recreate)

- `apps/waddling/src/app/(ux-lab)/layout.tsx` — wraps children in `TooltipProvider` + `Toaster`.
  Root layout already provides the theme (fumadocs `RootProvider`, dark default).
- `apps/waddling/src/components/ui/*` — full shadcn kit: button, card, sidebar, dropdown-menu,
  command, dialog, sheet, tabs, table, badge, avatar, tooltip, separator, scroll-area, skeleton,
  empty, input, etc. USE THESE. The existing dashboard sidebar pattern is in
  `src/components/dashboard/shell.tsx` (read it for the shadcn `Sidebar*` usage idiom, org
  switcher, theme toggle — but build a NEW, cleaner shell; do not import it).
- `src/lib/utils.ts` exports `cn`. `src/components/data-lake-icon.tsx` and `brand-mark.tsx` exist.
- `src/components/dashboard/fetch.ts` exports `fetchCp<T>(path, init)` returning
  `{ ok: true, data } | { ok: false, error, status }`. It calls `cpUrl(path)` which resolves
  **same-origin** when `NEXT_PUBLIC_CONTROL_API_URL` is unset (it is, in the lab). USE `fetchCp`.
- `src/lib/types.ts` — read it for `AgentSummary`, `DatalakeSummary`, `UsageRollup`,
  `UsageSeries`, session/audit types. Reuse these types in fixtures (do not invent parallel ones).

## Mock backend (same-origin route handlers — the key technique)

Because `fetchCp` resolves to same-origin in the lab, add **dev-gated Next route handlers**
under `src/app/api/cp/*` that return fixtures in the envelopes documented at the top of
`fetch.ts`. Guard every handler so it ONLY serves when the real control-api is unset:
`if (process.env.NEXT_PUBLIC_CONTROL_API_URL) return new Response(null,{status:404})`.
Put fixtures in `src/lab/fixtures/*.ts` (typed with the real `types.ts` types). For Loop 1
you only need the handlers Home reads:
- `GET /api/cp/agents` → `{ agents: AgentSummary[] }` (include a realistic mix: 1 active, 1 idle, 1 suspended; one delegated)
- `GET /api/cp/datalakes` → `{ datalakes: DatalakeSummary[] }` (2 lakes, one active one provisioning)
- `GET /api/cp/sessions` → `{ sessions: SessionRow[] }` (2 live, recent queries, lake **names** not UUIDs)
- `GET /api/cp/usage` → `{ rollup: UsageRollup, series: UsageSeries[] }` (a week of session-hours + credit balance)

If a real type field is unclear, keep the fixture minimal-but-plausible; do not block.

## Deliverable

### 1. New app shell — `src/components/waddling/app-shell.tsx` (client)
A clean, production-grade shell hosting the new information architecture. Left sidebar nav
(use shadcn `Sidebar*`) with these destinations and lucide icons:
`Home` (/lab), `Agents` (/lab/agents), `Data` (/lab/data), `Quackboard` (/lab/quackboard),
`Team` (/lab/team), `Settings` (/lab/settings). Collapsible to icon-rail.
- Header row inside the inset: a breadcrumb/title slot + a **global ⌘K command trigger** (use
  shadcn `command` in a `CommandDialog`; wire `cmd/ctrl-k`). Command palette lists nav
  destinations + a prominent "Connect an agent" action (can route to /lab for now).
- Footer of sidebar: org switcher (static mock org) + a theme toggle (light/dark/system via
  fumadocs `useTheme`, mirror the idiom in `shell.tsx`) + a mock user avatar menu.
- A11y: every icon-only control has an accessible name (`aria-label` or `sr-only` text);
  nav uses real `<a>`/`Link`; command dialog is keyboard-navigable; visible focus rings.

### 2. Composite primitives — `src/components/waddling/*` (the reusable library)
Extract these as standalone, documented components (each with a short JSDoc + prop types).
EVERY later flow will be assembled from these — make them clean and generic:
- `PageHeader` — title, optional description, optional actions slot, optional breadcrumb.
- `StatPill` — label + value + optional trend/delta + optional icon (for usage/credits/counts).
- `StatusDot` — semantic status (active/idle/suspended/provisioning/error) → colored dot +
  label; colors from theme tokens, never hardcoded hex; `aria-label` carries the status text.
- `GoldenPathCard` — a prominent CTA card (icon, title, body, primary button) for the
  "Connect an agent" launchpad hero.
- `EmptyState` — wrap shadcn `empty` with icon/title/description/action.
- `SectionCard` — titled card container with header actions slot (for dashboard sections).

### 3. Home / Overview page — `src/app/(ux-lab)/lab/page.tsx` (replace the smoke-test page)
The golden-path launchpad. In one screen, above the fold:
- A **hero** `GoldenPathCard`: "Connect an agent" — the single most important action, explaining
  the value in one line (governed DuckDB access in minutes). Primary CTA.
- A row of `StatPill`s: active agents, live sessions, session-hours this week, credit balance
  (from `/api/cp/usage` + counts).
- **Live sessions** `SectionCard`: compact table (shadcn `table`) — agent name, lake **name**,
  last query (truncated), started; empty state if none.
- **Your agents** `SectionCard`: top few agents with `StatusDot` + last-seen, link to /lab/agents.
- Each section fetches its OWN data via `fetchCp` with loading skeletons + empty states.
- Other nav routes (/lab/agents, /lab/data, etc.) may be minimal placeholders for now
  (a `PageHeader` + "coming in a later loop" EmptyState) so the shell navigates without 404s.

## Constraints & quality bar
- Dark-first; must also look correct in light mode (use theme tokens: `bg-background`,
  `text-foreground`, `text-muted-foreground`, `bg-sidebar`, `border`, etc. — NO hardcoded colors).
- Responsive: sidebar collapses on narrow widths; content reflows.
- TypeScript strict; no `any` in component props. Reuse `types.ts`. Run
  `pnpm run typecheck` (from `apps/waddling`) and fix errors you introduce in these files.
- Keep it tasteful and restrained — generous spacing, clear hierarchy, one accent. Avoid
  generic-AI-dashboard clutter. This is the brand's first logged-in impression.
- Do NOT edit anything under `(dashboard)`, `(marketing)`, `(auth)`, or existing components
  outside the files listed above (plus the new `waddling/*` and `api/cp/*` + `lab/fixtures`).

## Output
Implement all files. At the end, report: the list of files created/changed, the routes now
reachable under `/lab`, any `types.ts` fields you had to guess, and any typecheck status.
Do not start a dev server — a separate verify step handles that.
