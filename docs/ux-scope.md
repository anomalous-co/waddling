# waddling dashboard — UX scope & flow diagram

The waddling control-plane dashboard (`apps/waddling`) covers the full set of data-product routes
(endpoints, agents, ACL, audit, usage, billing, settings, notebooks, views, sessions, device-link
onboarding) backed by working control-api handlers. This document captures every view, what the
user does there, and the business case — sourced from the approved plan and intended as the durable
reference for the shadcn rebuild.

---

## Personas / business actors

- **Org admin (human, browser)** — sets up lakes, agents, and policy; watches usage/audit; pays.
- **Member (human, browser)** — read-mostly; runs notebooks/views; reviews audit.
- **Headless agent (machine, MCP / `sk_agent_…` API key)** — connects via device-link or key, ATTACHes
  the endpoint, runs SQL gated by birdshot. Never sees the browser; surfaces in sessions/audit/usage.

---

## Global flow

```
                   ┌─────────────────────── marketing (getwaddling.com) ───────────────────────┐
                   │  landing · pricing · customers · docs/blog · enterprise → "Start" CTA      │
                   └───────────────────────────────────┬───────────────────────────────────────┘
                                                        ▼
                                          app.getwaddling.com /sign-up | /sign-in
                                                        │
                     first run (no org)                 │            returning user
            ┌───────────────────────────────────────────┴───────────────────────────────┐
            ▼                                                                             ▼
create organization (Better Auth org.create)                                   /dashboard (Overview)
            │                                                                             │
            ▼                                                                  drill into any surface
┌──── ONBOARDING / "Connect" hub (NEW) ─────┐                                              │
│  1. Create endpoint (data lake)           │   ◀──────────────────────────────┐          │
│  2. Create agent (reveal API key once)    │                                  │          │
│  3. Connect agent:                        │                                  │          │
│     • MCP server config                   │                                  │          │
│     • ATTACH 'quack:…' string             │                                  │          │
│     • device-link code (XXXX-XXXX)        │                                  │          │
│     • INSTALL birdshot extension SQL      │                                  │          │
│  4. (optional) write ACL rules            │                                  │          │
└───────────────────────┬───────────────────┘                                  │          │
                       ▼                                                       │          │
    headless agent connects ──ATTACH──▶ gateway ──birdshot_authorize──▶ lake  │          │
                       │  (the one gated path; allow/deny)                     │          │
                       ▼                                                       │          │
    rows flow back; every query → usage_event + audit_event ────────────────┐ │          │
                                                                             ▼ ▼          ▼
                                      Sessions (live) · Usage (charts/cost) · Audit (allow/deny log)
```

---

## Per-view scope

**Status legend**: ✅ works today · ⛔ calls a route that doesn't exist / wrong shape · ⚠ field-name mismatch · ➕ new view to build

| Path | What the user does here | Business case | Status |
|---|---|---|---|
| `/sign-up`, `/sign-in` | Email/password auth; first-run continues to **create organization** | Front door; org = tenant boundary | ✅ |
| `/dashboard` (Overview) | Glance: running endpoints, active agents, **live sessions**, queries(24h); area chart; health tables; jump-off links | "Is everything healthy right now?" — the daily landing pane | ✅ |
| **Onboarding / Connect hub** | Step-through: create endpoint → create agent (reveal key) → copy MCP config / ATTACH string / device code / INSTALL SQL → optional ACL | **The activation moment** — turns a new org into a connected, querying agent. Today this is scattered across pages with no empty-state guide | ➕ |
| `/dashboard/endpoints` | List lakes (name, slug, status, schemas); "New endpoint" | Inventory of managed data lakes | ✅ |
| `/dashboard/endpoints/new` | Create-endpoint wizard (managed catalog vs BYO storage) | Provision a new lake | ✅ |
| `/dashboard/endpoints/[id]` | View status, **ATTACH string**, gateway host:port, snapshot lag, schema list, birdshot status; provision (local dev) | Connection details + health for one lake; the "how do I connect" reference | ✅ |
| `/dashboard/agents` | List agents (role, status, last seen); **create agent** → reveal one-time key | Manage machine principals | ✅ |
| `/dashboard/agents/[id]` | Agent detail; API keys; **its sessions**; **revoke agent**; **kill a session** | Operate / offboard a principal; incident response | ⛔ revoke + kill |
| `/dashboard/acl` | Build per-agent table/column rules (verb, effect, row-limit, TTL, time window, priority); list/delete rules | **The product's core value** — dynamic access control compiled into birdshot | ✅ (pro-gated) |
| `/dashboard/audit` | Filter (agent, since, allow/deny, limit) the durable query log; see decision + reason + SQL | Compliance / forensics / "why was this denied?" | ✅ |
| `/dashboard/usage` | Period selector; metric cards (queries, rows/bytes scanned, sessions, **est. cost**); time-series chart | Capacity + cost visibility; quota awareness | ⚠ field-name mismatch |
| `/dashboard/billing` | See plan + entitlements; **Upgrade**; **Manage subscription** (Stripe portal) | Monetization; self-serve plan change | ⛔ checkout + portal + shape |
| `/dashboard/settings` | Org info; members (invite, role); agent API keys (rotate/revoke) | Team + credential administration | ✅ |
| `/dashboard/sessions` | Dedicated list of live + recent agent ATTACH sessions; kill | Operational view of who's connected right now | ➕ (logic exists; no page) |
| `/dashboard/notebooks` | Multi-cell SQL editor; run cells via the gated session/query path; schema autocomplete; save; pin cell → view | Self-serve exploration on the lake (admin/member side) | ✅ |
| `/dashboard/views` | List/run/delete saved named queries | Reusable, shareable queries | ✅ |
| `/link` | Device-code claim: human approves a headless agent's code → binds agent + mints key | Headless onboarding without pasting keys into agents | ✅ |
