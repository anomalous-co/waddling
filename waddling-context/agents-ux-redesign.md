# Agents surface — UX flow report & refactor plan

Status: proposal · Scope: `/agents`, `/agents/[id]`, and the agent-adjacent nav
(`/connected`, `/sessions`, `/acl`). Goal: one beautiful, composable home for
seeing and managing agents — and the launch pad for swarms + memories.

---

## Part 1 — UX flow report

### The core diagnosis

The "agent" concept is **shattered across four top-level pages plus per-agent
duplication, with three different ways to edit access**. Nothing tells the user
which surface is authoritative.

```
Agent-related surfaces today
├─ /agents            roster + create (only place to create)
├─ /agents/[id]       info + Access card + Keys + Sessions  ← duplicates ↓↓
├─ /connected         OAuth-delegated agents ("delegations")
├─ /sessions          ALL sessions (agent detail re-renders a slice)
└─ /acl               ALL access rules (agent detail re-renders a slice)

Edit-access paths (3, inconsistent):
  1. create dialog  → AccessEditor  (sm:max-w-lg, cramped)
  2. list … menu    → dialog → AgentAccess (sm:max-w-2xl)
  3. detail page    → embedded AgentAccess card (half-width grid cell)
```

No live sync between these. Edit access at `/acl` and the detail page is stale;
edit in the list dialog and the detail page is a different frame at a different
width. The user cannot tell where the source of truth is.

### Jobs-to-be-done (who comes here, and why)

| Job | Today's friction |
|---|---|
| **Provision** an agent + scope it | Access editor cramped in a 512px modal; key revealed over a blank list with no "now go grant access" path; `mode` not settable at creation |
| **Audit** what an agent can reach | 3 entry points; the "read" path is mislabeled "Edit access"; sessions show a truncated lake **UUID**, not a name |
| **Restrict/expand** scope | 3 paths of inconsistent width; saving doesn't refresh the rest of the detail page |
| **Pause** a misbehaving agent | **No suspend** — only irreversible delete; not reachable from the list |
| **Kill** a runaway session | Buried at page bottom; `⚡` icon reads as "power" not "terminate"; **no confirmation** |
| **Rotate** a leaked key | **Impossible** — keys are read-only; "revoke the whole agent" is the only path |
| **Triage** a failure | No agent-scoped audit link; sessions table shows no query / denial reason |
| **Fleet check** ("which are stale?") | **No search, sort, or filter**; no active-session count on rows |
| **Future: swarms / memories** | Detail page is a flat card grid with no room to grow without becoming a junk drawer |

### Severity-ranked problems

1. **No key rotation / per-key revoke** — compliance blocker; a leak forces full re-provisioning.
2. **No suspend — only irreversible delete** — wrong tool for incident response; destroys config + grants.
3. **Three disconnected access-edit paths** — no canonical surface; inconsistent widths erode trust that saves took.
4. **Sessions show a UUID, not a lake name** — every triage needs a separate lookup.
5. **No agent-scoped audit link** — the "single pane of glass" omits the forensic trail.
6. **Kill-session has no confirmation** — a misclick drops a live production connection.
7. **No mode at creation; no list search/sort/filter; no active-session signal** — fleet management is blind.
8. **Flat card grid can't absorb swarms + memories** — the stated roadmap has nowhere to land.

---

## Part 2 — Refactor plan

Design law for this surface: **one place to do each thing.** Brevity over
options. Every capability of an agent lives behind one section on one page.

### A. Detail page = the single home for one agent (sectioned)

Replace the flat card grid with a **header + left section sub-rail** (see Part 4
for the layout decision). The header is identity + the lifecycle actions; the
sub-rail switches between the capability sections.

```
┌─ analytics-bot   ●active  delegated   last seen 4m ago ─────────┐
│                                   [ Suspend ]  [ ⋯ Delete ]     │
├─ Overview · Access · Keys · Sessions(3) · Memory · Activity ────┤
│                                                                 │
│   <active section renders here>                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Overview** — identity, owner, mode, default role; swarm-membership chips that link to the agent's swarm view (see G).
- **Access** — the **only** place to edit ACL. `AgentAccess` at full width. Two
  sections: **Direct grants** (`acl_rule`, editable) and **Delegated scope** (the
  principal's delegations ∩ your grants, from the `/connected` fold — see F).
- **Keys** — list **+ per-key revoke + issue-new-key** (fixes the #1 problem).
- **Sessions** — this agent's sessions only; lake **names**, kill **with confirm**, columns for last query / denial reason; links to `/sessions` for the org-wide view.
- **Memory** *(roadmap)* — quackboard `agent_memory` + inbox preview.
- **Activity** *(roadmap)* — audit slice filtered to this agent + usage sparklines.

Tabs carry **count badges** and **first-class empty states** so a capability is
visibly present even before it has data (no "where did Memory go?").

### B. Composability primitive — the `AgentSection` contract

Every tab is a self-contained module so new capabilities are drop-in:

```ts
interface AgentSection {
  id: string;                              // tab key / url anchor
  label: string;
  useBadge?: () => number | null;          // hook into the section's OWN fetched state
  Component: React.FC<{ agentId: string }>;      // fetches its OWN data
}
const SECTIONS: AgentSection[] = [overview, access, keys, sessions /*, memory, activity */];
```

The badge derives from the section's own state (not from `AgentSummary`, which
doesn't carry these counts) — consistent with "each section fetches its own data."

Rules: each section owns its fetch + loading + empty state; the prop contract is
`{ agentId }` and nothing more; the shell renders the registry. Adding Memory =
push one entry, zero shell/routing changes. `AgentAccess` already follows this;
the inlined **Keys** and **Sessions** cards must be **extracted** to match —
this extraction is the prerequisite for everything that grows later.

### C. Collapse the three access-edit paths to one

- **Remove** the list-row "Edit access" dropdown→dialog.
- **Remove** the full `AccessEditor` from the create dialog. Create captures
  **identity only** (name, description, role, **mode**) → reveal key → route
  straight to the new agent's **Access tab** with a "grant access" nudge.
- Result: ACL is edited in exactly **one** surface — the Access tab.
  *(Tradeoff: provisioning is now two steps instead of one. Worth it — it kills
  the cramped-modal misconfiguration and the "which path is real?" confusion.)*

### D. De-duplicate — index vs. slice (no mirrored UIs)

| Concern | Canonical (org-wide) | Per-agent |
|---|---|---|
| Access | `/acl` = cross-agent **index** ("who can touch table X") + links to each agent | Access **tab** = the edit surface (direct grants) |
| Sessions | `/sessions` = org-wide **monitor** | Sessions **tab** = filtered slice + "view all" link |
| Delegations | `/agents ▸ Delegations` org-tab (admin/owner) = every delegated scope, cross-principal | Access **tab ▸ Delegated scope** = this principal's lent scopes |

Same data type, different intent (survey vs. act). Add the missing cross-links in
both directions. No component is duplicated — both render the shared section.

### E. `/agents` is itself org-level tabbed (Roster + Delegations)

The `/agents` index gets its **own** tab strip — distinct from the per-principal
tabs on `/agents/[id]`. Two tab levels, no confusion:

```
/agents              ▸  Roster · Swarms · Delegations(admin)   ← ORG-level tabs
/agents/[id]         ▸  Overview · Access · Keys · …           ← PRINCIPAL-level tabs
```

- **Roster** (default) — every principal in one table (see F, the `/connected`
  fold). **Search by name**, **filter by type/status** (All · Autonomous ·
  Connected), **sort by last-seen**, **active-session count** per row. Row →
  detail. The `⋯` menu carries only lifecycle actions: **Suspend / Resume**,
  **Delete**. (Access editing is gone from here by design — see C.)
- **Delegations** — the org-wide "every delegated scope across **all**
  principals" view (the old `/connected` table, cross-principal). This is an
  **admin/owner-only** tab: gated on the active member's org role
  (`owner` | `admin`) from the Better Auth organization plugin. Members never see
  it. **Gate on both ends** — hide the tab in the UI *and* authorize the
  `/api/cp/delegations` list on the server for `owner`/`admin` only (hiding a tab
  is not access control).

### F. Fold `/connected` into `/agents`

`/connected` is not a separate species — the data model already says so:
`AgentSummary.mode` is `'autonomous' | 'delegated'`, with `onBehalfOf` naming the
delegating human. "Connected" = an agent with `mode: delegated`. And a delegation
row attaches a capability scope to either an `agentId` (an sk_ agent you already
see) or a `clientId` (an OAuth client like Claude). So:

- The **Roster** absorbs OAuth clients as `Connected` rows alongside `Autonomous`
  sk_ agents, behind the type filter. One roster, every principal.
- Each principal — sk_ or OAuth — gets the **same detail page**. The **Access
  tab** grows a second section: **Delegated scope** (your grants ∩ what's lent),
  sitting under **Direct grants** (`acl_rule`). Two access mechanisms, one
  surface, per principal.
- The org-wide "all delegations" list moves to the **Delegations** org-tab (E,
  admin/owner-only). The `/connected` nav entry is retired.

**Feasibility split — be honest about effort:**

| Piece | Verdict |
|---|---|
| `agentId` delegations → render in that agent's Access tab "Delegated scope" | **UI-only** — the principal already exists in the roster |
| Org-wide Delegations tab (admin-gated) | **UI-only** for the view; **needs server authz** on `/api/cp/delegations` to enforce owner/admin |
| OAuth (`clientId`) clients appear as Roster rows + get a detail page | **needs API** — OAuth clients aren't `agent` rows today; `GET /agents` must UNION distinct clientIds as synthetic principals, *or* consent must mint a `mode:delegated` agent row |

> Until the OAuth-client piece (needs API) lands, **keep the `/connected` nav
> entry** so OAuth clients stay visible — deleting it early would hide them.
> Retire it only once the Roster can render Connected rows.

### F. Lifecycle: add **Suspend** (reversible) distinct from Delete

`active ⇄ suspended` is the incident-response control; `delete` stays the
irreversible terminal action with its confirm. Relabel "Revoke agent" → "Delete
agent" (it deletes the principal, not a credential). Both reachable from the list
row and the detail header — this is the one deliberate exception to "one place
per thing": lifecycle is a fast triage action, valid from the roster *and* the
record, whereas the **full ACL editor stays single-home** on the Access tab.

> Backend is **already there**: `PATCH /api/cp/agents/:id` accepts `status`, and
> the enum is `active | suspended | revoked`. Suspend/Resume is **UI-only**.

### G. Swarms = a category of agents, inside `/agents` (not a separate nav item)

A swarm is just a **grouping of agents** — so it lives **inside** the Agents
surface, as the **Swarms** org-tab (E), not as its own Platform nav entry. The
Swarms tab lists the groups; each opens a swarm view (`/agents/swarms/[id]`)
showing its member agents and (later) shared access/memory. The Roster can also
**filter/group by swarm** so the two tabs are the same population seen two ways
(flat list vs. grouped). An individual agent's detail **Overview** carries
swarm-membership chips linking into that swarm view.

Memory, by contrast, is **per-agent** and stays a detail tab — there is no
org-level "browse all memory" job (purge/audit belongs in Activity/Audit filtered
by agent).

Net effect: **everything agent-shaped collapses into one nav item.** `/connected`
and the would-be `/swarms` both fold into `/agents` as org-tabs — the nav gets
*simpler*, not wider.

```
Now:    Overview · Data Lakes · Agents · Connected · Access · …
Target: Overview · Data Lakes · Agents · Access · …
                                   └ org-tabs: Roster · Swarms · Delegations(admin)
                                     (/connected folded in — F; swarms are just a category)
```

### Frontend vs. backend feasibility (verified against `control-api`)

| Fix | Verdict |
|---|---|
| Tabbed shell + `AgentSection` extraction | **UI-only** |
| Remove 2 redundant access-edit paths | **UI-only** |
| Suspend / Resume | **UI-only** — `PATCH /:id` already takes `status` |
| Agent-scoped audit tab/link | **UI-only** — `/audit?agentId=` already exists |
| Lake **names** in sessions, kill-confirm | **UI-only** — detail fetch already returns lakes |
| List search / filter / sort | **UI-only** — filter client-side over existing list |
| `agentId` delegations → Access tab "Delegated scope" | **UI-only** — principal already in the roster |
| Org-wide **Delegations** org-tab (admin/owner) | **UI-only** view; **needs server authz** on `/api/cp/delegations` (owner/admin) |
| **Per-key revoke + issue-new-key** | **Needs backend + schema** — keys are 1:1 with the agent today; no per-key routes. This is the real lift, not a UI change. |
| **Active-session count per row** | **Needs API** — `GET /agents` returns no count; add a subquery + field |
| OAuth (`clientId`) clients as Roster rows + detail | **Needs API** — not `agent` rows today; UNION into `GET /agents` or mint on consent |
| `mode` at creation | **Needs API** — `POST /agents` body doesn't take `mode` yet |

> The two highest-severity problems split: **Suspend** is free (ship now);
> **key rotation** is a genuine backend+schema project (1:1 → 1:N agent\:key).

### Phasing

1. **Foundation — all UI-only:** org-level tabs on `/agents` (Roster +
   Delegations); tabbed detail shell + section registry; extract Keys + Sessions
   into `AgentSection` modules; Access tab "Delegated scope" section (agentId
   delegations); lake-name display; kill-session confirm; agent-scoped audit tab;
   **Suspend/Resume**; remove the 2 redundant access-edit paths; list
   search/filter/sort. Lands the whole "single-way, composable, beautiful"
   redesign with **zero backend work**. (`/connected` nav entry stays for now.)
2. **Backend-gated features:** owner/admin authz on `/api/cp/delegations` (lights
   up the Delegations tab safely); per-key revoke + issue (needs 1:1→1:N schema +
   routes); active-session count on the list; `mode` at creation.
3. **Complete the fold + de-dup:** OAuth clients as Roster `Connected` rows
   (`GET /agents` UNION / consent mints agent) → **retire `/connected`**;
   cross-links `/acl`↔Access tab and `/sessions`↔Sessions tab; trim top-level
   pages to pure index/monitor.
4. **Growth:** **Swarms** org-tab + swarm view + membership chips (a category of
   agents, inside `/agents`); Memory tab (quackboard); Activity tab.

---

## Part 3 — The UX story (one spine, one path per job)

### The one-line mental model

> **Agents is where you mint a machine identity, give it exactly the data it
> needs, watch what it does, and group it with others.**

Everything on this surface is a beat in one **lifecycle arc**. The UI's job is to
make the *next* beat the obvious one — never to offer two doors to the same beat.

### The lifecycle arc (the spine)

```
   CREATE ──▶ GRANT ──▶ RUN ──▶ OBSERVE ──▶ ADJUST ──▶ RETIRE
   identity   access    agent    sessions    expand/     suspend
   + key      (or it's  opens    activity    restrict    (reversible)
              inert)    sessions  memory     access      → delete
     │          │         │         │           │          │
   Roster     Access    (agent    Sessions/   Access     ⋯ menu /
   [+ New]     tab       runtime)  Activity    tab        header
              ▲ ONE access surface ─────────────┘
```

Read it top to bottom and the product makes sense: an agent with no access is
**inert** — so CREATE must pour straight into GRANT, and a created-but-ungranted
agent must *look* unfinished until it's scoped.

### The three states a user must always be able to read at a glance

```
   ◌ Needs access   created, has a key, but 0 grants → every query denied (derived)
   ● Active         granted; can open sessions and run
   ⏸ Suspended      frozen; sessions killed; reversible
   ⨯ (deleted)      terminal; gone from the roster
```

`Needs access` is **derived** (status `active` + zero grants), shown as an amber
chip on the Roster row and a banner on the detail page. It is the single most
important signal on the surface — it's what turns "I made an agent and nothing
works" into a guided next step.

### Navigation model — you are never more than one hop from anything

```
Sidebar ▸ Agents
   │
   ├─ Roster        (default)  ── row ─▶  /agents/[id]  ◀── breadcrumb back
   ├─ Swarms                   ── card ─▶ /agents/swarms/[id]
   └─ Delegations  (admin)

/agents/[id]   header: name · state · [Connect] [Suspend] [⋯ Delete]
   └─ left sub-rail: Overview · Access · Keys · Sessions · Memory · Activity
        every per-agent answer lives behind exactly one of these sections
```

Breadcrumb is always `Agents › <name> › <tab>`. The detail page is the **only**
place that answers "what about *this* agent"; the org-tabs are the only place
that answer "across *all* agents."

### Canonical paths — one way in, and the doors we deliberately remove

| Job | THE path | Removed alt-doors (so there's no second way) |
|---|---|---|
| Create an agent | Roster → **[+ New]** → name/role/mode → key (once) → **lands on Access tab** | create dialog no longer embeds the ACL editor |
| Give/expand/restrict access | detail → **Access tab** | ✘ list row "Edit access"; ✘ create-dialog editor |
| See what it's doing now | detail → **Sessions tab** | (org-wide view is `/sessions`, reached via "view all") |
| Find out why it failed | detail → **Activity tab** (audit slice) | ✘ hunting in top-level `/audit` |
| Rotate a leaked key | detail → **Keys tab** | ✘ "delete the whole agent to rotate" |
| Pause a misbehaving agent | Roster row **⋯ → Suspend** (or detail header) | — (deliberate dual-entry: fast triage) |
| Delete permanently | Roster row ⋯ / detail header → **Delete** (confirm) | — |
| Audit "who can touch table X" | **`/acl`** index → click agent → its Access tab | — (index vs. edit, not duplication) |
| Review all delegated scopes | Roster → **Delegations tab** (admin) | ✘ separate `/connected` page |
| Group agents | Roster → **Swarms tab** | ✘ separate `/swarms` nav item |

The rule that makes it a *story* and not a menu: **read = org-tabs; act = detail
tabs.** You survey across agents on `/agents`; you change one agent inside its
record. Access has one editor, lifecycle has one fast button. Nothing else forks.

### First-run story (empty states carry the arc)

```
0 agents     Roster empty → "Create your first agent" ─────────▶ CREATE
0 grants     new agent → Access tab empty → "Grant access" ◀ amber "Needs access"
0 sessions   Sessions tab empty → "This agent hasn't connected yet
             — install the extension"  (links the connect snippet)
```

Each empty state names the *next beat in the arc*, so a new user is walked
CREATE → GRANT → RUN without ever guessing.

### Hero flow walkthrough — create to running, no dead ends

```
1. /agents (Roster)            2. New agent dialog          3. Key — shown once
   ┌─────────────────────┐        ┌────────────────────┐      ┌──────────────────┐
   │ Agents              │        │ Name  [analyst   ] │      │ ⚠ Copy it now    │
   │ Roster Swarms Deleg │        │ Role  [reader  ▾] │      │ sk_agent_… [copy]│
   │ ─────────────────── │  [+]   │ Mode  [auto    ▾] │  ▶   │ [ Done ]         │
   │ (empty)             │ ─────▶ │      [ Create ]    │ ───▶ └────────┬─────────┘
   │ Create first agent →│        └────────────────────┘               │
   └─────────────────────┘                                             ▼
                                                          4. /agents/[id] ▸ Access
                                                             ┌──────────────────────┐
                                                             │ analyst  ◌ Needs access│
                                                             │ Overview ·[Access]· …  │
                                                             │ No grants yet.         │
                                                             │ [ Grant access ]  ◀────┼ the arc
                                                             └──────────────────────┘   continues
```

Create never ends on a blank list; it ends **inside the next required step**, with
the `Needs access` chip making the gap impossible to miss.

---

## Part 4 — Visual design & layout

### Grounding (use the system, don't reinvent it)

The dashboard already has a strong identity — we elevate it, we don't replace it.

- **Theme:** dark-first, cool **zinc** on near-black; light mode is warm **stone**
  "paper" (inverted ramps). Authored in `globals.css`; never hardcode hex.
- **Radius:** **5px** everywhere (`--radius-*`). Sharp, not pillowy.
- **Primary button:** neutral near-black (`--primary`), not blue.
- **Accent:** **blue** is the *single* interactive accent — selected tab, links,
  focus ring. Nothing else is blue.
- **Status color is semantic and centralized** in `components/dashboard/status.tsx`
  (`active`=green, `suspended`=amber, `revoked`=red, `delegated/autonomous`=blue,
  `asleep`=slate). **All color decisions stay in that file.**
- **Type:** Geist sans for everything; `font-mono` for machine values (ids, keys,
  `lake.schema.table`, patterns); `tabular-nums` for counts/dates. Coiny (brand
  display) is **not** used in the dashboard.
- **Surfaces:** shadcn `Card` = `ring-1 ring-foreground/10`, 16px spacing
  (`sm`=12px). `Tabs` component already exists — reuse it.

### Design principles for this surface

1. **State is the hero.** The single loudest non-text element on any row or header
   is the agent's lifecycle state. Everything else is quiet chrome.
2. **Density with air.** Linear-grade scannability: compact rows, mono for
   machine values, but generous vertical rhythm between sections.
3. **Quiet chrome, loud content.** Tabs/toolbars/headers sit in muted zinc; the
   data carries the contrast.
4. **One composable `Section` frame** wraps every per-agent tab so a new
   capability looks native the day it ships (the visual half of `AgentSection`).

### The state system (the signature element)

Two distinct devices — keep them visually separate so they never blur:

```
LIFECYCLE STATUS  (the StatusBadge/dot, from status.tsx — one per principal)
   ● active        green dot + "Active"
   ⏸ suspended     amber pill
   ⨯ revoked       red pill

CONFIGURATION FLAG  (NEW — a separate outline chip, NOT a status)
   ⚠ No access     amber-OUTLINE chip + triangle icon, sits BESIDE the status
```

`No access` is derived (`active` + 0 grants), so it must not collide with the
solid-amber `suspended` pill — it's an **outline** chip with an icon. On the
detail page it escalates to a full-width amber banner with a `Grant access` CTA.
This pairing (`● Active` + `⚠ No access`) is the visual heart of the create→grant
funnel. New tone/flag lands in `status.tsx`, nowhere else.

### Layout — Roster (default org-tab)

```
```
┌────────────────────────────────────────────────────────────────────────┐
│ Agents                                                  [ + New agent ]  │  h1 2xl semibold
│ Machine principals with governed access to your data lakes.             │  muted sm
│                                                                          │
│ ┌ Roster ─┐ Swarms   Delegations          ← underline tabs, active=blue  │
│ ──────────────────────────────────────────────────────────────────────  │
│ [⌕ search]  All ▾  Status ▾   Sort: Last seen ▾   [▤ table|▦ cards] 12   │  toolbar; view toggle
│ ──────────────────────────────────────────────────────────────────────  │
│  AGENT                TYPE         ACCESS        SESSIONS  LAST SEEN      │  th, xs uppercase muted
│  ● analyst            autonomous   8 grants      ◍ 2       4m ago     ⋯  │
│    agt_9f2c…                                                             │  mono xs muted subtitle
│  ⚠ etl-bot            autonomous   ⚠ No access   —         1h ago     ⋯  │  amber-outline flag
│  ● claude-desktop     delegated    via scope     ◍ 1       just now   ⋯  │
└────────────────────────────────────────────────────────────────────────┘
```

**The Roster has a table⇄card view toggle** (segmented control in the toolbar,
preference persisted). Both render the same population, filters, and sort:

- **Table** (above) — dense two-line rows; max scannability for a fleet ("which
  are stale / have no access"). Row = name (foreground-medium) + mono id (muted);
  whole row links to detail; hover `bg-muted`; `◍` green session dot when active,
  counts `tabular-nums`; `⋯` = Suspend / Resume / Delete.
- **Cards** — responsive grid; each card carries name + state, an access/session
  summary line, and one inline action that adapts to state (`Connect` when
  active, **`Grant →`** when `⚠ No access`). More breathing room, fewer per
  screen — good at small fleets.

Same `StatusBadge` + `No access` flag in both views, so state reads identically
either way.

### Layout — Agent detail

```
┌────────────────────────────────────────────────────────────────────────┐
│ Agents › analyst                                                         │  breadcrumb
│ ● analyst   autonomous · last seen 4m   [ Connect ] [ Suspend ] [ ⋯ ]    │  h1 + inline meta
│ ⚠ No access — authenticates, but every query is denied.   [Grant access] │  banner (conditional)
│ ┌──────────┬───────────────────────────────────────────────────────┐    │
│ │ Overview │  ┌── Section ─────────────────────────────────────┐    │    │
│ │►Access   │  │ Direct grants                         [ Edit ] │    │    │
│ │ Keys     │  │  lake.sales.orders        read                 │    │    │
│ │ Sessions2│  │ Delegated scope                                │    │    │
│ │ Memory   │  │  (your grants ∩ lent)                          │    │    │
│ │ Activity │  └────────────────────────────────────────────────┘    │    │
│ └──────────┴───────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────┘
```

**Left sub-rail** lists the sections; the active one (blue marker + foreground
text) renders in a single-column `Section` frame to its right (retire the old
2-col card grid — it cramped the ACL editor). Counts sit inline on rail items
(`Sessions 2`). Header carries identity + lifecycle; `Connect` opens the modal;
the `No access` banner spans full width above the rail when relevant.

> **Keeping it light, not a 3-panel UI:** the global sidebar is already
> `collapsible="icon"`. On the detail route it should sit **collapsed to icons**,
> so the agent sub-rail becomes the page's primary vertical nav — one full rail,
> not two. The sub-rail is `border-r`, muted, ~180px; collapses to icons on
> narrow viewports.

### Layout — Connect modal (`sm:max-w-2xl`)

```
┌── Connect · analyst ───────────────────────────────────────────┐
│ ┌ MCP (recommended) ┐  Raw DuckDB        ← segmented toggle      │
│ ─────────────────────────────────────────────────────────────── │
│ Add to your MCP client:                                          │
│ ┌──────────────────────────────────────────────────────┐ [copy] │  mono block
│ │ { "waddling": { "url": "https://…/mcp",               │        │
│ │   "headers": { "Authorization": "Bearer sk_agent_…" }}}│        │
│ └──────────────────────────────────────────────────────┘        │
│ ⓘ The key is shown here because it lives on this agent.          │
└──────────────────────────────────────────────────────────────────┘
  ── Raw DuckDB panel (toggle) ──
  SET allow_unsigned_extensions=true;
  INSTALL birdshot FROM 'https://ext.getwaddling.com'; LOAD birdshot;
  ATTACH 'quack:…?token=sk_agent_…' AS lake;          [copy]
  "For connecting or checking access by hand."
```

MCP is the default panel; Raw DuckDB is one toggle away for manual verification.
Each block is a mono code surface (`bg-muted`, 5px, ring) with a copy button.

### Layout — Swarms tab & Delegations tab

- **Swarms:** responsive card grid. Each card: swarm name, member count, a stacked
  initials cluster of members, a one-line shared-access summary; `+ New swarm`
  card. Click → `/agents/swarms/[id]` (member table reusing the Roster row +
  shared-access Section). Roster can optionally **group-by-swarm** (collapsible
  group headers) — same population, two lenses.
- **Delegations (admin):** dense cross-principal table — Principal (name+type) ·
  Scope (`lake.schema.table`, mono) · Capability · Source (OAuth client / manual)
  · Expires · `⋯` revoke. Admin-only, server-authorized.

### Motion (restrained — it's a console, not a toy)

- Tab switch: body fades + 4px rise, 120ms ease-out.
- Row hover: `bg-muted` 100ms.
- Dialog: scale 0.98→1 + fade, 150ms (shadcn default).
- First paint: optional 20ms-staggered row reveal; skip if it ever feels slow.
- Copy button: icon swap to ✓ for 2s (already the pattern).
- No parallax, no decorative loops, no gradient meshes.

### Settled layout decisions

1. **Detail navigation → left sub-rail** (collapsible to icons; global sidebar
   collapses to icons on this route to avoid a double rail).
2. **Roster → table⇄card view toggle** — both views ship; user preference is
   persisted; state reads identically in each.

---

## Part 5 — Canonical visual frame (lifted from the ACL editor)

The ACL editor (`access-editor-dialog.tsx` + `access-editor.tsx`) is **already the
house style** for a focused workspace: a fixed chrome shell wrapping a **rounded
scroll container that holds a left section-rail + scrolling content**. This is the
"rounded area with the left sidebar rail." We adopt it verbatim across the Agents
surface so everything reads as one tool — and it's proven, not invented.

### The shell — header / body / footer, chrome never scrolls

```
top-anchored, fixed height:   top-[6vh] h-[88vh]  (modal)  ·  page uses page height
header:  shrink-0 px-4 pt-4 pb-2          ← title + identity/lifecycle
body:    min-h-0 flex-1 px-4 py-2         ← holds the rounded container
footer:  shrink-0 px-4 pt-2 pb-4          ← left: change/summary line · right: actions
```

### The rounded container — THE element you pointed at

```html
<div className="h-full overflow-hidden rounded-lg border bg-background/40 p-3">
```
A soft inset "workspace" panel: `rounded-lg` (5px) · `border` · `bg-background/40`
(a hair off the page) · `p-3`. This surface = "you are in a tool now."

### The left rail (inside the panel)

```
nav:    w-44 shrink-0 border-r pr-2 · flex-col gap-0.5
label:  text-[11px] font-medium uppercase tracking-wide text-muted-foreground   ("Sections")
item:   flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors
          active   → bg-muted font-medium text-foreground
          inactive → text-muted-foreground hover:bg-muted/50 hover:text-foreground
icon:   size-4      count badge: rounded bg-primary/15 px-1.5 text-xs text-primary
collapse: PanelLeftClose ⇄ PanelLeft  (rail → icon button)
```

### The content (right of the rail)

```
container:      ScrollArea · min-h-0 flex-1 pl-3 pr-2
section header: text-[11px] font-medium uppercase tracking-wide text-muted-foreground · border-b pb-1.5
rows:           border-b py-1.5 · font-mono names · text-xs muted meta · icons size-3.5 muted
inline chips:   rounded-md border bg-muted/40 py-1 pl-2 pr-1 + font-mono text-xs
inline inputs:  h-7 font-mono text-xs
```

### Mapping it onto the Agents surface

- **Agent detail page = this shell, un-modal'd onto the page.** Header (identity +
  lifecycle) → the rounded `bg-background/40` container whose **left rail = the
  agent sections** (Overview/Access/Keys/Sessions/Memory/Activity, with count
  badges) → ScrollArea content. Identical classes; page instead of dialog. This is
  the concrete build of the "left sub-rail" decision (Part 4).
- **No rail-in-rail.** The **Access section shows the read-only grant view** (the
  current `AgentAccess` tables); deep editing opens the **`AccessEditorDialog`**,
  which carries its *own* Catalog/Sources/Extensions rail. Page-rail and
  editor-rail never coexist on one surface.
- **Connect modal** = the same shell; segmented MCP|DuckDB; each panel a
  `rounded-lg border bg-muted` mono code block with copy.
- **Roster (table & cards) stays on the plain page — NOT the inset panel.** The
  `bg-background/40` panel is reserved for *workspaces* (detail, editors); the
  roster is an *index*, so it reads lighter. This makes "index vs. workspace"
  legible at a glance — the inset panel becomes the visual signal of "you are
  working on one thing."

### Already converged in-tree (align, don't rebuild)

The working tree already replaced the cramped create dialog **and** the list-row
editor with one shared **`AccessEditorDialog`** (create + edit), including a
pending-change summary and a confirm-gate on access *removals*. That **is** the
single ACL editor the plan calls for. What's **not** done: `/agents/[id]` is still
the old `grid-cols-1 md:grid-cols-2` card stack — Phase 1's detail refactor swaps
that grid for the shell above and points its Access section at the existing dialog.
