# Waddling UI/UX Loop — Master Scratchpad

Goal: a high-quality UI component library + interface flow for waddling that conveys
required info in **as few screens as possible** and gets users to the **agent interface**
(connect an agent DB → grant access → run governed queries) as fast as possible. Cover
all core functionality: **datalakes, gateways/endpoints, workspaces, quackboards, agents,
and team/connect features**.

Method: a self-paced loop. Each loop: write a Sonnet prompt for one UX object → a build
subagent implements it → a verify subagent runs dev + Chrome → evaluate (ease of use,
accessibility, forward flow, cohesiveness) → identify gaps → revise IA + design system →
revise the prompt.

---

## Iteration harness (decided)

The real `(dashboard)` layout hard-redirects to `/sign-in` without a live session and
fetches everything from a remote control-api (`/api/cp/*`). To iterate fast without auth
or a backend, we build in an **ungated prototype route** backed by a **mock data module**:

- **Route**: `apps/waddling/src/app/(ux-lab)/lab/...` — its own route group, NO auth gate,
  NO server session. Renders the new shell + flows directly.
- **Mock backend**: same-origin **`/api/cp/*` Next route handlers**, dev-gated, returning
  typed fixtures. Because `CONTROL_API_BASE` is empty when `NEXT_PUBLIC_CONTROL_API_URL`
  is unset, `fetchCp`/`cpUrl` resolve relative → same-origin → these handlers answer. So
  new components use the **real `fetchCp` unmodified** (zero divergence; free promotion).
  Mock lazily — only the contracts the current flow needs. Fixtures live in
  `src/lab/fixtures/*`; handlers in `src/app/api/cp/.../route.ts` guarded so they never
  run in prod (only serve when the real control-api origin is unset).
- **Promotion path**: once a flow is validated in the lab, it is promoted into the real
  `(dashboard)` surface (same components, real `fetchCp`). The lab is the design forge;
  the dashboard is production.
- **Design system** lives in real `src/components/ui` (shadcn) + new
  `src/components/waddling/*` composite primitives, shared by lab and dashboard.

Dev loop: `next dev` (port chosen to avoid collisions) → Chrome navigates to
`/lab/...` → screenshot → evaluate.

---

## Information architecture (the UX tree) — v0 proposal

Core diagnosis from the existing redesign doc (`agents-ux-redesign.md`): the agent concept
is shattered across `/agents`, `/agents/[id]`, `/connected`, `/sessions`, `/acl`, with
three inconsistent ways to edit access. The broader app has ~13 dashboard routes. The new
IA collapses this to a small number of **task-centric** surfaces.

Proposed top-level (fewest-screens) IA:

```
Home / Overview        one glance: connect-an-agent CTA, live sessions, usage, recent activity
Data                   the lakes + their catalog (datalakes, endpoints/gateways folded in)
  └ Lake detail        catalog browser + access + workspaces + connect
Agents                 roster + provision + per-agent home (access/keys/sessions/memory)
  └ Agent detail       single home for one agent (sectioned sub-rail)
Quackboard             shared agent memory / coordination board (team-of-agents view)
Team                   members, roles, connected (delegated) principals
Settings/Billing       org, usage, credits, account
```

The **golden path** (north star): land → "Connect an agent" → copy install snippet + key →
agent appears → scope its access in-place → see it query live. Target: ≤3 screens from
landing to a connected, scoped, querying agent.

### Build order (most abstract → concrete)

1. **App shell + IA** — nav, command palette, breadcrumb, theme. (the frame everything sits in)
2. **Home/Overview** — the golden-path launchpad + at-a-glance state.
3. **Connect-an-agent flow** — the core "fast to value" funnel (provision → install → scope).
4. **Agent detail** — sectioned single-home (per existing redesign plan).
5. **Data / Lake detail** — catalog browser + access + connect.
6. **Quackboard** — shared memory board.
7. **Team / Connect** — members, roles, delegations.
8. Cross-cutting: empty states, loading, error, toasts, a11y pass, cohesion pass.

---

## Design system notes (living)

- Base: shadcn (button, card, dialog, sheet, sidebar, table, tabs, command, etc. already present).
- Add composite `waddling/*`: PageHeader, SectionRail, StatPill, CopyField, CodeSnippet,
  StatusDot, EmptyState (wrap shadcn empty), DataLakeIcon (exists), AgentRow, GoldenPathCard.
- Tokens: use CSS vars already in the theme (--background, --sidebar, etc). Themeable
  assets must use currentColor (see memory: themeable-assets-preference).

---

## Loop log

(entries appended below, newest last)

---

### Loop 0 — verify-loop gate (PASSED)

- **UX pathway**: n/a (harness smoke test) — ungated `/lab` hello page.
- **Prompt**: none (authored directly).
- **Screenshot**: dark bg, themed shadcn buttons (Primary/Outline/Ghost) render. `shots/loop0-smoke.png` (in-conversation capture ss_639160avc).
- **Result**: PROVEN — `PORT=4317 SKIP_ENV_VALIDATION=1 pnpm run dev` boots in ~0.4s; `/lab` 200; Chrome renders + screenshots. Root layout supplies fumadocs theme; `(ux-lab)/layout.tsx` adds Tooltip+Toaster.
- **Gotchas learned**:
  - Launch dev as the background task directly — NO inner `&` (double-background kills it).
  - Pass port via `PORT=4317` env, NOT `pnpm run dev -- -p` (mangled into a project-dir arg).
  - middleware.ts only redirects on the two prod hosts; localhost passes through.
  - Mock backend will be **same-origin `/api/cp/*` Next route handlers** (dev-gated) so components use real `fetchCp` unmodified (advisor steer).
- **Next**: Loop 1 — app shell + golden-path Home/Overview.

