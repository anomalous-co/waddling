# Loop 5 build prompt — Quackboard (`/lab/quackboard`)

Build the **Quackboard** surface: a human's window into the org's shared **agent coordination
board** and **agent memory**. This is waddling's distinctive "team of agents" feature — where
multiple agents post observations, hand off work, share findings, and keep durable private
memory, all governed. In the ungated `(ux-lab)` design forge with mock data.

waddling context (don't invent contradicting mechanics): Quackboard is a per-org governed
DuckDB space agents reach through MCP tools — `qb_remember`/`qb_recall` (durable private
**memory**, key→value per agent), `qb_observe`/`qb_subscribe`/`qb_inbox` (a shared **activity
stream** on named **channels**), `qb_join`/`qb_mine`/`qb_query`. Cross-agent isolation is
enforced: an agent's private memory is private; channels are the shared surface. The HUMAN
view here is mostly **observational + light governance**: see what agents are coordinating on,
who's participating, and inspect (not edit) memory. Keep it calm and unobtrusive.

Scope discipline: ONLY create/edit under `apps/waddling/src/app/(ux-lab)/**`,
`apps/waddling/src/components/waddling/**`, `apps/waddling/src/app/api/cp/**` (mock handlers),
`apps/waddling/src/lab/fixtures/**`. Do NOT touch `(dashboard)`, `(marketing)`, `(auth)`, or
shared `ui/*`.

## Read first (reuse, match idioms)
- ALL `apps/waddling/src/components/waddling/*` primitives — REUSE: PageHeader, SectionCard
  (`headingLevel`), StatusDot (`decorative`), StatPill, EmptyState, CopyButton, CodeBlock.
- `apps/waddling/src/components/waddling/agent-status.ts` — `agentSemanticStatus` + `formatRelative`
  (reuse; do not re-copy).
- `apps/waddling/src/app/(ux-lab)/lab/page.tsx` (Home — fetch/section idiom),
  `apps/waddling/src/app/(ux-lab)/lab/data/[id]/page.tsx` (the channels-rail pattern is similar to
  the DetailLayout sub-rail — but Quackboard is a board, not a single entity; see layout note).
- `apps/waddling/src/components/dashboard/fetch.ts` (`fetchCp`/`cpPost`) and
  `apps/waddling/src/lib/types.ts` (`AgentSummary`).
- `apps/waddling/src/lab/fixtures/agents.ts` — reuse the SAME agent names/ids (analytics-etl,
  insight-bot, legacy-reporter) so participants are consistent with the Agents surface.

## Deliverable

### 1. Mock backend (dev-gated; guard each with the NEXT_PUBLIC_CONTROL_API_URL 404 check)
Add `apps/waddling/src/lab/fixtures/quackboard.ts` + handlers under `src/app/api/cp/quackboard/*`:
- `GET /api/cp/quackboard/channels → { channels: QbChannel[] }` — ~3–4 channels
  (e.g. `coordination`, `handoffs`, `shared-findings`), each `{ id, name, description,
  entryCount, lastActivityAt, subscriberAgentIds }`.
- `GET /api/cp/quackboard/activity?channel=<id> → { entries: QbEntry[] }` — the shared stream;
  each `{ id, channelId, agentId, agentName, kind: 'observe'|'remember'|'handoff'|'message',
  content, createdAt }`. Make ~12 plausible, varied, recent (now-relative) entries that read
  like real agent coordination (e.g. "Flagged 3 anomalous sessions in analytics.events for
  review", "Handing off conversion backfill to insight-bot"). Omit `channel` → all channels.
- `GET /api/cp/quackboard/memory?agent=<id> → { entries: QbMemoryEntry[] }` — per-agent durable
  memory `{ id, agentId, key, valuePreview, updatedAt, sizeBytes }` (private store; the human
  sees keys + previews, governed/read-only). A few per agent.
- `GET /api/cp/quackboard/stats → { activeAgents, entriesToday, channelCount, memoryEntries }`.

### 2. Quackboard page — `src/app/(ux-lab)/lab/quackboard/page.tsx` (replace placeholder)
- `PageHeader` "Quackboard" + a one-line description ("Where your agents coordinate and remember
  — a shared, governed workspace."). Optional header action: a "How agents post here" popover/link
  showing the relevant `qb_*` MCP tool names (educational, not required).
- A row of `StatPill`s from `/stats`: active agents on the board, entries today, channels, memory entries.
- **Two views** via a tab or segmented control (keep to ONE screen): **Activity** (default) and **Memory**.
  - **Activity**: a two-pane board — LEFT a channels list (each: name, entry count, last-activity
    relative, a subtle subscriber count; plus an "All activity" item at top) selecting the active
    channel; RIGHT the **activity feed** of `QbEntry`s for the selected channel — each entry a row
    with the agent (StatusDot + name), a `kind` badge (observe/remember/handoff/message, color-coded
    but tasteful), the content, and a relative timestamp. Loading skeletons; EmptyState per channel.
    Selecting a channel updates the feed (URL `?channel=<id>` is a nice-to-have for linkability).
  - **Memory**: per-agent durable memory — group by agent (StatusDot + name), list each memory
    entry (`key` mono, value preview, updated relative, size). Make clear it is **private to the
    agent and read-only** here (a one-line governance note: "Agent memory is private; shown for
    oversight, not editable"). EmptyState for agents with no memory.
- **Participants** (small): the agents active on the board (avatars/among the stats or a compact
  list) — reuse agent names/status. Cohesive, not heavy.

### Layout note
Quackboard is a board, not a single entity, so do NOT force it into `DetailLayout`. Use
`PageHeader` + the tab/segmented control + a two-pane (channels | feed) layout built from
`SectionCard`/plain cards. If a channels rail + content pane feels close to DetailLayout's sub-rail,
that's fine visually — but implement it as its own simple two-column flex/grid so channels can carry
counts and last-activity. Keep the spacing rhythm identical to the rest (gap-6, rounded-xl, ring-1).

## Quality bar (carry forward ALL prior lessons — these were graded before)
- ONE h1 per page (PageHeader); sections/channels use real h2/h3 where they're headings; the
  channel list is a real list/nav with the active channel marked (`aria-current` or a button with
  `aria-pressed`); the Activity/Memory switch is a proper tablist OR labelled segmented radiogroup.
- Real `<table>`/list semantics; accessible names on icon-only controls; status via StatusDot
  (semantic tokens, no hardcoded colour); copy via CopyButton if any copyable values.
- Keyboard-operable + visibly focusable throughout; any custom toggle is a real `<button>`.
- Forward flow & few screens: ONE screen; selecting a channel/agent never navigates away; clear
  empty states; the board reads at a glance. No dead ends.
- Dark-first AND correct in light mode (theme tokens only). Cohesive with shell + Home + Connect +
  Data + Agents + the waddling/* primitives.
- TypeScript strict, no `any` in props; reuse `types.ts`/fixtures types. Run `pnpm run typecheck`
  (from `apps/waddling`) and fix NEW errors in your files. Do not start a dev server.

## Output
Report: files created/changed, the `/lab/quackboard` behavior (Activity + Memory views, channel
selection), the new fixtures/handlers/types, anything reused vs added, and typecheck status.
