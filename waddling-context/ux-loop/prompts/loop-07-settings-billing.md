# Loop 7 build prompt — Settings / Billing (`/lab/settings`)

Build the **Settings** surface: the org/account/usage/billing hub. This is the last top-level IA
surface. In the ungated `(ux-lab)` design forge with mock data.

waddling billing model (don't invent contradicting mechanics): **prepaid credits**. A plan/tier
grants a **monthly credit allotment** (balance resets to the tier max each month); users **top up**
in increments (≥ $10 min). Usage is **per-second**, billed against credits (the headline rate is
about **$0.50 per session-hour**). Email verification is required to use the product. Settings is
mostly read + light management (org identity, see usage, manage credits/plan, account profile).

Scope discipline: ONLY create/edit under `apps/waddling/src/app/(ux-lab)/**`,
`apps/waddling/src/components/waddling/**`, `apps/waddling/src/app/api/cp/**` (mock handlers),
`apps/waddling/src/lab/fixtures/**`. Do NOT touch `(dashboard)`, `(marketing)`, `(auth)`, or
shared `ui/*`.

## Read first (reuse, match idioms)
- `apps/waddling/src/components/waddling/detail-layout.tsx` — the Settings hub MUST use this
  (header + section sub-rail, URL `?section=`). It already powers Lake detail + Agent detail.
  Read `apps/waddling/src/app/(ux-lab)/lab/data/[id]/page.tsx` for the composition pattern
  (header `meta`/`actions`, section `badge`/`content`).
- ALL `apps/waddling/src/components/waddling/*` primitives — REUSE: PageHeader (not needed if
  DetailLayout owns the h1), SectionCard (`headingLevel`), StatPill, StatusDot, EmptyState,
  CopyButton, CodeBlock, KeyReveal, `agent-status.ts` (formatRelative). Match the design language.
- `apps/waddling/src/components/ui/chart.tsx` (shadcn chart, Recharts) — use it for the usage
  chart if straightforward; otherwise a simple CSS bar sparkline is fine. Don't over-invest.
- `apps/waddling/src/components/dashboard/fetch.ts` — `fetchCp`/`cpPost`. Contracts:
  `GET /api/cp/usage → { rollup, series }`, `GET /api/cp/billing → { plan, portalUrl?, invoices? }`,
  `GET /api/cp/settings → { org, members, apiKeys }`. (The lab already has a `usage` handler +
  a `team` handler with org info — reuse/extend; don't collide with `/api/cp/team`.)
- `apps/waddling/src/lib/types.ts` — reuse `UsageRollup`, `OrgInfo`, `PlanInfo`, `Invoice`,
  `ApiKeyRow` if present; extend fixture-local types if a field is missing (document it).

## Deliverable

### 1. Mock backend (dev-gated; guard each with the NEXT_PUBLIC_CONTROL_API_URL 404 check)
- `GET /api/cp/billing → { plan, creditBalanceCents, monthlyAllotmentCents, ratePerSessionHourCents,
  renewsAt, invoices: { id, date, amountCents, status }[] }` — a believable prepaid-credits state
  (e.g. Team plan, balance $43.20 consistent with the Home stat, $0.50/session-hr rate, 3 invoices).
- `GET /api/cp/usage` already exists (rollup + 7-day series) — reuse it; if it lacks a per-day
  credits-consumed figure, extend the fixture (document).
- Org info: reuse the lab's existing org fixture (the `team` fixture has org info) or add a small
  `GET /api/cp/org → { org: { id, name, slug, createdAt, plan } }`. Keep org name "Anomalous"
  consistent with the shell's org switcher.
- Mock mutations (echo success + toast): `POST /api/cp/billing/topup` (amount), `POST /api/cp/org`
  (rename), `POST /api/cp/account` (profile). No real Stripe.

### 2. Settings page — `src/app/(ux-lab)/lab/settings/page.tsx` (replace placeholder) via `DetailLayout`
Header: title "Settings" (the h1) + meta (org name · plan). Sections (sub-rail), in order:
- **Organization** (default) — org identity: name (editable inline or via a small dialog →
  POST rename, optimistic + toast), slug (read-only/copyable), created. A clearly-separated
  **Danger zone** card (destructive border) with "Delete organization" behind an AlertDialog that
  requires typing the org name to confirm (the standard footgun guard).
- **Usage** — a row of `StatPill`s (session-hours this period, queries, credits consumed, active
  agents) + a **usage chart** (the 7-day series — session-hours or credits per day) using the
  shadcn chart or a simple bar sparkline, with an accessible text alternative / data table
  fallback (a chart must not be the ONLY way to read the data — include a small `<table>` or
  visually-hidden summary). Period selector optional.
- **Billing** — the prepaid-credits home: a prominent **credit balance** card ($ from cents) with
  the monthly allotment + renews-at, the **usage rate** ($0.50 / session-hour), a **"Buy credits"**
  action (Dialog: amount input, ≥ $10 min validation → POST topup, optimistic balance bump +
  toast — NO real payment, and DO NOT enter card details), the current **plan/tier**, and an
  **invoices** `<table>` (date, amount, status badge) with a "Manage billing" link (portal stub).
- **Account** — the current user's profile (name, email + a "verified" badge, avatar), a theme
  preference note (the toggle already lives in the shell), and a **Sign out** action (stub).
  Keep it light; this is personal, not org, settings.

## Quality bar (carry forward ALL prior lessons — these have been graded)
- ONE h1 per page (DetailLayout title); sections use real h2/h3; sub-rail exposes the active
  section (the DetailLayout already does aria-current="page").
- **Destructive/irreversible actions (Delete organization) use a shadcn AlertDialog with a
  type-to-confirm guard**; reversible actions are amber or plain.
- **The usage chart MUST have a non-visual equivalent** (data table or sr-only summary) — a chart
  alone fails WCAG. Money is formatted from integer cents (never float-dollar fields).
- Real `<table>` semantics for invoices/usage; accessible names on icon-only controls; inputs
  (rename, top-up amount) have labels + validation messages with `role="alert"`; copy via
  CopyButton; status via StatusDot or text badges (not color alone).
- Keyboard-operable + visibly focusable throughout; dialogs are shadcn (accessible).
- **NEVER prompt for or accept real payment/card details** — "Buy credits" is a mock amount field
  only; the spec is explicit that card entry is out of scope.
- Dark-first AND correct in light mode (theme tokens only; established amber/destructive button
  convention OK). Cohesive with shell + Home + Connect + Data + Agents + Quackboard + Team.
- TypeScript strict, no `any` in props; reuse `types.ts`/fixtures. Run `pnpm run typecheck`
  (from `apps/waddling`) and fix NEW errors in your files. Do not start a dev server.

## Output
Report: files created/changed, the `/lab/settings` behavior per section (Organization / Usage /
Billing / Account), new fixtures/handlers/types, what was reused, the chart's accessible
fallback, and typecheck status.
