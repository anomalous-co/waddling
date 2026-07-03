# Grant / Access UX plan

**Scope:** replace the current access authoring experience with one coherent, schema-aware,
picker-first surface used identically at **agent creation** and on **agent detail**. Two coordinated
tabs — **Picker** (structured, visual, no SQL) and **Grant SQL** (literal statements, power users) —
editing one underlying grant set.

**Status of the code today (grounded, with refs):**
- Live agent-detail access surface: `GrantsSection` — `src/components/dashboard/agent/grants-section.tsx`,
  mounted as the `access` section of `src/app/(dashboard)/agents/[id]/page.tsx:281` via `DetailLayout`.
  Granular literal-SQL model (`SELECT/INSERT/…`, `effect`, `columns`).
- Live create flow: `AccessEditorDialog` (`src/components/dashboard/access-editor-dialog.tsx`) opened from
  `src/app/(dashboard)/agents/page.tsx:585`, rendering the **OLD coarse** `AccessEditor`
  (`src/components/dashboard/access-editor.tsx`) — `read/write/create/drop/alter/detach` on `acl_rule`.
- **Dead / superseded:** `AgentAccess` (`src/components/dashboard/agent-access.tsx`) is imported nowhere;
  `src/lib/access-diff.ts` + the coarse `AccessEditor` model target `/api/cp/acl-policy` (no route handler
  exists) and post `capability` (rejected by the granular `POST /api/cp/acl`). This is the interaction model
  we salvage, **not** the data model.

The result: creation uses a coarse picker that posts a shape the API rejects; detail uses a statement list
that is hard to read and forces you to type object names from memory. This plan unifies both.

---

## 1. Diagnosis — why `grants-section.tsx` isn't intuitive

Concrete, per the current component:

1. **Two stacked lists of the same thing (the core confusion).** "Grant SQL" (resolved, read-only,
   grants-section.tsx:233) and "This key's grants" (editable own rows, :277) render overlapping statements
   in two cards. A statement the operator just added appears in *both*; role/PUBLIC statements appear only in
   the top one. The relationship ("why is this above but not below?") is never explained on-screen. The user
   must mentally diff two verbatim SQL lists.
2. **Authoring demands prior knowledge of the schema.** `AddGrantDialog` (:332) is a form with free-text
   `schema` and `table` inputs (:474, :496). You must *remember and type* `sales` and `orders` exactly. No
   browse, no autocomplete, no columns list — the exact non-starter this redesign must fix.
3. **Statement-centric, not object-centric.** To answer "what can this key do to `orders`?" you scan a flat,
   unordered list of SQL strings. There is no grouping by object, no matrix, no at-a-glance.
4. **Ten raw privilege checkboxes, no shape** (:454). `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/CREATE/DROP/
   ALTER/USAGE/EXECUTE` are presented flat and equal. Nothing communicates "read" vs "write" vs "admin," and
   there are no presets — every grant is assembled from primitives.
5. **Deny is invisible as a relationship.** A `DENY` is just another red row (StatementRow, :96). The
   deny-wins *carve-out* — "SELECT on all of `analytics` **except** `pii`" — is the whole point of DENY, yet
   nothing visually ties the deny to the grant it narrows. You cannot see that `pii` is excluded from an
   `analytics` grant without reading and mentally intersecting two statements.
6. **Roles / membership absent.** `GRANT analyst TO agent:…` and `… TO ROLE analyst` only ever appear as
   read-only resolved text. There's no way to grant a role, see which roles a key holds, or understand
   inherited access as inheritance.
7. **No provenance.** When access *is* shown, you can't tell *why* — direct grant, schema wildcard, role, or
   PUBLIC. So the headline promise ("see EXACTLY what the key can and cannot do") isn't actually legible.
8. **Editing is delete-one / add-one.** No expand-in-place ("also allow INSERT here"), no batch, no diff
   summary before applying — unlike the (dead) `AgentAccess` which at least batched a diff.

---

## 2. Design principles

- **P1 — Browse, don't recall.** The object side of the picker is a *live* tree of the datalake's real
  schemas → tables → columns. Typing an object name is a power-user fallback, never the primary path.
  Column-level grants pick from the table's actual columns.
- **P2 — Object-centric, effective-state-first.** The operator thinks in objects ("the analytics schema"),
  not statements. Every node shows its *resolved* status and *why* (provenance). This is the same computation
  that answers "read at a glance & trust it" and "why can/can't it touch X."
- **P3 — One grant set, two views.** Picker and Grant SQL are projections of a single canonical model. No
  divergent state. Picker → SQL is always lossless; SQL → Picker is a faithful projection with an honest
  escape hatch for statements the picker can't represent.
- **P4 — Access at birth.** Creation includes the same picker with sane starter presets, so a new key is
  never born with zero access and an operator left hunting.
- **P5 — Progressive disclosure.** Allow-by-default; deny, columns, roles, and wildcards are one deliberate
  step deeper, so the common case stays a two-click grant and the advanced case is fully expressible.
- **P6 — Deny & inheritance are relationships, not rows.** Carve-outs render *attached to* the grant they
  narrow; inherited access renders as inheritance, visually distinct from direct grants.

---

## 3. Information architecture

### 3.1 One component, two tabs

New component `AccessManager` (`src/components/dashboard/access/access-manager.tsx`) — a controlled editor
over a single `AccessDraft`, with an internal `Tabs`:

```
Access ─────────────────────────────────────────── [ Data lake ▾ ]  [ Save 3 changes ]
┌ Picker ┊ Grant SQL ┐            ← shadcn Tabs (line variant)
```

- **Tab 1 · Picker (default).** Object browser × privilege presets, with allow/deny, columns, roles,
  wildcards. Generates literal statements under the hood.
- **Tab 2 · Grant SQL (power).** The key's **own** literal statements — editable and paste-authorable — with
  a visually distinct, **read-only "Inherited" section** below (role- and PUBLIC-derived statements). This
  is *not* a third tab and is not the duplicated-list pattern from today: the own/inherited split is one
  panel, inline-editable above, muted-read-only below, each inherited row chipped with its source
  (`via role analyst`, `PUBLIC`).

The two-list confusion (Diagnosis #1) is resolved by making the resolved/inherited view a *subordinate,
clearly-labelled read-only region of the SQL tab*, never a second editable copy.

### 3.2 Where it composes

- **Agent detail** (`agents/[id]/page.tsx`): the `access` section renders `<AccessManager mode="detail"
  agentId=… />` in place of `GrantsSection`. Keep `SectionHeader` (`agent/kit.tsx:195`) with the datalake
  selector + Save action in `action`. `GrantsSection` is retired.
- **Create agent**: `AccessManager` embeds as the access step of the create flow. Retire the coarse
  `AccessEditor` inside `AccessEditorDialog`; the dialog keeps its identity fields (name / description / mode
  / default role) in the header and hosts `<AccessManager mode="create" draft=… onChange=… />` in the body.
  On submit: create the agent, then persist the draft's statements. (See §8 for the create-persist gap.)

Both surfaces mount the **same** `AccessManager`; only `mode` differs (detail = load existing + inline save;
create = in-memory draft persisted after the agent id exists).

---

## 4. The canonical model and picker ↔ SQL sync

### 4.1 Canonical model = ordered list of statement strings

The server's only representation of a key's access is literal SQL: `GET /api/cp/acl?datalakeId=` →
`GrantStatementRow[] {id, stmt, granteeKind, …}` (own rows, deletable by id); `GET /api/cp/agents/:id/
grants?datalakeId=` → `{ statements: string[] }` (resolved own ∪ role ∪ PUBLIC). **There is no structured
read model.** Therefore:

> The canonical in-memory model is the **ordered list of the key's own statement strings** (each carrying its
> row `id` when persisted). The **Picker is a projection over that list**, not a parallel structured model.

This avoids the classic dual-model drift (a "structured rows + raw list" pair desynchronizes the instant
someone edits SQL then toggles to the picker). Save semantics stay exactly as today: **diff by statement-
string identity → DELETE removed rows (`DELETE /api/cp/acl/:id`) + POST added statements
(`POST /api/cp/acl`)**, batched with a pre-apply diff summary and the existing reduction-confirm gate
(`grants-section`/`access-editor-dialog` already model this).

### 4.2 Picker → SQL: always, lossless

Each picker "grant row" = `{ effect, privileges[], object (schema.table | ALL TABLES IN SCHEMA), columns[],
grantee }` → exactly one literal statement, built by the **same grammar the server uses** (`grant()`/`deny()`
in `apps/control-api/src/routes/acl.ts`; `table === '*'` → `ALL TABLES IN SCHEMA <schema>`, acl.ts:97). Deny
rows → `DENY …`. Role membership → `GRANT <role> TO <subject>`.

### 4.3 SQL → Picker: mandatory projection (not optional round-trip)

Because the server returns only strings, **parse-back is required even to render the current state of an
existing key** — it is not merely a power-user nicety. The real decision is *where the parser lives*:

- **Recommended — server-side structured decomposition.** The control-api already owns the `grant()`/`deny()`
  builder; extend the grants/acl responses to include, per row, a `parsed` decomposition
  `{ effect, privileges[], columns[], schema, table, grantee, kind } | null` (either persist the structured
  inputs at author time, or parse its own emitted grammar server-side). The Picker binds `parsed` directly;
  `parsed === null` → the statement is a hand-written/exotic form that lands in the Picker's read-only
  **"Advanced statements (N)"** bucket, linking to the Grant SQL tab. One grammar, one source of truth, no
  client/server drift.
- **Fallback — client-side parser** over the picker's own emitted subset. Works, but duplicates the grammar
  in TS; every builder tweak risks silently-wrong picker state.

**Recommendation:** take the server-decomposition path (we already need backend changes for roles and
create-persist, §8). **Tradeoff to call out:** a power user's exotic SQL (functions, unusual grammar,
expressions) is *not visually editable* — it is preserved, shown, and editable only in the SQL tab via the
Advanced bucket. This is deliberate: honest and lossless beats a lossy round-trip that clobbers hand-written
SQL. The picker never silently drops or rewrites what it can't model.

### 4.4 Sync summary

| Direction | Behaviour |
|---|---|
| Picker → SQL | Deterministic regenerate from the model. Always lossless. |
| SQL → Picker | Project recognized statements into rows; unrecognized → read-only "Advanced (N)" bucket → SQL tab. No data loss. |
| Save | Diff canonical statements by string identity → DELETE + POST, batched, reduction-gated. |

---

## 5. The Picker

Layout salvages `access-editor.tsx`'s proven shell — a left section-nav (`Tabs` list) + a scrolling
resource pane — but swaps the coarse model for granular + live schema browse + provenance.

### 5.1 Object side — live schema browser (P1)

- **Source of truth:** `GET /api/cp/datalakes/:id/catalog` (**control-api** `routes/datalakes.ts:768`),
  which serves a cached `GatewayCatalog` snapshot `{ datalakeId, schemas: [{ name, tables: [{ name,
  columns: [{ name, type, nullable }] }] }], fetchedAt, stale }`. This is the *unfiltered, admin-only*
  authoring catalog and it **includes columns**. `access-editor.tsx:118-131` already consumes exactly this.
- **Tree:** `Entire lake` → `schema` → `table` → (expand) `columns`. Collapsible nodes (reuse
  `access-editor.tsx:204-233` `renderSchema`). Add a **search/filter** box that filters schemas/tables/columns
  by substring (large catalogs) — new, but small.
- **"All tables in schema"** is an explicit control at the schema node (grant applies to
  `ALL TABLES IN SCHEMA`, incl. future tables), distinct from expanding to pick individual tables.
- **Column selection** at a table node: a multiselect drawn from that table's real `columns` (no typing).
  Selecting a subset scopes the privilege to `(col, col)`.

**States (part of the design, P1):**
- *Loading* — skeleton rows in the tree.
- *Cache empty / provisioning* (`{ schemas: [], fetchedAt: null, stale: true }`, datalakes.ts:789) — empty
  state: "Catalog still provisioning" + **Refresh** (`POST /:id/catalog/refresh`, datalakes.ts:795).
- *Gateway unreachable* — `refreshCatalog` returns null → same empty payload; message "Couldn't reach this
  lake's gateway" + Retry. Free-text object entry (§5.4) stays available so authoring isn't fully blocked.
- *Empty datalake* — schemas present but no tables → "No tables yet."
- *Stale* — show `fetchedAt` + a subtle "Refresh" affordance.

### 5.2 Capability side — granular privileges, shaped (Diagnosis #4)

Per object row, a compact capability control (evolve `CapabilityMenu`, access-editor.tsx:442) offering
**presets first, primitives on demand**:

- **Read** → `SELECT`
- **Write** → `INSERT, UPDATE, DELETE` (+ `TRUNCATE` under "more")
- **Manage** → `CREATE, DROP, ALTER`
- **Advanced** (disclosure) → individual toggles for all ten incl. `USAGE`, `EXECUTE`.

The button summarizes state ("Read", "Read + Write", "SELECT, INSERT", "Custom", "None") like today's menu,
but the dropdown leads with the three presets and reveals primitives under "Advanced." Read-only is a
one-click default.

### 5.3 Effect, provenance & effective state (P2, P6 — the trust element)

This is the marquee addition and the answer to "read at a glance," "trust it," and "understand why."

**Every tree node computes its status from the full resolved set** (own ∪ role ∪ PUBLIC ∪ denies), not just
this key's own rows:

| Node status | Meaning | Render |
|---|---|---|
| `none` | no access | muted, no chip |
| `allowed-direct` | direct grant on this object | green, privilege summary |
| `allowed-via-schema` | covered by `ALL TABLES IN SCHEMA` | green + chip "via schema wildcard" |
| `allowed-via-role` | from a held role | green + chip "via role analyst" |
| `allowed-via-public` | from PUBLIC | green + chip "PUBLIC" |
| `denied-explicit` | direct DENY | red + `Ban` icon |
| `denied-overrides` | DENY overriding a broader allow (carve-out) | red, indented under the grant it narrows, chip "carve-out — overrides schema grant" |

So the marquee scenario is legible without reading SQL: `analytics` = green "SELECT · all tables"; `pii`
nested under it = red "carve-out, overrides schema grant." Inherited/PUBLIC nodes are shown but **not
inline-editable** (chip explains where to change them: the role, not this key). This is the same resolved
data the old top card showed — reused as node decoration instead of a second list.

**Effect toggle:** each grant action defaults to **Allow**. A per-row **Allow / Deny** switch (segmented,
progressive) turns it into a carve-out; when you Deny a table under an already-allowed schema, the UI
explicitly frames it as "carve `pii` out of the `analytics` grant" (deny-wins).

### 5.4 Free-text fallback (P1 caveat)

Keep the "grant a schema/table not yet in the catalog" input (access-editor.tsx:390-401) as a labelled
**power-user fallback** below the tree — used when the catalog is stale/unreachable or the object is
future/not-yet-created. Never the primary path.

### 5.5 Roles & membership (progressive, P5)

A dedicated **"Roles"** node in the left section-nav (peer of the object tree):
- **Membership:** "This key holds:" chips of held roles + an "Add role" combobox populated from the org's
  roles (needs a listing endpoint, §8). Adding → `GRANT <role> TO <subject>`.
- **Grant to a role** (admin): author `… TO ROLE <role>` so a change propagates to every holder. Clearly
  flagged as org-wide, not key-scoped.
- Held-role access surfaces back in the object tree as `allowed-via-role` provenance chips — the two views
  reinforce each other.

---

## 6. Rich user-scenario walkthroughs

Each is designed to be fast and obvious. "Clicks" counts from an open Access tab.

1. **Read-only on the whole `analytics` schema.** Expand `analytics` (or just find it via search) → its
   capability control → **Read** preset with the "all tables in schema" scope selected at the schema node.
   *2 clicks.* Emits `GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO agent:id`. Tree shows `analytics`
   green, every child green "via schema wildcard."
2. **…but NOT `pii` (deny carve-out).** On the `pii` node (now green "via schema wildcard"), flip **Deny**.
   UI frames it "carve `pii` out of your analytics grant." *1 click.* Emits `DENY SELECT ON analytics.pii TO
   agent:id`; `pii` renders red "carve-out — overrides schema grant." The relationship is visible.
3. **Write to one staging table only.** Search `staging_orders` → capability → **Write**. *2 clicks.*
   `GRANT INSERT, UPDATE, DELETE ON staging.staging_orders TO agent:id`.
4. **Column-level SELECT on `(id, created_at)`.** Expand `events` → columns → check `id`, `created_at` →
   Read. *~4 clicks.* `GRANT SELECT (id, created_at) ON analytics.events TO agent:id`. Columns picked from
   real column list — no typing.
5. **Give it the `analyst` role.** Roles node → Add role → `analyst`. *2 clicks.* `GRANT analyst TO
   agent:id`. Object tree repaints affected nodes green "via role analyst."
6. **Clone what another agent/role can do.** "Start from…" combobox (create flow) or a "Copy access from…"
   action (detail) → pick a source agent/role → its statements load as a *pending* draft (rewritten to this
   grantee), fully editable before Save. Feasible on existing APIs (read source `grants`, rewrite grantee,
   POST); see §8.
7. **Revoke one thing it has.** In the object tree, open the granted node → set capability to **None** (or
   remove the deny); or in the SQL tab, delete the row. Either way it's a pending removal in the diff,
   reduction-gated on Save. *1–2 clicks.*
8. **Read current access at a glance & trust it.** The tree *is* the dashboard: green/red nodes + provenance
   chips, computed from the resolved set. No SQL reading required; the SQL tab is there if you want the
   verbatim proof.
9. **Understand why it can/can't touch X.** Find `X` in the tree; its chip states the reason
   (`via role analyst`, `PUBLIC`, `carve-out overrides schema grant`, or `no access`). Same computation as #8.
10. **Sensible access at creation without deep DB knowledge.** Create dialog offers starter presets:
    **Read-only analyst** (SELECT on chosen schemas), **No access (add later)**, **Clone from…**. Pick a lake,
    pick a schema or two, done — access set at birth (P4).
11. **Power user pastes a block of GRANT SQL.** Grant SQL tab → paste → statements parse into the canonical
    list; recognized ones project into the Picker, exotic ones sit in "Advanced (N)." Save diffs & applies.
12. **Multi-lake key.** Datalake selector in the header scopes the whole surface per lake (control-api ACL
    endpoints are `?datalakeId=`-scoped); each lake has its own tree + statements.

---

## 7. Catalog data source, the known gap, and required verification

**The authoring picker uses `GET /api/cp/datalakes/:id/catalog` (control-api `routes/datalakes.ts:768`)** — a
cached `GatewayCatalog` with full `schemas[].tables[].columns[]`, admin-only, boot-on-demand. Its gateway
client method **is implemented** (`gateway-client.ts:232`, `GET /gw/catalog`).

**Reconciliation of the "describe returns empty tables" flag.** That regression is in a *different* endpoint:
`GET /api/cp/datalakes/:id/describe` (datalakes.ts:704) — the **grant-scoped, agent-facing** view — which now
returns `{ tables: [] }` (datalakes.ts:741, 749) because grant-scoped column introspection wasn't
re-implemented post-cutover, and its gateway `.describe()` is 501-gated (`gateway-client.ts:224`). **This does
NOT block the authoring picker**, which uses the *unfiltered* `/catalog` path, not `/describe`. It *would*
block a grant-scoped "what can this agent actually see, run-as, with real column types" preview — which we are
**not** building here (§5.3 provenance is computed client-side from statements, not from typed introspection).

**Required backend verification (do not assume):** `/catalog`'s client method is live, but that's the client
side only. Before relying on it: **confirm the data-plane gateway `/gw/catalog` handler returns real
schemas/tables/columns post-cutover and that `waddling.datalake_catalog` actually populates** (boot-on-demand
`refreshCatalog`, datalakes.ts:783-787). If that regressed alongside `/describe`, the picker's browse breaks —
so this is a gating check, listed in §9.

**Lab parity gap:** the Next lab has **no** `/api/cp/datalakes/:id/catalog` mock — the fixture catalog is
embedded on `GET /api/cp/datalakes/:id` as `datalake.catalog` with a *different* shape
(`catalog[].tables[].columns[]`, keys `schema`/`table`; `src/lab/fixtures/datalake-catalog.ts`). Add a lab
mock route matching the control-api `{ schemas[].tables[].columns[], fetchedAt, stale }` shape so local dev
exercises the real browse path.

**`/describe` rebuild is CONDITIONAL** — required only if we later add a grant-scoped effective-types preview.
Not on the critical path for this plan.

---

## 8. Required backend work (so the plan is buildable)

1. **Role-membership authoring + role listing (blocks scenarios 5, 6, roles node).** `POST /api/cp/acl`
   (`GrantInputSchema`, acl.ts:74) authors *object* grants only; `subjectKind` is `agent|user|org` and cannot
   target or grant a *named* role like `analyst`. Add either a `grantRole` path (`GRANT <role> TO <subject>`)
   or extend the schema, plus a **`GET /api/cp/roles`** listing the org's birdshot roles for the combobox.
2. **Granular create-persist (blocks P4).** `POST /api/cp/agents` ignores `grants[]` and creates no access;
   the create dialog currently posts *coarse* `capability` grants the granular API rejects. Fix the create
   flow to: create agent → POST the draft's granular statements to `/api/cp/acl` (or have `agents` accept
   granular `grants[]` and fan them out). Retire the coarse `flattenGrants` path.
3. **Server-side statement decomposition (recommended, §4.3).** Add `parsed: {…} | null` per row to
   `GET /api/cp/acl` and `…/grants`. Enables faithful SQL → Picker without a client SQL parser.
4. **Clone-access (scenario 6).** No new endpoint strictly needed — read source statements via `…/grants`,
   rewrite grantee to the target subject, POST. Provide a small client helper; optionally a server convenience
   endpoint later.
5. **Lab `/catalog` mock** (§7) for local dev parity.

---

## 9. Component breakdown & implementation sequence

### Salvage vs. build

**Salvage from `access-editor.tsx`:** the section-nav + scroll-pane shell; `renderSchema` collapsible tree
(:204); the catalog fetch/refresh/stale plumbing (:118-146); the compact per-row capability dropdown pattern
(`CapabilityMenu`, :442) — re-skinned to presets + granular primitives; the "add object not in catalog"
fallback (:390).

**Discard:** `src/lib/access-diff.ts` coarse model + `CATALOG_CAPABILITIES` (`read/write/…`); `AgentAccess`
(dead); the coarse `/acl-policy` sources/extensions sections (out of scope here — they're the
parse-walk policy channel, not table grants).

> **Intentional scope note — Sources / Extensions.** The old `AccessEditor` had three left-nav sections
> (Catalog / Sources / Extensions); the create dialog still exposes all three. This redesign covers the
> **Catalog (table-grant) channel only** — Sources/Extensions ride the separate `acl_policy` parse-walk
> channel, whose Next route (`/api/cp/acl-policy`) has **no handler** and is unrelated to the literal
> GRANT/DENY store. Dropping them here is **not** a silent capability regression: it retires a
> non-functional lab path. If external-source/extension policies must remain authorable, they belong in a
> separate follow-up surface on their own (working) endpoint, not folded into the grant picker.

**New components (`src/components/dashboard/access/`):**
- `access-manager.tsx` — tabbed shell over `AccessDraft`; owns datalake selector, load, diff, save, reduction
  gate. Used in both `mode="detail"` and `mode="create"`.
- `object-tree.tsx` — live schema browser with search, per-node status/provenance, capability control,
  allow/deny, column multiselect, "all tables in schema."
- `capability-control.tsx` — presets (Read/Write/Manage) + Advanced primitives.
- `roles-panel.tsx` — membership chips + add-role combobox + grant-to-role (admin).
- `grant-sql-tab.tsx` — editable own-statements list + read-only inherited section + paste authoring +
  "Advanced (N)" unparsed bucket.
- `access-draft.ts` — canonical model (ordered statements + row ids), `projectToPicker(parsed)`,
  `emitStatement(row)`, `diffDraft(existing, draft)`. Server-decomposition-driven (§4.3).

**Reuse:** `SectionHeader` (`agent/kit.tsx:195`), `SectionCard` (`waddling/section-card.tsx:35`), `EmptyState`
(`waddling/empty-state.tsx:26`), `NoAccessFlag`/`needsAccess` (`agent/kit.tsx:48,53`), `StatementRow`
(grants-section.tsx:96 — lift into the access dir), the reduction-confirm `AlertDialog` pattern.

### Sequence

1. **Backend gates first:** verify `/gw/catalog` returns real data post-cutover (§7). Land role
   authoring/listing + granular create-persist + (recommended) statement decomposition + lab `/catalog` mock
   (§8).
2. `access-draft.ts` + `emitStatement` (mirror control-api `grant()`/`deny()` grammar) + `diffDraft`
   (statement-string identity). Unit-test like `access-diff` was.
3. `object-tree.tsx` against real `/catalog`, with all discovery states (§5.1) and node status/provenance
   (§5.3), computed from the resolved statement set.
4. `capability-control.tsx` (presets + advanced) and allow/deny + column multiselect.
5. `grant-sql-tab.tsx` (own-editable / inherited-read-only / paste / Advanced bucket) bound to the same draft.
6. `access-manager.tsx` tabbed shell; wire diff/save + reduction gate.
7. Swap it into the agent-detail `access` section (retire `GrantsSection`) and into `AccessEditorDialog`
   create flow (retire coarse `AccessEditor`); add create presets (scenario 10).
8. `roles-panel.tsx` once role endpoints land.
9. Delete dead code: `agent-access.tsx`, coarse `access-diff.ts`, coarse `AccessEditor` (and the lab
   `/acl-policy` assumptions).

---

## 10. Wireframes

### A · Agent-detail → Access tab (Picker)

```
┌ Access ───────────────────────────────── [ analytics-lake ▾ ]  [ Save 2 changes ] ┐
│  ┌ Picker ┊ Grant SQL ┐                                                            │
│                                                                                    │
│  ┌ Objects ─┐   Search: [ pii________ ]                                            │
│  │ Objects  │   ▸ Entire lake                                    [ None ▾ ]        │
│  │ Roles    │   ▾ analytics                          ● SELECT · all tables [Read▾] │
│  │          │       events                           ● via schema wildcard  [Read▾]│
│  │          │       sessions                         ● via role analyst     [Read▾]│
│  │          │     ⛔ pii            carve-out · overrides schema grant  [Allow|Deny]│
│  │          │       ▾ orders  (expand columns)       ● SELECT           [Read▾]    │
│  │          │            ☑ id   ☑ created_at   ☐ email   ☐ total                   │
│  │          │   ▸ staging                                          [ None ▾ ]      │
│  │          │   ─ grant an object not in the catalog (fallback) ─  [__________][+] │
│  └──────────┘                                                                      │
│   ● allowed   ⛔ denied / carve-out   ○ none      chips show provenance            │
└────────────────────────────────────────────────────────────────────────────────┘
```

### B · Create agent → Access step

```
┌ New agent ─────────────────────────────────────────────────────────── [ ✕ ] ┐
│  Name [ llm-analyst ]   Description [ … ]   Mode [ autonomous ▾ ]             │
│  Default role [ analyst ▾ ]        Start from ▸ [ Read-only analyst ▾ ]       │
│  ────────────────────────────────────────────────────────────────────────── │
│  Data lake [ analytics-lake ▾ ]        ┌ Picker ┊ Grant SQL ┐                 │
│  ▾ analytics                                        ● SELECT · all tables [Read▾]│
│      events / sessions / orders …                                            │
│  ▸ staging                                                       [ None ▾ ]   │
│  (empty lake → "No tables yet"; provisioning → [ Refresh ])                   │
│  ────────────────────────────────────────────────────────────────────────── │
│  2 grants to create                        [ Cancel ]     [ Create agent ]    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### C · Grant SQL tab (own-editable + inherited read-only + advanced bucket)

```
┌ Picker ┊ Grant SQL ┐
│  This key's statements (editable)                              [ + Add ] [paste] │
│  ✔ GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO agent:123        [🗑]        │
│  ⛔ DENY  SELECT ON analytics.pii TO agent:123                         [🗑]        │
│  ✔ GRANT SELECT (id, created_at) ON analytics.orders TO agent:123     [🗑]        │
│                                                                                  │
│  ▸ Advanced statements (1) — not shown in Picker, edit here                      │
│      GRANT SELECT ON analytics.v_masked_orders TO agent:123  (expression grant)  │
│  ────────────────────────────────────────────────────────────────────────────── │
│  Inherited (read-only) — managed on the role / PUBLIC, not this key              │
│  ✔ GRANT SELECT ON analytics.sessions TO ROLE analyst      via role · analyst    │
│  ✔ GRANT USAGE  ON analytics.public_report TO PUBLIC       PUBLIC                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Open questions / escalations

1. **Parser location (tie-breaker).** Confirm we can add server-side statement decomposition (§4.3). If not,
   we ship a client TS parser for the emitted subset with the known drift risk. This is the single decision
   that changes the plan's internals.
2. **`/gw/catalog` post-cutover health.** Gating verification (§7). If the gateway catalog regressed with
   `/describe`, the whole browse experience is blocked until it's restored — escalate before build.
3. **Role model surface.** How are org birdshot roles defined/listed today (fixtures only)? We need a real
   `GET /api/cp/roles` and an authoring path (§8.1). Is role management in scope for this milestone or do we
   ship object grants first and gate the Roles node behind a follow-up?
4. **Deny semantics UX.** Confirm birdshot deny-wins precedence exactly matches the "carve-out overrides
   schema/role grant" framing for *all* combinations (direct allow vs deny, role allow vs key deny) so the
   provenance labels never lie.
5. **Reduction blast radius.** Removing access takes effect immediately and can interrupt live sessions
   (existing confirm copy). Do we want a per-statement "in use by N sessions" hint before applying removals?
6. **Multi-lake create.** Should the create flow allow granting across multiple lakes in one shot, or one
   lake at birth + add more on detail? (Leaning: one lake at birth, keep create simple.)
7. **Column-grant + wildcard interaction.** A column-scoped grant on `ALL TABLES IN SCHEMA` is usually
   nonsensical (columns differ per table). Recommend disabling the column multiselect when "all tables" is the
   scope, and confirm the API rejects/ignores it.
