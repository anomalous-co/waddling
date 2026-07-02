# Loop 2 build prompt — Connect-an-agent flow (`/lab/connect`)

You are building the **core fast-to-value funnel** for waddling: the flow that takes a user
from "I want to connect an AI agent" to "my agent is connected and scoped to my data" in as
few screens as possible. This is the single most important conversion path in the product.
The Home launchpad's primary CTAs already point here (`/lab/connect`) — that route 404s
today; your job is to build it.

This is in the ungated `(ux-lab)` design forge with mock data. Do NOT touch `(dashboard)`,
`(marketing)`, `(auth)`. Build under `apps/waddling/src/app/(ux-lab)/lab/connect/` and the
shared `apps/waddling/src/components/waddling/*` library + dev-gated `apps/waddling/src/app/api/cp/*`
mock handlers + `apps/waddling/src/lab/fixtures/*`.

## Read first (ground truth — do not invent contracts)

- `apps/waddling/src/components/dashboard/agent/connect-dialog.tsx` — the AUTHORITATIVE
  connection snippets. Mirror them exactly (do not import). Specifically:
  - **MCP config JSON**: `{ mcpServers: { waddling: { command: 'npx', args: ['-y','@waddling/mcp@latest'], env: { WADDLING_URL: 'https://api.getwaddling.com', WADDLING_API_KEY: <key> } } } }`
  - **birdshot extension SQL**: `SET allow_unsigned_extensions = true;` / `INSTALL birdshot FROM 'https://ext.getwaddling.com';` / `LOAD birdshot;`
  - **DuckDB attach**: `ATTACH 'quack:<your-gateway-endpoint>?token=<key>' AS lake;`
  - Keys are **reveal-once** secrets of the form `sk_agent_…` — shown once at creation, never retrievable again.
- `apps/waddling/src/components/dashboard/fetch.ts` — `fetchCp` + envelopes. Note:
  `POST /api/cp/agents → { agent: AgentRow; key?: string }` (key = reveal-once),
  `GET /api/cp/datalakes → { datalakes: DatalakeSummary[] }`,
  `GET /api/cp/datalakes/:id → { datalake: DatalakeDetail }`,
  `POST /api/cp/acl → { rule: AclRuleRow }` (402 on free = upgrade_required).
- `apps/waddling/src/lib/types.ts` — reuse `AgentRow`, `AgentSummary`, `DatalakeSummary`,
  `DatalakeDetail`, `AclRuleRow`. If `DatalakeDetail` lacks a catalog/table list, extend the
  FIXTURE shape locally (document it) so the scope step has tables to grant.
- `apps/waddling/src/components/waddling/*` — REUSE PageHeader, SectionCard (`headingLevel`),
  StatusDot (`decorative`, semantic colours), EmptyState, StatPill, GoldenPathCard. Match
  their idioms. Read them so the new screen feels like one library.

## The flow — a single-page **stepper wizard** (fewest screens)

One route, one screen, three steps with a visible stepper (do NOT spread across separate
pages — keep the user in one focused flow). Steps:

### Step 1 — Identify & target
- Agent **name** (text input, required) + optional description.
- **Data lake** picker (radio cards or a Select) populated from `GET /api/cp/datalakes`.
  Show lake name + status (StatusDot); a provisioning lake is selectable but flagged.
- Optional **mode** (e.g. read-only vs read-write) as a segmented control — default read-only.
- Primary button "Create agent" → `POST /api/cp/agents` → returns `{ agent, key }`.
  Advance to step 2 on success. Disable while pending; surface errors inline (toast on failure).

### Step 2 — Install & connect (the reveal-once moment)
- A **KeyReveal** for the `sk_agent_…` key: monospace, a copy button, and a clear, calm
  warning that it is shown **once** ("Copy it now — you won't see it again"). This is the
  highest-stakes UI moment; make the warning obvious but not alarming.
- A **CodeBlock** with **tabs** (use shadcn `tabs`) for the two connection methods:
  - **MCP** tab: the MCP config JSON, with the real key substituted in.
  - **DuckDB** tab: the birdshot INSTALL/LOAD SQL + the `ATTACH 'quack:…?token=<key>'` line.
  Each block has a copy button (aria-label "Copy …", swaps to a check for ~2s, and announces
  "Copied" via an `aria-live="polite"` region — not just a visual swap).
- Helper copy: one line on what happens next ("Run this in your agent's DuckDB to connect").
- Primary button "Next: scope access" → step 3. Secondary "I'll do this later" → finish to
  the agent (still created).

### Step 3 — Scope access (grant table-level ACLs)
- Show the chosen lake's **catalog** (schemas → tables) from the lake detail fixture. Let the
  user select which tables the agent may read (and write, if mode allows) via checkboxes /
  a compact table. Default to nothing selected (least privilege) with a clear hint.
- "Grant access" → one `POST /api/cp/acl` per selected table (or a batch) → on success,
  advance to the done state.
- Allow "Skip for now" (agent created but unscoped — explain it can't query until scoped).

### Done state
- A success panel: "✅ <agent> is connected to <lake>" + what it can now reach (the granted
  tables) + two CTAs: **"View agent"** (→ `/lab/agents` for now) and **"Connect another"**
  (resets the wizard). Reinforce the value: the agent can now run governed queries.

## New library primitives to EXTRACT (this is the deliverable as much as the flow)
Add these to `src/components/waddling/*`, clean + documented, reusable by future flows:
- `Stepper` — horizontal step indicator (current/complete/upcoming states; accessible:
  `aria-current="step"`, numbered, with labels; works as a progress display, not a tablist).
- `CopyButton` — icon button that copies text, swaps Copy→Check ~2s, has an `aria-label`,
  and pushes "Copied" into an `aria-live="polite"` region.
- `CodeBlock` — monospace surface for snippets with an embedded `CopyButton`; optional
  filename/label header. (The tabbed MCP/DuckDB switch can wrap two CodeBlocks in shadcn tabs.)
- `KeyReveal` — a reveal-once secret display: monospace value, `CopyButton`, and a warning
  slot. Treat the value as sensitive (no logging; selectable; `spellCheck={false}`).

## Mock backend to add (dev-gated; guard each with the NEXT_PUBLIC_CONTROL_API_URL 404 check)
- `POST /api/cp/agents` → `{ agent, key }` where `key` is a believable `sk_agent_…` string
  and `agent` is a fresh `AgentRow` echoing the posted name/mode.
- `GET /api/cp/datalakes/:id` → `{ datalake }` including a small **catalog** (2 schemas,
  ~5 tables, with column counts) so step 3 has real structure to scope.
- `POST /api/cp/acl` → `{ rule }` echoing the granted table.
- **Fix fixture realism**: make `agents` `lastSeenAt` **now-relative** (compute at request
  time in the handler: one ~2 min ago → reads Active, one ~50 min ago → Idle, one suspended)
  so the Home launchpad shows a realistic mix (1 Active matching its live session) instead of
  all-Idle. Likewise keep sessions/usage plausible.

## Quality bar (carry forward Loop 1's lessons)
- Dark-first; correct in light mode; theme tokens only (no hardcoded colours).
- A11y is graded: real heading outline (the page has ONE h1 via PageHeader; steps/sections
  use h2/h3); every icon-only control has an accessible name; copy actions announce via
  `aria-live`; the stepper exposes current step; visible focus; keyboard-operable throughout;
  inputs have associated `<label>`s.
- Forward flow: every step has a clear primary action and a clear escape; no dead ends; the
  done state pushes to a meaningful next surface. Minimize screens — one route, inline steps.
- TypeScript strict, no `any` in props. Reuse `types.ts`. Run `pnpm run typecheck` (from
  `apps/waddling`) and fix new errors in your files. Do not start a dev server.

## Output
Report: files created/changed, the `/lab/connect` step-by-step behavior, new primitives and
their props, any types you extended/guessed, and typecheck status.
