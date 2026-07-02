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


---

### Loop 1 — App shell + golden-path Home/Overview

- **UX pathway**: land on `/lab` (logged-in launchpad) → see "Connect an agent" hero + at-a-glance state (stat pills, live sessions, agent roster) → nav via sidebar/⌘K to Agents/Data/Quackboard/Team/Settings.
- **Sonnet prompt**: `prompts/loop-01-shell-home.md` (run by a Sonnet build subagent).
- **Build result**: 22 files; typecheck clean. New `app-shell.tsx` (collapsible sidebar IA, ⌘K CommandDialog, org switcher, theme toggle, user menu); 6 `waddling/*` primitives (PageHeader, StatPill, StatusDot, GoldenPathCard, EmptyState, SectionCard); Home page with independent-fetch sections (skeleton→data→empty); placeholder pages for the 5 other routes. Mock backend = same-origin dev-gated `/api/cp/{agents,datalakes,sessions,usage}` route handlers + `src/lab/fixtures/*`. Components use real `fetchCp` unmodified ✓.
- **Verify (Chrome, :4317)**: Home renders cleanly in dark mode — hero CTA, 4 stat pills (Active 2 / Live 2 / 12.7 hrs / $43.20), live-sessions table showing lake **names** + last query, agent roster with semantic StatusDots (active/idle/suspended). No console errors. ⌘K palette opens (Navigation + "Connect an agent" action), keyboard-wired. All 6 routes 200. Screenshots: ss_5114h62lz (Home), ss_0248xb11a (palette).
- **Self-check a11y note (to confirm in eval)**: header buttons have aria-labels; nav links have `<span>{label}</span>` so names should compute (a read_page pass with the palette OPEN showed unnamed links — likely inert-background artifact, re-check with palette closed).
- **Evaluation**: independent Sonnet evaluator running (rubric + concrete a11y). _Results + FIX LIST + Loop 2 prompt changes appended next._


#### Loop 1 — evaluation (independent reviewer)

Scores: **Ease 2/5 · A11y 2/5 · Forward-flow 2/5 · Cohesion 4/5.** Strong primitive set;
the launchpad's CTAs were dead ends (the connect flow didn't exist yet) and several a11y
gaps. FIX LIST applied this turn (by me, surgically, to harden the shared library):

- [P0] Golden-path CTAs were no-ops (→ /lab). **Fixed**: hero, header "Connect agent", ⌘K
  action, and empty-state CTA all now point to `/lab/connect` (Loop 2 builds that route).
- [P0] "Active agents" count contradicted the roster. **Fixed**: StatRow now counts by the
  same derived `agentSemanticStatus`, so the pill and the dots agree.
- [P1] Home had no h1; SectionCard titles were `<div>`. **Fixed**: GoldenPathCard gained a
  `headingLevel` prop (Home hero is now `h1`); SectionCard renders a real `<h2>/<h3>` (not
  shadcn CardTitle div) via a `headingLevel` prop.
- [P1] No skip link; main not focus-targetable. **Fixed**: "Skip to main content" is the
  first focusable element; `<main id="main-content" tabIndex={-1}>`.
- [P1] StatusDot double-announced + used `role="status"` (live region) on static badges.
  **Fixed**: new `decorative` prop (aria-hidden leading dot); labeled variant uses visible
  text as the name; icon-only non-decorative uses `role="img"`. Leading roster dot → decorative.
- [P1] Duplicate sidebar-toggle in tab order. **Fixed**: `SidebarRail` is `tabIndex={-1}`
  (mouse affordance only); footer `SidebarTrigger` remains the keyboard toggle.
- [P2] StatusDot colour strategy mixed tokens/fixed. **Fixed**: one fixed semantic palette
  across all states (suspended → zinc).
- **Deferred** (documented, not yet done): focus-ring contrast is a global `--ring` theme
  decision (production risk — left for a deliberate token change, not a lab hack); agent
  rows non-interactive (needs the agent-detail route — Loop 4); table truncate robustness.

Typecheck clean after fixes; re-verified in Chrome — count reconciled, no regressions
(screenshot ss_23308kkum). Fixture realism note for Loop 2: timestamps are fixed → all
agents read Idle; make them now-relative so one reads Active alongside its live session.

**Design-system improvements banked**: StatusDot (`decorative`, single colour strategy),
SectionCard + GoldenPathCard (`headingLevel`) — heading semantics are now a first-class
prop across the library. Connect-snippet contract captured (MCP JSON · birdshot INSTALL/LOAD
· `ATTACH 'quack:<endpoint>?token=<key>'` · reveal-once `sk_agent_…`).

**Next (Loop 2)**: the connect-an-agent flow at `/lab/connect` — the core fast-to-value funnel.


#### Interjected fix — ⌘K double search bar

User reported ⌘K opened TWO search bars. Cause: the root `RootProvider` (fumadocs) binds
⌘K for docs search; the app-shell also binds ⌘K → both opened. Fix: app-shell's ⌘K listener
now uses `{ capture: true }` + `e.stopImmediatePropagation()`, so the shell owns ⌘K wherever
it mounts (lab now, dashboard later) while docs/marketing (no shell) keep fumadocs search.
Verified live: a single command palette opens (ss_22677j7i4). NOTE: re-verify this survives
the Loop 2 build if that subagent rewrote app-shell.tsx.

---

### Loop 2 — Connect-an-agent flow (`/lab/connect`)

- **UX pathway**: Home CTA → `/lab/connect` single-screen stepper wizard:
  **1 Identify & target** (name, description, access-mode toggle, lake picker w/ status) →
  **2 Install & connect** (reveal-once `sk_agent_…` key + amber "copy now" warning; MCP/Raw-DuckDB
  tabbed CodeBlocks w/ key substituted) → **3 Scope access** (lake catalog schemas→tables,
  per-table Read[/Write] checkboxes, least-privilege default) → **Done** (granted-tables recap +
  "View agent" / "Connect another").
- **Sonnet prompt**: `prompts/loop-02-connect-flow.md`.
- **Build**: 12 files; typecheck 0 errors. New primitives: `Stepper`, `CopyButton` (aria-live
  "Copied"), `CodeBlock`, `KeyReveal`. Mock handlers added: `POST /api/cp/agents` (returns
  reveal-once key), `GET /api/cp/datalakes/[id]` (catalog), `POST /api/cp/acl`. Fixture realism
  fixed: agents `lastSeenAt` now computed at request time (1 Active / 1 Idle / 1 Suspended).
- **Verify (Chrome, walked the full flow)**: Step 1 ss_6502wnngx, Step 2 (key+MCP JSON)
  ss_4985nad2s, Step 3 (catalog ACLs) ss_839164lkx. Created `reporting-bot` → key
  `sk_agent_004a3b46…` → MCP config correct (WADDLING_URL/API_KEY substituted, mirrors
  `connect-dialog.tsx`) → scope step lists ANALYTICS(events/conversions/sessions) +
  RAW(clickstream/impressions) with column counts. Programmatic focus moves to each new step.
  Read-only mode correctly hides the Write column. No console errors.
- **Open items**: (lint) `connect/page.tsx:116` uses deprecated DOM `FormEvent` global — import
  from `react` instead (trivial). Independent evaluation NOT yet run (paused per user).
- **Design-system additions banked**: Stepper, CopyButton, CodeBlock, KeyReveal — the library
  now covers wizard + secret-reveal + copyable-snippet patterns, reusable by all later flows.

**STATUS: paused for user go-ahead before Loop 3 (Data / Lake detail).**


#### Loop 2 — revision (user steer): merge Identify + Scope into one view

User: "identify and scope can be refined to be the same view." Done — the connect wizard
went from **3 steps → 2**: **Configure** (name, description, access mode, lake picker, AND
the lake's table-scope checkboxes inline — revealed the moment a lake is selected; catalog
fetched on selection, selections reset per-lake) → **Connect** (reveal-once key + MCP/DuckDB
snippets + an "Agent created" recap of the granted tables). Submit ("Create & connect")
creates the agent then grants the checked tables in one action; partial-grant failures are
surfaced honestly. Live aria-live hint shows "N tables selected / will connect unscoped".
Verified end-to-end in Chrome (ss_3295w1kq5 configure, ss_7452pvupe lake+inline-scope,
ss_5971lmjy9 connect, recap shows `analytics.events`). Typecheck clean.
Stepper STEPS = ['Configure','Connect']. (FormEvent deprecation = benign tooling lint.)
Loop 2 independent evaluation still owed (subagent infra was unavailable; rerun when free).

---

### Loop 3 — Data surface + Lake detail (`/lab/data`, `/lab/data/[id]`)

- **UX pathway**: Data nav → lakes grid (status, table/size/agent counts) → lake detail with a
  `DetailLayout` sub-rail: **Connect** (default — gateway endpoint URL + copy + `ATTACH 'quack:…'`
  + birdshot INSTALL/LOAD) · **Catalog** (schema→table browser, search, col/row counts, expandable
  columns) · **Access** (agent→table verb matrix, read/write badges) · **Workspaces** (per-agent).
- **Sonnet prompt**: `prompts/loop-03-data-lake-detail.md`.
- **Build**: DetailLayout primitive (generic header + URL-driven `?section=` sub-rail, aria-current,
  mobile `<select>` fallback) + Data index + /data/new placeholder + lake detail; mock handlers
  (workspaces GET, acl GET) + enriched datalakes (tableCount/sizeBytes/agentCount derived from
  catalog+ACL as single source of truth). Typecheck 0 errors.
- **Verify (Chrome)**: ss_1641smrew (Data index: Event Lake Active 5t/17GB/2a, Product Catalog
  Provisioning), ss_5237elvq3 (Connect: gateway dl-01j8events.gw… + ATTACH snippet), ss_0653vapdk
  (Catalog: analytics+raw schemas, real row estimates), ss_7097a037l (Access: verb-badge matrix).
  URL updates per section (linkable, back-button friendly). Gateway is first-class, not buried.
- **Design-system addition banked**: `DetailLayout` — the reusable single-entity detail scaffold
  (header + section sub-rail). **Hosts Agent detail in Loop 4** with zero new layout work.
- **Evaluation**: owed Loop 2 (consolidated flow) + Loop 3 evaluations launching now.


#### Loop 2 + Loop 3 — independent evaluations & applied fixes

**Loop 2 (consolidated connect flow)**: Ease 4 / A11y 3 / Forward 4 / Cohesion 4 — consolidation
validated. **Loop 3 (Data/Lake detail)**: Ease 3 / A11y 3 / Forward 2 / Cohesion 3; two findings
hit the SHARED foundation.

Fixes applied this pass (surgical, by me):
- **[P0] Double `<main>` landmark** (every page): app-shell inner `<main id=main-content>` →
  `<div>` (shadcn SidebarInset already owns the page's single `<main>`). Skip link still targets it.
- **[P0] Catalog expand rows keyboard-inaccessible** (WCAG 2.1.1): chevron is now a real
  `<button>` with aria-expanded/controls/label + focus ring; row click kept for mouse.
- **[P0] Stale validation errors**: name/lake errors clear on input; **[P1] focus moves to the
  name field** on invalid submit.
- **[P0] Submit button off-screen**: connect action bar is now `sticky bottom-0` (border-t + blur).
- **[P1] Access badge** showed rule count (5) → now distinct **agent count (2)**, matching copy. ✓live
- **[P1] Provisioning lake radio run-on name**: radio `aria-label={lake.name}` + status via
  `aria-describedby`. **[P1] Schema groups** → `<fieldset>/<legend>` so checkboxes announce schema.
- **[P1] Forward path**: Connect section now has a "Next: review which agents can access →" bridge.
- **[P2]** `aria-current="page"` on sub-rail; `<pre aria-label>` in CodeBlock; read+write helper
  wording; removed redundant sr-only checkbox labels.
- Typecheck clean throughout. (FormEvent deprecation = benign lint, left as-is.)

Deferred (documented, lower value / out of lab scope): recap write-table markers; lake-preselect
`?lake=` into the wizard; grouped-by-agent Access view; `lakeSemanticStatus` dedup to a shared util;
"Back to Data" promotion; provisioning-lake workspace fixture inconsistency; **connect-dialog.tsx**
CopyBlock→CopyButton + endpoint prop (it's a `(dashboard)` production file — out of the lab's edit scope).

**Next: Loop 4 — Agent detail** (single home for one agent) built on `DetailLayout`.

---

### Loop 4 — Agents roster + Agent detail (`/lab/agents`, `/lab/agents/[id]`)

- **UX pathway**: Agents nav → roster (search, sort, status/mode/last-seen/session-count, ⋯ menu
  w/ Suspend·Delete) → agent detail via `DetailLayout` sub-rail: **Overview** (identity + reachable
  data grouped by lake) · **Access** (grants grouped by lake, Revoke w/ confirm) · **Keys**
  (list + masked prefix + per-key Revoke + "Issue new key" reveal-once) · **Sessions** (this agent's,
  lake names, Kill w/ confirm) · **Memory/Activity** roadmap empty states. Header: Suspend/Resume +
  ⋯ (Delete) — all destructive actions behind shadcn AlertDialog.
- **Sonnet prompt**: `prompts/loop-04-agent-detail.md`.
- **Build**: agent detail page + roster + shared `agent-status.ts` helper (extracted `agentSemanticStatus`
  + `formatRelative` — Home now imports it; no third copy) + `agent-keys` fixtures + 9 dev-gated mock
  handlers (agent GET/DELETE, keys GET/POST/revoke, session kill, suspend/resume, acl DELETE). Typecheck
  0 errors (fixed one unused-prop lint in AccessSection myself).
- **Verify (Chrome)**: roster ss_9439pn5gy (analytics-etl Active 1 session / insight-bot Idle /
  legacy-reporter Suspended — consistent w/ fixtures); detail Overview ss_8588hkm5b (reachable data =
  Event Lake grants, matches Data surface); Keys ss_55360ktxb (per-key revoke + Issue-new). URL-driven
  `?section=`. No console errors. Light mode renders correctly too.
- **Design-system note**: `DetailLayout` reused with ZERO changes for Agent detail — the primitive
  generalised exactly as intended. Shared `agent-status` helper banked.
- **Evaluation**: independent Loop 4 evaluator launching now.

**STATUS: paused for user approval before Loop 5 (per standing instruction).**

#### Loop 4 — evaluation + applied fixes

Scores: **Ease 4 / A11y 3 / Forward 3.5 / Cohesion 4.** Strong "what passes" (all destructive
actions behind AlertDialog with context-aware copy, real table semantics, aria-current, shared
DetailLayout). Fixes applied this pass (in lab scope):
- **[P1] Suspend recolored amber** (`bg-amber-600`) in roster + detail — reversible no longer
  conflated with destructive-red Delete/Revoke/Kill.
- **[P1] Issue-key dialog** now has an explicit **Cancel** button (was X-only).
- **[P2] Extracted `VerbChip`+`ModeChip`** → shared `components/waddling/agent-chips.tsx`; both
  agent pages import it (removed dup + now-unused `cn` imports). Verified roster still renders.
- **[P2] detail-layout badge `aria-label`** pluralization fixed ("1 item" not "1 items").
- **[P0] aria-modal "missing" = FALSE POSITIVE**: Radix `react-alert-dialog@1.1.16` enforces
  modality via background `aria-hidden`/`inert` (current best practice), not the `aria-modal`
  attribute — no fix needed. (Evaluator also misread detail-layout `aria-controls`: panel ids
  DO match `${panelId}-panel`.)

Deferred (documented): **breadcrumb shows raw id** not name (Data + Agents; needs a lab
breadcrumb-override context — worth a polish pass); add-grants agent preselect into Connect
(cross-surface feature, cousin of lake-preselect); `<th scope="col">` + light-mode
`--muted-foreground` ~4.3:1 contrast (both shared `ui/*`/global-theme — out of lab edit scope,
affect production); sessions badge active-vs-total ambiguity. Typecheck clean throughout.

---

### Loop 5 — Quackboard (`/lab/quackboard`)

- **UX pathway**: Quackboard nav → board view: stat pills (active-on-board, entries today,
  channels, memory entries) + participants strip → **Activity** tab (channels rail w/ counts +
  last-activity | coordination feed: agent · kind badge observe/message/handoff · channel tag ·
  content · time) and **Memory** tab (per-agent durable KV — key/value-preview/updated/size,
  governance note "private, not editable"; suspended agent shows empty).
- **Sonnet prompt**: `prompts/loop-05-quackboard.md`. (Builder self-reviewed via advisor and
  fixed channel-count consistency + participant derivation before returning.)
- **Build**: quackboard fixtures + 4 dev-gated handlers (channels, activity, memory, stats) +
  page (PageHeader + segmented Activity/Memory + two-pane channels|feed). Reused all primitives
  + agent-status helper; did NOT use DetailLayout (correct — it's a board). Typecheck 0 errors.
- **Verify (Chrome)**: Activity ss_9616sewc4 (12 realistic coordination entries, color-coded
  kinds, channels coordination/handoffs/shared-findings), Memory ss_0310ofiu3 (analytics-etl 3
  entries, insight-bot 2, legacy-reporter 0). No console errors. Cohesive w/ shell + everything.
  Note: first compile was slow (~98s + a 30s fs-cache compaction — dev artifact, not a render bug;
  warm loads ~175ms).
- **Evaluation**: independent Loop 5 evaluator launching now.

**STATUS: paused for user approval before Loop 6 (Team).**

#### Loop 5 — evaluation + applied fixes

Scores: **Ease 3 / A11y 2 / Forward 3 / Cohesion 4** (A11y lowest yet — concrete fixes).
Applied this pass (verified in Chrome):
- **[P0] TabsList dead focus stop** — `tabIndex={-1}` on the Quackboard TabsList (roving tabindex
  on triggers still drives keyboard nav). Removes a confusing container stop.
- **[P1] Channel buttons announced "coordination55m ago2 agents"** — added composed `aria-label`
  ("coordination, 5 entries, last active 4m ago, 2 agents"). ✓ confirmed in a11y tree.
- **[P1] Feed heading h3→h2** — now a peer of the Channels rail, not a semantic child.
- **[P2] Badge contrast** — kind badges (observe/remember/handoff/message) AND shared
  `agent-chips` (Verb/Mode) bumped light-mode text `-600`→`-700` (kept dark `-400`); fixes the
  amber ~2.2:1 AA fail on the 10% tint.
- **[P2] Active channel indicator** — added `border-l-2 border-foreground` + bold on selected
  (was a too-subtle `bg-accent` only). ✓ visible.

Deferred (documented): **URL sync** for `?tab`/`?channel` (back-button + linkability — P1, moderate;
fold into polish pass); participants strip list semantics; memory value `title`/expand for long
values; extract `KindBadge` → `waddling/`; feed-entry→agent crosslink; `TabsContent outline-none`
focus-ring (shared ui, low value); StatPill `<dl>` semantics. Typecheck clean throughout.

---

### Loop 6 — Team (`/lab/team`)

- **UX pathway**: Team nav → stat pills (members / pending invites / admins+owners / active
  delegations) → **Members** table (avatar+name+email, role badge, status, joined; ⋯ menu:
  change role [reversible toast] + Remove [confirm]; sole-owner & self guards as disabled+explained)
  + **Pending invites** sub-list (Resend / Revoke[confirm]) → **Delegated access** (explainer:
  intersection of member's grants ∩ agent's grants, per-session, never stored; principal→agent
  [linked], scope summary, granted, status; Revoke[confirm]). **Invite member** opens a labeled
  Dialog (email + role Select).
- **Sonnet prompt**: `prompts/loop-06-team.md`.
- **Build**: team fixtures (4 members, 2 invites, 3 delegations) + 6 dev-gated handlers under a
  fresh `/api/cp/team/*` namespace (avoids colliding with the dashboard's settings/delegations
  consumers) + page. Reused PageHeader/SectionCard/StatPill/EmptyState + formatRelative + the
  Agents-page table/⋯/AlertDialog/amber-vs-destructive pattern. Typecheck 0 errors (cleaned an
  unused import + made FormEvent generic).
- **Verify (Chrome)**: ss_3307mk660 (Members: Mirri B. Owner/you, Alice Admin, Bob+Priya Member;
  invites dev@/analyst@; Delegated access Alice→insight-bot, Mirri→analytics-etl), ss_35177o1kf
  (Invite dialog: labeled email + role Select w/ descriptions, Cancel/Send). No console errors.
  Cohesive with the whole app.
- **Evaluation**: independent Loop 6 evaluator launching now.

**STATUS: paused for user approval before the final stretch (Settings/Billing + cohesion pass).**

---

### Loop 7 — Settings / Billing (`/lab/settings`)  [built by main loop — subagents were rate-limited]

- **UX pathway**: Settings nav → `DetailLayout` hub: **Organization** (name, workspace URL+copy,
  created; Rename dialog; Danger zone → Delete org with TYPE-TO-CONFIRM AlertDialog) · **Usage**
  (StatPills + session-hours/day bar chart [aria-hidden, decorative] + an accessible data `<table>`
  as the real source) · **Billing** (prepaid-credits: $43.20 balance card consistent w/ Home, of
  $100/mo, $0.50/session-hour rate, Buy-credits dialog [≥$10, mock — no card entry], Team plan,
  invoices table) · **Account** (profile w/ verified badge, theme note, Sign out stub).
- **Build note**: the Loop 7 build subagent was cut off by a session usage limit before writing
  anything (and the dev server got killed). The user flagged "lab is down" — I restarted dev
  (:4317 back up) and built Settings myself in the main loop, reusing DetailLayout + all primitives
  + the existing usage/team(org) handlers + a new `billing` fixture/handler.
- **Verify (Chrome)**: Organization ss_0970ojuzo, Billing ss_2547pkkx7 ($43.20 · $0.50/hr · invoices),
  Usage ss_0619ef8xn (proportional bars + data table). URL-driven `?section=`. Typecheck 0 errors.
- **Two bugs found+fixed live**: `formatRelative` on a FUTURE renews-date → "just now" (switched to
  a formatted date); CSS %-height bars collapsed → switched to px heights against the fixed track.
- **Design-system note**: `DetailLayout` now powers Lake, Agent, AND Settings — three surfaces,
  one scaffold. Added `billing` fixture (integer-cents money).
- **Evaluation**: Loop 6 (Team) + Loop 7 (Settings) independent evals were both cut off by the
  usage limit; re-running now that capacity is back.

**IA COMPLETE** — App shell · Home · Connect · Data/Lake · Agents/Agent · Quackboard · Team · Settings.
Remaining: the two owed evals + a final cohesion/polish pass (deferred-items list above).

#### Loop 6 + Loop 7 — evaluations + applied fixes (retried after the usage-limit interruption)

**Loop 6 (Team)**: Ease 4 / A11y 2 / Forward 4 / Cohesion 4. **Loop 7 (Settings)**: Ease 4 / A11y 3 /
Forward 4 / Cohesion 4 (strong "what works" list — the main-loop-built Settings held up well).

Fixes applied (cross-cutting first — these were flagged across multiple surfaces, so fixing the
shared component fixes the whole app):
- **[P1] `<th scope="col">` missing on every table** → defaulted `scope="col"` on the shared
  `ui/table.tsx` TableHead (overridable). Fixes WCAG 1.3.1 across Data/Agents/Team/Settings at once.
- **[P0/P1] `aria-modal` missing on dialogs** (flagged by BOTH evaluators) → added `aria-modal="true"`
  to shared `ui/dialog.tsx` DialogContent + `ui/alert-dialog.tsx` AlertDialogContent. (Belt-and-
  suspenders vs Radix's own background-hiding; harmless if redundant.)
- **[P0] Team "ghost" AlertDialog** — the revoke-delegation dialog lingered in the DOM with null
  values during Radix's exit animation, exposing a malformed empty-name `<h2>` to AT. Fixed by
  **conditionally mounting** it (`{pendingRevokeDelegation && <AlertDialog open …>}`) so it unmounts
  cleanly with no ghost.
- **[P1] Team pending-invites** → real `<h3>` heading + `<ul>/<li>` list semantics (was `<p>`/`<div>`).
- **[P1] Settings "Add credits"** stayed enabled with a validation error → `disabled={pending || !!amountError}`.
- **[P2] Settings credit-balance card** → real `<h2>` heading (was `<p>`); **Team role Select** →
  removed redundant `aria-label` that overrode the `<Label>`.

False positives confirmed (NOT changed): dialog close-button "has no name" (it has an sr-only
"Close"); Team badge contrast (uses AA-compliant `-700` shades, legible in the screenshot).

Deferred to the optional cohesion/polish pass: breadcrumb shows raw id (not name) on Data/Agents
detail; Quackboard `?tab`/`?channel` URL sync + feed→agent crosslink + KindBadge extract; `<time
datetime>` wrappers; `$`-prefix label association. Typecheck clean; Team re-verified, no regression.

**ALL 7 LOOPS CLOSED** (built → verified → evaluated → fixed). IA complete + cohesive.

---

# Loop 8 — refinement pass (user-directed)

User feedback after the 7-loop close:
1. "a bunch of useless 4-slot info sections in quackboard, team, and home" → remove them.
2. Quackboard → make it actually a chat app: project groups (boards) that own topics; create
   new topics + new project groups; per-agent memory in a dropdown; an "All Memories" sidebar
   section; and a view of the memories of the *entire lake*.
3. Connection process → a **modal**, not its own page.
4. A **SQL editor + results table** on the data lake itself (runs against a gateway).

UX pathway touched: App-shell (global connect modal), Home, Team, Quackboard, Data/Lake detail.

## 8a — Connect → global modal  ✅ DONE + verified live
- New `components/waddling/connect-agent-dialog.tsx`: `ConnectAgentProvider` (mounts ONE
  `<Dialog>` over the current screen) + `useConnectAgent()` → `openConnect({ lakeId? })`. The whole
  2-step wizard (Configure-with-inline-scope → Connect) moved here, lifted verbatim from the old
  page. Width override `sm:max-w-2xl` over the shared DialogContent's `sm:max-w-sm`; modal scrolls
  (DialogContent already has max-h + overflow). On "View agent" the modal closes BEFORE navigating.
  Wizard remounts per open (instanceKey) so step/state always resets.
- Provider mounted once in `app-shell.tsx` (wraps SidebarProvider). All **9** `/lab/connect`
  triggers rewired to `openConnect()` (grep-swept first so no dead link ships): header button,
  ⌘K palette action, home hero + agents-empty-state, agents page header + empty-state, agent-detail
  "Add grants" + "Connect flow", lake-detail actions (passes `{lakeId}` to preselect the lake).
- `/lab/connect` route is now a thin redirect-and-open stub (bounces to /lab, opens the modal) so
  old deep links stay alive without a standalone page.
- Verified: clicking "Connect agent" on Home overlays the full wizard modal (screenshot
  ss_5488w6paq). Typecheck clean (0 errors).

## 8b — Remove "useless" 4-slot stat rows  ✅ DONE + verified live
- **Home**: deleted the `StatRow` (Active agents / Live sessions / Session-hours / Credit balance)
  + its `UsageResponse` type; cleaned unused imports (StatPill, Clock, CreditCard, UsageRollup,
  UsageSeries). Home is now hero → Live sessions → Your agents (screenshot ss_64537v3r3).
- **Team**: deleted the 4 StatPills (Members / Pending invites / Admins & owners / Active
  delegations) + derived counts + unused imports (StatPill, ShieldCheck, Link2).
- **Quackboard**: its stat row + "Participants" strip die in the 8c rewrite.

## 8c — Quackboard chat app  ⏳ in progress (Sonnet subagent QuackboardChat)
## 8d — Lake SQL editor + results table  ⏳ in progress (Sonnet subagent LakeSqlEditor)

## 8c — Quackboard chat app  ✅ DONE + verified live (Sonnet: QuackboardChat)
**Sonnet prompt:** rewrite quackboard as a Slack/Discord-style chat app — left rail with PROJECT
GROUPS (collapsible groups that own topics) + a MEMORY section ("All Memories"); main pane = chat
feed (list) + composer for the selected topic, OR a memory browser (By-agent accordion / Entire-lake
flat list) for All Memories; create-group + add-topic via optimistic client state (no fake
persistence); request-time fixtures (ProjectGroup, Topic replacing QbChannel, topicId on QbEntry);
restructured `/api/cp/quackboard/{groups,activity,memory}` (deleted channels+stats); kill the stat
row + participants strip; hold the a11y bar (one h1, list feed, labeled composer, aria-expanded
disclosures).

**New IA tree (rail):**
```
PROJECT GROUPS                         [+ New group]
  ▾ Nightly Pipeline
      # coordination   # handoffs   [+ Add topic]
  ▾ Analytics
      # shared-findings              [+ Add topic]
MEMORY
  ⊞ All Memories  →  [By agent | Entire lake]
```
**Verified live:**
- Chat feed renders agent + StatusDot + kind badge (observe/remember/handoff/message) + relative
  time + content; composer at bottom (screenshot ss_4085ist02).
- Optimistic send works — posted "M Bright · message · just now" via button AND via Enter
  (JS-confirmed: draft clears, entry appends; ss_7819umbfh). Send button is `disabled` until the
  textarea is non-empty (caught a false alarm where synthetic automation typing didn't trip React's
  value tracker — real keystrokes/native input events post fine).
- All Memories: By-agent accordions (analytics-etl 3 / insight-bot 2 / legacy-reporter empty-state)
  + Entire-lake toggle; governance note "private; shown for oversight, not editable" (ss_6486ocyhq).
- "+ New group" opens a labeled Dialog (Name + Create group/Close; ss_8036beyva).
**Design-system change:** added Enter-to-send (Shift+Enter = newline) to the composer — the
affordance that makes it read as a real chat app. KindBadge kept (AA `-700` light-mode shades).
**Deferred:** rail is `hidden sm:flex` → no topic switcher on mobile (desktop-first lab; note for
a later responsive pass). Per-agent memory dropdown could also surface inline in the chat header.

## 8d — Lake SQL editor + results table  ✅ DONE + verified live (Sonnet: LakeSqlEditor)
**Sonnet prompt:** add a "Query" DetailLayout section (after Connect) — labeled SQL `<textarea>`
pre-filled from the catalog (`SELECT * FROM <schema>.<firstTable> LIMIT 100;`), Run button +
⌘/Ctrl+Enter, results `<table>` (shadcn, `scope="col"` headers) with idle/loading/error/empty/
success states; mock `POST /api/cp/datalakes/[id]/query` deriving `{columns, rows, rowCount,
elapsedMs}` from the catalog fixture, with an on-brand birdshot **denial** path `{error, table,
reason}` for tables not in the catalog; gateway-endpoint note; a11y (labeled textarea, alert on
error, aria-live). Hard constraint: do NOT touch the existing openConnect button.
**Verified live:**
- Sub-rail: Connect · **Query** · Catalog(5) · Access(2) · Workspaces(2).
- Success: `SELECT * FROM analytics.events LIMIT 100` → 6-col typed results table, footer
  "10 rows · 83 ms" (ss_8215ksmwn).
- Denial: `SELECT * FROM secrets.api_keys` → amber "Access denied by birdshot" alert with Table +
  Reason "…not found in this lake's catalog — birdshot denies by default" (ss_67007mvcx).
- Gateway note shows `dl-01j8events.gw.getwaddling.com`; ⌘/Ctrl+Enter hint present.

**Loop 8 close:** all 4 user refinements built → verified live → (composer false-alarm chased to
ground) → Enter-to-send polish added. Typecheck clean (0 errors; only benign FormEvent hints).
Connect is now a context-preserving modal everywhere; stat-row clutter gone; Quackboard is a real
chat app with governed memory; lakes are directly queryable. **IA still cohesive — shared
DetailLayout / PageHeader / StatusDot / EmptyState / Dialog across every surface.**

---

# Loop 9 — workspaces inspectable + cross-surface cohesion audit

User re-looped (delegating direction). Picked the thinnest-covered core functionality:
**workspaces** (a per-agent governed DuckDB scratch DB). Was only a flat read-only row on the lake
detail. Enriched IN PLACE (no new nav/page — honors the single-access-surface + "few screens" goals).

## 9a — Workspace inspector  ✅ DONE + verified live (Sonnet: WorkspaceInspect)
**Sonnet prompt:** mirror the lake-detail **CatalogSection** expandable-row pattern for
**WorkspacesSection** — each workspace row expands (real `<button>` aria-expanded/aria-controls +
chevron) to a nested `<Table>` of the agent's materialized scratch tables (Table · ~Rows · Size ·
Last write), reusing the file's `formatRows`/`formatBytes`/`formatRelative`; extend the fixture with
`scratchTables: WorkspaceTable[]` (request-time factory, no module-scope Date); empty state for 0
tables; add a data-plane-boundary sentence (contents read live from the gateway, governed by
birdshot; control plane manages metadata only). Scope-locked to fixture + workspaces route +
WorkspacesSection.
**Verified live:**
- analytics-etl expands → stg_events (2.4M · 128MB · 5m), daily_rollup (182.5K · 45MB · 8m),
  anomaly_clusters (3.2K · 12MB · 15m); chevron flips; insight-bot collapsed below (ss_7379vcbb6).
- aria-expanded/aria-controls confirmed (JS-verified: expanded=true, controls=ws_01j8alpha-tables).
- Provisioning-lake workspace seeded with 0 scratch tables → empty state path.
- Data-plane note renders; numerics right-aligned; identical to Catalog rows (cohesion free).
- Typecheck 0 errors; /api/cp/workspaces returns populated scratchTables.
**Design-system note:** the CatalogSection expandable-row + nested-Table pattern is now a *reused
idiom* (catalog tables, workspace scratch tables) — a candidate to extract into a shared
`<ExpandableRows>` primitive if a third user appears.

## 9b — Cross-surface cohesion audit  ⏳ Sonnet CohesionAudit (read-only) running

## 9b — Cross-surface cohesion audit + fixes  ✅ DONE (Sonnet evaluator: CohesionAudit, read-only)
Ran an independent read-only evaluator across all 7 surfaces (heading levels, spacing scale,
empty-state tone, buttons, status/color discipline, tables, a11y) — the loop's step-4 evaluation,
aimed at cross-builder drift (3 surfaces built by different agents). It returned a prioritized
FIX LIST + a "confirmed cohesive" list.

**Applied (cheap, clearly-valid):**
- **P1-1** Access section hand-rolled verb badge → shared `VerbChip` (data/[id]). Bonus: VerbChip
  uses AA-compliant `-700` light shades; the old span used `-600` (failed AA) — a latent contrast
  bug fixed for free. Verified live (ss_2931ycmw3).
- **P1-2** SQL editor raw `<textarea>` → shadcn `<Textarea>` (matches quackboard composer).
  Verified live (ss_3507ub5tf).
- **P1-3** Quackboard create-group / add-topic dialogs raw `<label>` → shadcn `<Label>` (matches
  every other dialog).
- **P1-4** Quackboard page-level wrapper `gap-4` → `gap-6` (matches all other pages); skeleton too.
- **P1-5** Deleted data/[id]'s local `formatRelative` → import shared from `agent-status`.
- **P2-2** Removed lone `italic` on the connect-dialog empty hint (no other empty copy uses it).
- **P2-3 (architecture)** Extracted the duplicated `formatBytes`/`formatRows` into a new shared
  `src/lib/format.ts`; data/[id] + data/page import it. (Quackboard's compact B/KB memory formatter
  left as a *documented justified deviation* — tiny memory sizes read better compact.)

**Deliberately NOT applied (with reasoning):**
- **P0-1** clickable `<tr onClick>` in Catalog/Workspace rows "has no keyboard role" — keyboard
  parity already exists via the chevron `<button>` (aria-expanded/controls, fully operable). The row
  onClick is a redundant MOUSE target; adding tabIndex to the row = two keyboard stops/row (worse).
  WCAG 2.1.1 satisfied → not a real blocker. Left as-is.
- **P2-1** settings credit-balance `<h2>` — intentionally set to h2 in Loop 7; a titled metric card
  is defensible. Left.
- **P2-4** "No groups yet" bare `<p>` in the nav rail — audit itself called it a justified
  deviation (full EmptyState is disproportionate in a compact rail). Left.

**Confirmed cohesive (evaluator, do-not-touch):** StatusDot everywhere; EmptyState tone parallel;
amber/destructive color discipline 0 violations; AlertDialog on every destructive action; one h1
per page; SectionCard headingLevel=2 in the modal; shadcn Table for all tabular data; VerbChip/
ModeChip in agents; focus-visible rings universal; aria-hidden on decorative icons.

**Design-system additions this loop:** `src/lib/format.ts` (shared byte/row formatters); the
CatalogSection expandable-row idiom now reused by Workspaces (extract candidate if a 3rd user lands).

**Loop 9 close:** workspaces are now first-class (inspectable in place), and a real cross-surface
cohesion pass ran for the first time — drift caught + fixed, cohesion confirmed by an independent
evaluator. Typecheck clean (0 errors). All 5 core functionalities (data lakes, quackboards, team,
workspaces, gateways-via-Connect) are now individually implemented AND cohesive.

---

# Loop 10 — golden-path forward-flow pass + entity-name breadcrumbs

User re-looped (delegating choice). Picked **(c) golden-path forward-flow** — most directly tests
the loop's termination condition ("complete cohesive UX/UI" + "fast access to the agent interface").
The most visible concrete defect it surfaced: detail-page breadcrumbs showed raw ids.

## 10a — Entity-name breadcrumbs  ✅ DONE + verified live (Sonnet: BreadcrumbNames)
**Sonnet prompt:** add a small breadcrumb-title context so a detail page registers its entity name
for the LEAF crumb. `BreadcrumbTitleProvider` (leafTitle state) + `useSetBreadcrumbTitle(title)` hook
(sets on mount/change, **clears on unmount** so names don't bleed across navigations, no-ops while
undefined); `LabBreadcrumbs` renders `leafTitle ?? c.label` for the last crumb only (stays
`<BreadcrumbPage>` = aria-current). Wired into data/[id] (`useSetBreadcrumbTitle(lake?.name)`) and
agents/[id] (`useSetBreadcrumbTitle(agent?.name)`). Hooks called unconditionally at top level.
**Verified live:**
- Data detail: `Home › Data › Event Lake` (was `… › dl_01j8events`).
- Agent detail: `Home › Agents › analytics-etl` (was `… › agt_01j8…`) — ss_4670km4ht.
- Team: `Home › Team` — confirms unmount cleanup clears the leaf title (no stale bleed).
- Note: the leaf resolves *after* the async entity fetch; a screenshot taken mid-fetch briefly shows
  the raw id, then it updates. Acceptable (matches when the page content itself loads).
Typecheck 0 errors.
**Design-system addition:** `BreadcrumbTitleProvider` / `useSetBreadcrumbTitle` — any future detail
route gets a named breadcrumb by calling the hook with its entity name.

## 10b — Golden-path walkthrough (forward-flow evaluation)
Drove the full conversion path end-to-end in Chrome:
Home (hero "Connect an agent") → **Connect modal** opens over ANY screen (verified opening from the
agent-detail page) → Configure (name `reporting-bot` + pick Event Lake + inline table scope) →
**Connect success** (ss_63090bzce): stepper Configure✓→Connect; "reporting-bot is connected to Event
Lake"; reveal-once key `sk_agent_…` + amber "copy it now, you won't see it again"; MCP/Raw-DuckDB
connection snippets; honest nudge "No tables granted yet — scope access from the agent's page so it
can query."
**Forward-flow verdict (rubric):**
- *Ease of use:* fastest path to a connected agent = Home → modal → 2 inline steps, no page leaves.
- *Forward flow:* each step leads to the next; success step nudges the real next action (scope/connect);
  cross-links present (agent→lake, lake.Access→Agents, lake.Connect→Access, Query after Connect).
- *Cohesiveness:* entity-name breadcrumbs now orient the user on every detail page; shared primitives
  hold across all surfaces (confirmed by Loop 9b's independent audit).
- *Accessibility:* reveal-once key, amber/destructive discipline, labeled steps, one h1 per page.
**Minor, non-blocking:** success "View agent" routes to the Agents *list* (not the specific new agent)
— correct given the stateless lab mock (a freshly-created agent isn't in the list); the copy already
points to "the agent's page." Noted, not fixed.

**Loop 10 close:** breadcrumbs resolve entity names everywhere (orientation defect gone); the golden
path Home→connect→key→connect-snippet is fast, forward-leading, and cohesive end-to-end. Typecheck
clean. The IA is now feature-complete across all 5 core functionalities AND verified cohesive as a
single forward-flowing product.

---

# Loop 11 — complete the agent surface (Activity + Memory stubs)

User re-looped (delegating choice). Intended to take the responsive/mobile pass (last documented
gap), but **discovered the Chrome environment can't emulate a mobile viewport**: `resize_window`
shrinks `outerWidth` (→738) but the content `innerWidth` stays locked at 1710, so `sm:` always
matches and the mobile breakpoint never triggers. Building a responsive feature I cannot pixel-verify
in Chrome conflicts with this project's live-verify discipline → **deferred responsive to a real-device
pass** and pivoted to verifiable work.

Pivot evidence: auditing the agent-detail sub-rail at desktop, found **Memory** and **Activity** are
"coming soon" `<EmptyState>` STUBS (ss_86114wssw / ss_90570f6xt) — genuine incomplete functionality
in an otherwise feature-complete IA, central to "the agent interface," and fully desktop-verifiable.

## 11a — Agent Activity + Memory  ⏳ Sonnet AgentActivityMemory building
**Sonnet prompt:** replace the two stubs with real self-fetching sections.
- **Activity:** per-agent audit trail — new `agent-activity.ts` fixture (request-time
  AgentActivityEntry: query/grant/revoke/connect/deny + allow|deny decision + cost) + rollup
  (queriesToday/denials/creditSpent/lastActive); `/api/cp/agents/[id]/activity` route; presentation =
  light usage summary (NOT the removed 4-slot grid) + shadcn Table (Time·Action·Detail·Decision) with
  emerald allow / destructive deny chips. legacy-reporter seeded empty → EmptyState.
- **Memory:** this agent's `agent_memory` reusing `makeFixtureMemory(agentId)` (no fixture dup);
  `/api/cp/agents/[id]/memory` route; mirrors the Quackboard MemoryPane entry rendering + governance
  note + cross-link to /lab/quackboard.
- Allowed extra: a reusable `DecisionChip` in agent-chips.tsx (emerald/destructive, AA -700).

## 11a — Agent Activity + Memory  ✅ DONE + verified live (Sonnet: AgentActivityMemory)
Replaced both "coming soon" stubs with real, self-fetching, mock-backed sections.
**Files:** `lab/fixtures/agent-activity.ts` (new), `api/cp/agents/[id]/activity/route.ts` (new),
`api/cp/agents/[id]/memory/route.ts` (new, reuses `makeFixtureMemory(agentId)` — no fixture dup),
`components/waddling/agent-chips.tsx` (+`DecisionChip`), `agents/[id]/page.tsx` (+ActivitySection,
+MemorySection, stubs removed).
**Verified live:**
- **Activity** (ss_1764mril5): "Usage today" light metric strip (Queries 4 · **Denials 2** red ·
  Credit $0.14 · Last active 3m — NOT the removed 4-slot grid) + "Audit trail" Table
  (Time·Action·Detail·Decision). Deny rows are red-tinted with a red `deny` DecisionChip
  (`SELECT email FROM analytics.pii_users`), allows emerald, plus grant (violet) + connect events.
  The birdshot governance story made legible per-agent.
- **Memory** (ss_2280lg8ts): this agent's `agent_memory` (key · updated · size · value preview) +
  "Private to this agent — shown for oversight, not editable." + **"View in Quackboard →"** crosslink;
  mirrors the Quackboard MemoryPane rendering.
- **Empty path** (ss_25651mhd2): legacy-reporter (Suspended, 0 grants) → "No activity yet…" EmptyState
  for both sections. Breadcrumb still resolves "legacy-reporter" (Loop 10 holding).
Typecheck 0 errors.
**Design-system addition:** `DecisionChip` (allow=emerald / deny=destructive, AA -700 light) — the
chip family is now VerbChip · ModeChip · DecisionChip, all in agent-chips.tsx.

**Deferred (environment-blocked):** the responsive/mobile pass — this Chrome can't emulate a mobile
viewport (innerWidth locked at 1710, `sm:` always matches), so a responsive build can't be
pixel-verified here. Recommend a real-device pass (Quackboard rail→Sheet is the one known gap).

**Loop 11 close:** the agent surface is now STUB-FREE — Overview · Access · Keys · Sessions · Memory ·
Activity all real. Every core functionality is individually implemented with no placeholders, and the
IA remains cohesive (shared chips/tables/empty-states/breadcrumb-names throughout). Typecheck clean.

---

# Loop 12 — ⌘K command palette → real launcher

User re-looped past the "call it done" recommendation → wants continued improvement. Picked the
highest-value, fully-desktop-verifiable lever for the stated goal ("access the core functionality as
fast as possible / seamless process"): the **⌘K palette**, which today only links the 6 nav pages +
Connect. Turning it into a launcher (jump straight to any agent or lake by name + quick actions) is
the canonical "fast access" feature and ties the whole IA together.

## 12a — Command launcher  ⏳ Sonnet CommandLauncher building
**Sonnet prompt:** upgrade `CommandPalette` (app-shell.tsx) — fetch agents + lakes lazily on open
(cache for session, cancelled-flag guard), render **Agents** group (StatusDot + name + desc →
/lab/agents/[id]) and **Data lakes** group (Database icon + name + region → /lab/data/[id]) alongside
the existing **Navigation** + **Actions** (Connect an agent; add Invite a teammate → /lab/team);
cmdk auto-filters via `value={name + ' ' + desc}`; placeholder → "Search agents, lakes, actions…".
Scope-locked to app-shell.tsx only (routes already exist). Quackboard-topic deep-links deferred
(quackboard has no ?topic= param yet — would be scope creep).

## 12a — Command launcher  ✅ DONE + verified live (Sonnet: CommandLauncher)
Upgraded the ⌘K palette from a 6-page nav into a real launcher (one file: app-shell.tsx).
**Verified live (ss_4685pzkjo):**
- Opens via ⌘K; lazy-fetches agents + lakes on open (cached for the session).
- Groups: **Agents** (StatusDot + name + description), **Data lakes** (Database icon + name + region),
  **Navigation** (6 pages), **Actions** (Connect an agent · Invite a teammate).
- cmdk fuzzy-filters across name AND description: typing "event" surfaced `analytics-etl` (matched on
  its "…over the event lake" description) + `Event Lake` (matched on name) — other groups filtered out.
- Selecting "Event Lake" → navigated to `/lab/data/dl_01j8events` and the palette closed cleanly
  (ss_8137wkpnw; breadcrumb "Home › Data › Event Lake"). Jump-to-entity in ~4 keystrokes.
Typecheck 0 errors.
**Why this loop:** directly serves the North Star — "access the core functionality as fast as
possible / seamless process." The palette is now the single keyboard-driven hub across the IA.
**Deferred:** Quackboard-topic results (needs a `?topic=` deep-link param on the quackboard, out of
scope for an app-shell-only change); Team-member results.

**Loop 12 close:** ⌘K is a genuine launcher — fastest path to any agent or lake. Typecheck clean, IA
cohesive. The product now has both a guided golden path (Home→Connect modal) AND a power-user launcher.

---

# Loop 13 — data-lake creation flow (the foundational onboarding path)

User keeps re-looping past "done" → wants continued completion. Audited the two PRIMARY creation
paths: Connect (agent) is polished; **data-lake creation** (`/lab/data/new`) was still a "Coming soon"
STUB (ss_7120mn53t) — yet it's THE foundational object (no lake → an agent has nothing to connect to)
and is linked from the prominent "New data lake" button on /lab/data. Highest-value remaining build,
the data-foundation counterpart to the Connect golden path. Desktop-verifiable.

## 13a — Lake creation wizard  ⏳ Sonnet LakeCreate building
**Sonnet prompt:** replace the stub with a real flow mirroring the Connect wizard (Stepper, SectionCard,
inline validation, success panel — NOT a navigation, since the mock is stateless like Connect).
- FORM state: "Name & region" (name→auto slug preview, region select) + "Storage" radiogroup
  (Managed default / BYO S3 with endpoint·bucket·access-key·secret fields — **mock, "demo only, no
  real credentials", secrets NOT sent in the request body**).
- POST `/api/cp/datalakes` (new handler, dev-gated) → `{ datalake: { id, name, slug,
  status:'provisioning', schemas:[] } }`.
- SUCCESS state: "<name> is provisioning" + gateway endpoint (slug.gw.getwaddling.com, CopyButton) +
  CTAs **"Connect an agent" (openConnect — wires the foundation flow straight into the golden path)**
  + "Back to Data" + "Create another".
- Breadcrumb: `useSetBreadcrumbTitle('New data lake')` (fixes the raw `new` leaf).
Scope-locked to data/new/page.tsx + datalakes route POST.

## 13a — Lake creation wizard  ✅ DONE + verified live (Sonnet: LakeCreate)
Replaced the last "Coming soon" stub with a real two-state flow mirroring the Connect wizard.
**Verified live:**
- FORM (ss_3763vqg6d): breadcrumb "Home › Data › New data lake" (useSetBreadcrumbTitle); Stepper
  Configure→Provision; "Name & region" (name→**live slug derive** "Marketing Lake"→`marketing-lake`,
  aria-live; region select) + "Storage" radiogroup (Managed default / BYO).
- BYO (ss_3338zpz7a): reveals Endpoint·Bucket·Access key·Secret(password) with the amber **"Demo only
  — do not paste real credentials"** warning + "encrypted at rest; waddling never logs them"; secrets
  held in state but **omitted from the POST body** (credential-broker note). Security-conscious.
- SUCCESS (ss_4018pgo4q): Stepper Configure✓→Provision; "Marketing Lake is provisioning" green check;
  Gateway endpoint `marketing-lake.gw.getwaddling.com` (CodeBlock+copy); CTAs **"Connect an agent"
  (openConnect — foundation flow → golden path)** · "Back to Data" · "Create another". No router.push
  (stateless mock, same pattern as Connect).
- POST `/api/cp/datalakes` → `{datalake:{id,name,slug,status:'provisioning',schemas:[]}}` (GET intact).
Typecheck 0 errors.

**Loop 13 close — ZERO stubs remain.** Every page and every flow in the IA is now real and verified:
the full product journey is unbroken end-to-end — **create data lake → (provisioning) → connect agent
→ scope tables → query (governed, birdshot-enforced) → coordinate on the quackboard → govern via
team/delegation** — with a ⌘K launcher for fast jumps and entity-name breadcrumbs for orientation.
The design forge has met the loop's termination condition: all functionalities individually
implemented + a complete cohesive UX/UI.

---

# Loop 14 — Quackboard deep-links + launcher topic coverage

Product is stub-free; refining loose ends. Two explicit deferrals closed together: Quackboard topics
had NO URL state (not linkable/shareable) and the ⌘K launcher (Loop 12) deferred topic results. Making
topics deep-linkable (`?topic=` / `?view=memory`, mirroring the DetailLayout `?section=` pattern) +
adding a Quackboard group to the launcher makes coordination shareable and completes the launcher.

## 14a — Topic deep-links + launcher  ⏳ Sonnet TopicDeepLinks building
**Sonnet prompt:** (1) quackboard selection driven by the URL — derive active selection from
`useSearchParams()` + loaded topics (drop the `selected` useState → single source, no loop); route
topic/memory/create selections through `router.replace(..., {scroll:false})`; reflect incoming param
changes in-place (⌘K nav while mounted). (2) launcher: fetch `/api/cp/quackboard/groups` on open;
add a "Quackboard" CommandGroup (`# topic` via Hash icon) → `/lab/quackboard?topic=<id>`, value =
topic+group name for filtering. Scope-locked to quackboard/page.tsx + app-shell.tsx.

## 14a — Topic deep-links + launcher topics  ✅ DONE + verified live (Sonnet: TopicDeepLinks)
**Verified live:**
- `?topic=tp_handoffs` → opens the handoffs topic directly (rail highlighted, handoff feed, composer
  "Message #handoffs") — ss_1239wa96j.
- `?view=memory` → opens All Memories (By agent / Entire lake) — ss_1740j0yvz.
- ⌘K → type "hand" → handoffs appears in a new **Quackboard** group → selecting navigated to
  `/lab/quackboard?topic=tp_handoffs` and closed the palette (ss_0347n83bc).
**Implementation:** quackboard selection is now **URL-derived** — `selected` dropped from useState,
recomputed via `useMemo` over `useSearchParams()` + loaded topics (single source of truth, no
state↔URL loop; reads-only memo, writes only in interaction handlers via `router.replace(...,
{scroll:false})`). Default = first topic with a clean URL. Component wrapped in `<Suspense>` (required
for useSearchParams; matches the settings-page pattern). Launcher fetches `/api/cp/quackboard/groups`
in the same on-open Promise.all (cancelled-flag + cache), renders a "Quackboard" group (`# topic` via
Hash icon, value = topic+group name). Typecheck 0 errors.
**Design-system note:** Quackboard now uses the same URL-as-state idiom as DetailLayout's `?section=`
— the whole app is URL-addressable. The ⌘K launcher covers every entity type (agents · lakes ·
topics) + nav + actions.

**Loop 14 close:** agent coordination is now shareable (topic deep-links) and the launcher is
complete. Two long-standing deferrals closed. Typecheck clean; IA cohesive and fully URL-addressable.

---

# Loop 15 — final holistic UX audit + fixes

Product is feature-complete/stub-free; user keeps looping. Per the loop's own steps 4–5, ran a fresh
HIGH-SIGNAL holistic audit (rubric: ease-of-use · a11y · forward-flow · cohesiveness) across all 8
surfaces — the last full audit (9b) predated loops 10–14, so the new work (lake-create, agent
activity/memory, ⌘K launcher, quackboard URL state) gets scrutinized hardest + checked for consistency
with the older surfaces. Spot-checked first: lake cards on /lab/data ARE proper links with
status-aware accessible names ("Event Lake — active" → detail) — navigation affordances solid.

## 15a — Holistic audit  ⏳ Sonnet FullAudit (read-only) running
Will apply the legitimate P0/P1 findings, document skips with reasoning (as in 9b). A short,
mostly-P2 result is itself a valid "it's done" signal.

## 15a — Holistic audit + fixes  ✅ DONE (Sonnet evaluator: FullAudit, read-only)
FullAudit verdict: product in genuinely good shape — 1 P0, 3 P1, 4 P2, + a long verified
"confirmed strong" list. Applied all legitimate findings; verified live.
**Applied:**
- **P0-A (a11y)** lake-create storage + connect-modal access-mode radiogroups violated the WAI-ARIA
  roving-tabindex/arrow-key contract (independent tab stops). Fixed by a NEW shared
  `components/waddling/radio-segments.tsx` (`RadioSegments`) — correct roving tabindex + Arrow/Home/End,
  identical styling — used by BOTH forms (kills the bug class + dedups). Verified live: ArrowRight in
  the connect modal moved selection AND focus, tabIndex 0↔-1 (JS-confirmed).
- **P1-A (a11y/forward)** lake-create form→success dropped focus to body → `useEffect` focuses the
  success heading (`tabIndex={-1}` ref) on the phase flip.
- **P1-B (a11y)** quackboard topic + All-Memories rail buttons misused `aria-pressed` (toggle) →
  `aria-current` (current-item-in-set), both spots.
- **P1-C (forward/ease)** agent Activity denials were a dead end → "Add grants →" headerAction on the
  Audit-trail SectionCard when `rollup.denials > 0`, linking to `?section=access`. Verified live
  (ss_65205fuvr).
- **P2-A (a11y)** stepper `aria-current="step"` moved from the inner circle `<div>` to the `<li>`.
- **P2-C (forward)** stale `?topic=` (e.g. shared link to an optimistic id) silently fell back to
  topic[0] → now shows a "Topic not found" EmptyState with recovery guidance. Verified live
  (ss_7614tx8ui).
- **P2-D (ease)** Home "Your agents" rows were display-only `<div>`s → wrapped in `<Link>` to the
  agent detail (hover + focus ring), matching cross-surface link conventions.
**Skipped (with reasoning):**
- **P2-B** "missing scope=col on older tables" — FALSE POSITIVE: the shared `ui/table.tsx` TableHead
  DEFAULTS `scope="col"` (set in Loop 8), so every table already has it; ActivitySection's explicit
  one is merely redundant. The audit checked call sites without accounting for the component default.
**Design-system addition:** `RadioSegments` — accessible segmented radio primitive (third shared
control alongside Stepper/DetailLayout); the chip family + this now cover the app's custom controls.
Typecheck 0 errors.

**Loop 15 close:** the complete product passed a skeptical independent holistic audit (ease-of-use ·
a11y · forward-flow · cohesiveness) with only minor findings — all fixed or correctly dismissed. The
"confirmed strong" list independently verified: one h1/page, breadcrumb entity-names, destructive-
action AlertDialog guards, deny-rows-not-color-alone, BYO-secrets-omitted-from-POST, launcher
empty-group guards, URL round-trips, shared-component discipline. This is the strongest signal yet
that the design forge is DONE: feature-complete, stub-free, cohesive, accessible, URL-addressable.

---

# Loop 16 — Quackboard mobile drawer (last responsive-completeness gap)

User keeps looping past "done"; the forge survived a hostile audit (Loop 15). The one genuine
UI-COMPLETENESS gap left is responsive — deferred since Loop 8 because this Chrome env renders at a
fixed 1710px viewport and can't trigger the `sm` breakpoint. Taking it now scoped to the one concrete
dead end: the Quackboard rail is `hidden sm:flex`, so mobile users can't switch topics / open memory.
Verification strategy: desktop unchanged (fully verifiable) + force-open the Sheet via JS to verify
its contents (verifiable) + DOM/class checks; final breakpoint pixel-test is on the user's device.

## 16a — Quackboard mobile drawer  ⏳ Sonnet QuackboardMobile building
**Sonnet prompt:** keep the desktop inline rail as-is; add a `sm:hidden` mobile header (Topics trigger
+ current "# topic" / "All Memories" context label) opening a shadcn `Sheet side="left"` containing
the SAME `<LeftRail>`; selecting a topic/memory closes the Sheet (controlled open state) + navigates
via existing handleSelect; `SheetTitle` (sr-only) for a11y. Scope-locked to quackboard/page.tsx.

## 16a — Quackboard mobile drawer  ✅ DONE + verified (Sonnet: QuackboardMobile)
Closed the last responsive-completeness gap: mobile users can now switch topics / open memory.
**Implementation (quackboard/page.tsx only):** a `sm:hidden` mobile header (PanelLeft "Topics" trigger
+ live "# topic" / "All Memories" context label) opens a shadcn `Sheet side="left"` containing the
SAME `<LeftRail>` (no markup dup). Controlled `sheetOpen` state; the in-Sheet rail's `onSelect` wraps
`handleSelect` + `setSheetOpen(false)`; sr-only `SheetTitle "Board navigation"` for Radix a11y. The
desktop inline rail (`hidden sm:flex`) is a SIBLING — untouched.
**Verified (to the limit of the env):**
- Desktop UNCHANGED at 1710px — inline rail, no mobile header (ss_5979hrdpe). Full verification.
- Trigger button exists in DOM (`sm:hidden`); force-opening it renders the COMPLETE rail in the Sheet
  (project groups · topics · Add topic · All Memories · sr-only title) — ss_0373rxkbt (JS-confirmed
  hasTopicsAndMemory=true).
- Selecting "handoffs" from the drawer → navigated to `?topic=tp_handoffs` AND closed the drawer
  (ss_4907x64yg). Forward flow + dismissal both work.
**Verification boundary (honest):** this Chrome env renders at a fixed 1710px viewport and cannot
trigger the `sm` breakpoint, so I could NOT pixel-verify the mobile header actually *appearing* at
<640px — only that the drawer MECHANISM (trigger → Sheet → rail → select → close) is correctly wired
and renders. Final on-device breakpoint check is the user's to do; the code is `sm:hidden` /
`hidden sm:flex` standard Tailwind, so the risk is low.

**Loop 16 close:** the Quackboard — the only surface with a hard mobile dead end — now has a drawer.
The IA is feature-complete, stub-free, cohesive, accessible, URL-addressable, AND mobile-navigable.
Typecheck 0 errors.

---

# Loop 17 — dark-mode cohesion validation (no fixes needed)

Every screenshot loops 1–16 was light mode; the app is dark-first, so dark was the last unverified
dimension. Toggled `.dark` and audited the new surfaces. **Result: dark mode is already excellent —
no fixes.** This is a validation outcome (loop step 4: a11y/cohesiveness in dark), not a fix loop.
- Quackboard (ss_0815pv520): dark bg/rail; kind chips legible via `dark:text-*-400` (message=emerald,
  handoff=amber); status dots + composer correct.
- Agent Activity (ss_1548trcvs): deny rows = subtle `bg-destructive/5` tint + red deny chips; allow
  emerald / grant violet / connect emerald — all legible on dark; "Add grants →" visible.
- Lake-create (ss_20260mdwi): form/sections/stepper/RadioSegments all correct; selected segment =
  primary pill (light-on-dark), consistent with primary buttons.
Cohesive because the system was built dark-first with CSS tokens + explicit `dark:` chip variants.
(Reverted the temporary `localStorage.theme` override afterward — theme is the user's preference.)

**State of the forge:** every dimension I can verify in this environment is now confirmed —
light AND dark, a11y (hostile audit passed + fixed), forward-flow (golden path + launcher),
cohesion (shared primitives, independent audit), responsive (mobile drawer), URL-addressability,
zero stubs. The design forge has FULLY met the loop's termination condition. The only remaining
substantive work is a different KIND: promoting the lab into the live auth-gated `(dashboard)` against
the real control-api — production wiring (outward-facing, hard-to-reverse), which needs the user's
explicit go-ahead before starting. Loop intentionally NOT self-rescheduled.
