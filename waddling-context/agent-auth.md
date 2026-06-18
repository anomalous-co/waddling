# Agent Auth (AAP) Integration — Proposal

> **Status:** proposal, not yet authoritative. `ARCHITECTURE.md` is the source of truth;
> this file describes how `@better-auth/agent-auth` (the **Agent Auth Protocol**, AAP —
> [agentauthprotocol.com](https://agentauthprotocol.com)) folds into the existing design.
> Nothing here changes the data plane. See [better-auth.md](./better-auth.md) for the
> base auth stack this builds on.

## Thesis

Today an agent *is* an org API key (`sk_agent_…`) bound 1:1 to a `waddling.agent` row.
The principal the gateway sees is an opaque `agent:<id>`. We can't say, in a trace, **who
delegated this agent, in what mode, to do what.**

AAP enriches what `agent:<id>` *means* — name, mode (delegated/autonomous), the human
who delegated it, and the coarse capability being invoked — and that richness flows into
**PostHog events and `audit_event`/`usage_event` rows.** The `connect → session JWT →
birdshot` data path is unchanged. AAP is a **control-plane** concern.

## Scope (anchored on tracing)

**In scope** — the identity model that makes traces legible:
- `agentSession.agent` → `{ id, name, mode, capabilityGrants, hostId, metadata }`
- `agentSession.user` → the resolved **delegating human** (delegated mode) or the synthetic
  autonomous user (`resolveAutonomousUser`)
- delegated vs. autonomous **mode** as a first-class trace dimension
- the **capability** name invoked (coarse action) + the AAP JWT `jti`

**Peripheral / optional follow-ons** — useful but *not* required for tracing richness:
- Device authorization + CIBA approval flows (agent onboarding/consent)
- `/.well-known/agent-configuration` discovery document
- AAP's MCP/OpenAPI adapters auto-generating the tool surface

Recommendation: ship the identity-for-tracing layer first (Strategy A below); treat
approval flows + discovery as a phase 2.

## Packages (new pinned dependency)

```
@better-auth/agent-auth: *      # NEW — not in the current authoritative stack
```

The current stack (`better-auth 1.6.18`, `@better-auth/api-key`, `@better-auth/stripe`)
is unchanged. **This is a stack addition and must be ratified in ARCHITECTURE.md §deps.**

## Strategy A — AAP as identity/capability layer (recommended)

AAP runs in the **control plane** (`apps/waddling`) alongside the existing Better Auth
instance. It owns: the agent↔human delegation relationship, agent mode, capability
declaration, and (phase 2) approval. The existing API-key → session-JWT → birdshot path
is untouched; the session JWT minted at `connect` now **carries AAP-derived claims**.

```ts
// apps/waddling/lib/auth.ts  (added to the existing plugins[] from better-auth.md)
import { agentAuth } from "@better-auth/agent-auth";

agentAuth({
  providerName: "waddling",
  providerDescription: "Governed DuckLake analytics endpoints for AI agents.",
  modes: ["delegated", "autonomous"],
  // Capabilities mirror the External MCP tool surface — COARSE actions, NOT ACL grants.
  capabilities: [
    { name: "waddling_connect", description: "Open a governed session to an endpoint.",
      input: { type: "object", properties: { endpoint_id: { type: "string" } },
               required: ["endpoint_id"] } },
    { name: "waddling_query",   description: "Run a governed read/write through the gateway.",
      input: { type: "object", properties: { session_id: { type: "string" }, sql: { type: "string" } },
               required: ["session_id", "sql"] } },
    { name: "waddling_describe", description: "Catalog discovery scoped to granted tables." },
  ],
  // We do NOT execute data-plane work here — onExecute only stamps identity onto the trace
  // and delegates to the existing control-plane REST. See "Flow" below.
});
```

### Capabilities ≠ birdshot ACL grants — keep the layers separate

| Layer | What it is | Where enforced | Lands in trace as |
|-------|-----------|----------------|-------------------|
| **AAP capability** | coarse action / MCP tool invoked (`waddling_query`) | control plane | span name / event name |
| **`acl_rule` + birdshot** | fine-grained table / column / row / window | gateway + birdshot | grant detail on the event |

Merging these is a design error. AAP says *"this agent invoked `waddling_query` on behalf
of user U in delegated mode"*; birdshot/`acl_rule` says *"…and `read` on `sales.orders`
was allowed."* Trace both; model them separately.

### JWT layering — the load-bearing decision

Two token issuers exist. **birdshot must not start verifying AAP JWTs.**

```
API key (sk_agent_…, long-lived)              ── Better Auth, control plane
   │  connect: resolve {org, agent}, AAP agentSession
   ▼
session JWT (RS256, id=agent:<id>, aud=gw:<endpoint>, 15m)  ── the data-plane token
   │  + NEW AAP claims:  mode, act (delegating user), cap (capability), aap_jti
   ▼
gateway / birdshot   ── verifies signature via /api/auth/jwks + denylist (UNCHANGED)
```

The session JWT remains the only token the gateway sees. AAP claims ride **inside** it as
extra fields, so the gateway/birdshot code does not change.

> ⚠️ **Verify before building:** confirm `@better-auth/agent-auth` signs off the *same*
> JWKS as the `jwt` plugin (`/api/auth/jwks`). If it mints from its own keypair, do **not**
> hand AAP tokens to the gateway — instead, read the AAP `agentSession` at the control
> plane and copy the relevant fields into the existing session-JWT `definePayload`. Either
> way birdshot's verification path is unchanged.

## Flow (delta from ARCHITECTURE.md §1.3, steps 1–5)

Only the **mint** and **record** steps change; the data path is identical.

1. Agent calls External MCP `waddling_connect` with `Authorization: Bearer sk_agent_…`.
2. MCP → control-plane REST `POST /api/cp/sessions`. Better Auth verifies the key →
   **AAP resolves the `agentSession`** → `{ agent: {id,name,mode,capabilityGrants},
   user: <delegating human|autonomous> }`. Policy compiler evaluates `acl_rule`, mints the
   session JWT **with AAP claims** (`mode`, `act`, `cap`, `aap_jti`), records the connect.
3–4. Unchanged: `attach_sql` returned; `waddling_query` forwarded over quack; birdshot
   table-gates; gateway proxy applies column/row/window.
5. MCP records `usage_event` + `audit_event` **now carrying agent name, mode, delegating
   user, capability, and `aap_jti`** (see schema below).

## Tracing — the payoff

### PostHog (extends posthog.md §3 group analytics)

```ts
// distinctId = the AGENT principal, not the human; delegating human + org as properties/groups
posthog.capture({
  distinctId: `agent:${agentSession.agent.id}`,
  event: "waddling_query",                    // = the AAP capability
  properties: {
    agent_name:  agentSession.agent.name,
    agent_mode:  agentSession.agent.mode,     // 'delegated' | 'autonomous'
    on_behalf_of: agentSession.user.id,       // the delegating human (delegated mode)
    capability:  "waddling_query",
    aap_jti:     jti,
    // birdshot/ACL detail stays separate (different layer):
    tables: granted.tables, verbs: granted.verbs, row_limit: granted.row_limit,
    query_type: "SELECT",                     // NEVER raw SQL — see posthog.md §6
  },
  groups: { organization: orgId },
});
// Register the agent as its own identity so the agent timeline is queryable:
posthog.identify({ distinctId: `agent:${agentSession.agent.id}`,
  properties: { $set: { agent_name: agentSession.agent.name, agent_mode: agentSession.agent.mode,
                        delegated_by: agentSession.user.id } } });
```

This makes "show me every action this agent took, who delegated it, and in what mode" a
one-filter PostHog query — and keeps agent vs. human timelines distinct.

### Distinguishing one agent from many under the same user (cardinality)

**Critical finding (verified June 2026): Claude gives you no per-agent or per-conversation
identity over the wire. You must manufacture it via the credential.**

- Claude Desktop & Claude Code authenticate with a **product-level shared `client_id`**
  (CIMD, not per-install DCR). `client_id` distinguishes Desktop-vs-Code and nothing finer —
  every Claude Desktop globally presents the same one.
- Claude does **not** echo `MCP-Session-Id` ([claude-code#41836](https://github.com/anthropics/claude-code/issues/41836))
  and sends **no conversation/instance identifier** — only `user-agent: Claude-User`,
  `mcp-protocol-version`, and W3C `traceparent`/`baggage`.

So over the **OAuth/delegated path the finest identity Claude hands you is `user.id`**: two
concurrent conversations in the same Claude Desktop from the same human are
**indistinguishable** above the session level. Delegated mode answers *"which human?"* — not
*"which agent?"*

| Trace question | Delegated (OAuth) | Autonomous (API key) | Always-on |
|---|---|---|---|
| Which human? | ✅ `agentSession.user` | ⚠️ key creator | — |
| **Which agent?** | ❌ product-level `client_id` only | ✅ **`agent.id` per key (user-controlled)** | — |
| Which connection/run? | — | — | ✅ `agent_session.id` / JWT `jti` |
| Which conversation? | ❌ Claude sends nothing | ❌ Claude sends nothing | — |

**Consequence — per-agent identity is a *provisioning* decision, not a wire fact:**
1. **One API key per logical agent** (autonomous mode) is the only path to durable,
   user-meaningful per-agent identity. API-key `metadata.agent` → `agent.name`. Reusing one
   key across many agents collapses them irreversibly. This makes the **API-key path the
   *strong* tracing path** for cardinality — the inverse of the delegated path's strength.
2. **Session is the always-unique grain.** Every `connect` → new `agent_session.id` + `jti`.
   Use it for per-connection tracing; note one conversation may span several sessions
   (reconnect after TTL) with nothing to stitch them.
3. Best-effort only: log `traceparent` opportunistically. Undocumented for conversation
   correlation — don't build on it.

PostHog `distinctId`: autonomous = `agent:<agent_id>` (meaningful); delegated = best
available is `agent:<user_id>@<client_product>` (coarse). Always attach `agent_session_id`
+ `jti` as event properties so a single agent's events break down by run.

### Audit / usage events (additive columns)

`waddling.audit_event` and `waddling.usage_event` already key on `agent_id`/`session_id`.
Add (nullable, additive — no FK to Better Auth tables per the §2 cross-schema rule):

```sql
ALTER TABLE waddling.audit_event
  ADD COLUMN agent_mode    TEXT,    -- 'delegated' | 'autonomous'
  ADD COLUMN on_behalf_of  TEXT,    -- delegating auth.user.id (NULL for autonomous)
  ADD COLUMN capability    TEXT,    -- AAP capability invoked
  ADD COLUMN aap_jti       TEXT;    -- correlate to the AAP token / approval record
-- mirror on waddling.usage_event as needed
```

## MCP client compatibility — Claude Desktop & Claude Code

**Verdict: compatible, and AAP's two modes map cleanly onto the two auth paths these
clients support — but the *delegated* (browser-consent) path requires adding Better Auth's
`mcp` plugin, which the current spec does not yet include.**

Claude Desktop and Claude Code (remote streamable-HTTP / SSE servers) support **two**
ways to authenticate, per the MCP Authorization spec (OAuth 2.1, MCP spec `2025-11-25`):

| Claude auth path | How the user sets it up | AAP mode it feeds | Agent identity | Delegating human |
|---|---|---|---|---|
| **Static bearer header** | `claude mcp add --transport http waddling <url> --header "Authorization: Bearer sk_agent_…"` (Code); custom header (Desktop); `authorization_token` (API) | **autonomous** | the API-key-bound `waddling.agent` | key creator (or none) |
| **OAuth 2.1 browser consent** | Click connect → browser opens → user logs into waddling (Better Auth) → consents | **delegated** | the registered OAuth client (DCR `client_name`, e.g. "Claude Desktop") → a `waddling.agent` | the human who just consented = `agentSession.user` |

**Today's spec already works with both clients via the static-header path** — `sk_agent_…`
in a Bearer header is exactly what §4 documents (`WADDLING_API_KEY`). That covers
autonomous mode with zero changes.

**The delegated, human-in-the-loop path — the one that makes "who delegated this agent"
real — requires the OAuth handshake**, which Claude drives automatically:
1. Claude hits the MCP server unauthenticated → server returns `401` +
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
2. Claude discovers the auth server (`/.well-known/oauth-authorization-server`), registers
   via **DCR** (RFC 7591) — or a pre-registered client — and runs **Authorization Code +
   PKCE (S256, mandatory)**, binding the token to the MCP server via **Resource Indicators**
   (RFC 8707, `aud` = the MCP server URL).
3. Browser opens, user logs into waddling + consents, Claude gets the token, sends
   `Authorization: Bearer <token>` on every request. On 401/`insufficient_scope` it
   re-runs step-up auth.

Better Auth ships exactly this server side — **but it lives in the `mcp` plugin /
`@better-auth/oauth-provider`, not in `agent-auth`**:
`mcpAuth.discoveryHandler()`, `mcpAuth.protectedResourceHandler(url)`,
`oAuthDiscoveryMetadata(auth)`, and `mcpHandler(...)` (verifies the Bearer token, emits the
`WWW-Authenticate: resource_metadata` header Claude needs). DCR is supported
(`authClient.oauth2.register`, public clients via `token_endpoint_auth_method: "none"`).

> **Required addition:** to support delegated mode, mount the `mcp` plugin on
> `packages/mcp-external` and expose `/.well-known/oauth-protected-resource` +
> `/.well-known/oauth-authorization-server`. `agent-auth` provides the *identity/capability*
> model; the `mcp` plugin provides the *OAuth handshake Claude speaks*. They compose —
> AAP's `/.well-known/agent-configuration` is a third, non-colliding discovery doc.

### The three-token invariant (do not collapse these)

Claude's mandatory **audience binding** (RFC 8707) makes this unavoidable, and it *confirms*
Strategy A's layering — there are **three** distinct credentials, each with its own audience:

```
1. Claude  ──Bearer──▶  MCP server     OAuth access token, aud = <MCP server URL>   (verified by mcpHandler)
2. MCP svr ──REST────▶  control plane  resolves agentSession + mints…
3. MCP svr ──quack───▶  gateway        session JWT, aud = gw:<endpoint_id>, 15m      (verified by birdshot via JWKS)
```

- **Never hand Claude's MCP token (#1) to the gateway.** Its audience is the MCP server, not
  `gw:<endpoint>`; birdshot would (correctly) reject it. The gateway token (#3) stays
  internally minted, exactly as the spec already defines.
- The MCP server must **accept both credential types on path #1**: a Better Auth API key
  (`verifyApiKey` → autonomous) *or* an OAuth access token (`verifyAccessToken` → delegated).
  Branch on the token shape; resolve the AAP `agentSession` either way; the rest of the flow
  (mint #3, trace, audit) is identical.

### Recency caveats (verified June 2026)
- Claude clients target MCP spec `2025-11-25`; API beta header `mcp-client-2025-11-20`.
- **PKCE S256 is mandatory**; server metadata must advertise `code_challenge_methods_supported`.
- DCR is a supported fallback; **Client ID Metadata Documents (CIMD)** are Claude's *preferred*
  registration. Better Auth supports DCR + public clients today — sufficient; CIMD support is a
  nice-to-have to confirm, not a blocker.
- MCP connector via the Messages API supports **tools only** (not resources/prompts) — fine,
  waddling's surface is all tools.

## Implemented — one-key-per-agent enforcement + identity threading

Shipped natively (no new npm dependency; the AAP *model* is adopted, our schema is the
implementation — Strategy A). The `@better-auth/agent-auth` + `mcp` plugins remain a
**phase-2** add (delegated OAuth + `/.well-known/agent-configuration`); not wired into
`auth.ts` yet to avoid an uninstalled-import build break.

- **Migration** `packages/control-schema/migrations-003-agent-auth.sql`:
  - `agent_api_key_unique` — one Better Auth key backs at most one `waddling.agent`.
  - `waddling.agent.mode` (`autonomous`|`delegated`, default autonomous).
  - `agent_session.origin` (`agent`|`run-as`) + `superseded` status.
  - `agent_session_one_active_per_agent` — partial unique index: **one live session per
    agent for `origin='agent'`** (dashboard run-as inspection is exempt).
  - `audit_event` / `usage_event` gain `agent_mode`, `on_behalf_of`, `capability`.
- **`apps/waddling/src/lib/agent-identity.ts`** — `resolveAgentIdentity(agentId)`
  (id, name, mode, on-behalf-of = API-key owner) + `captureAgentEvent` PostHog helper
  (`distinctId = agent:<id>`, org group). `CAPABILITY` constants (coarse actions).
- **`api/cp/sessions` POST** — the resolve-and-restamp + enforcement point:
  - `origin = agent` (API-key caller) vs `run-as` (dashboard user).
  - Reap expired → apply `WADDLING_AGENT_SESSION_POLICY` (`supersede` default | `reject`):
    supersede kills the prior live session (gateway jti revoke + `superseded`); reject 409s.
    The unique index is the race backstop → `409 agent_session_in_use`.
  - Stamps `{ mode, cap, act }` into the session JWT (id/sub still `agent:<id>`; gateway
    ignores extras — verified `gateway/src/jwt.ts` reads only `id`/`sub`/`aud`/`jti`).
  - Enriched `audit_event` (attach + supersede) and `captureAgentEvent` for connect.
- **`api/cp/agents`** — sets `mode='autonomous'`; surfaces the 1:1 key violation
  (`api_key_in_use`); `AgentSummary.mode` returned. Types: `AgentMode`, `AgentIdentity`.

Net cardinality guarantee: for real agent connections, **one API key = one live session at
a time**, so every trace row maps to exactly one agent instance. Genuine key-sharing shows
up as supersede thrash (`agent_session_superseded` events) or `409`s — a detectable signal,
not silent collapse.

## Implemented — delegated mode via the Better Auth `mcp` plugin (OAuth 2.1)

The `mcp` plugin ships in the installed `better-auth/plugins` (no new dependency).

**Control plane = OAuth authorization server:**
- `auth.ts` adds `mcp({ loginPage: '/sign-in' })` → DCR + PKCE authorize/token +
  discovery under `/api/auth/*`. Adds `oauthApplication`/`oauthAccessToken`/
  `oauthConsent` tables — **re-run Better Auth `getMigrations()` after deploy.**
- `next.config.mjs` rewrites root `/.well-known/oauth-authorization-server` →
  `/api/auth/.well-known/…` (Claude probes the root).
- `resolveCaller` (`_shared.ts`) gains an OAuth branch: a non-`sk_` Bearer is verified
  via `verifyAccessToken({ verifyOptions:{issuer,audience}, jwksUrl })`. **Secure by
  default** — `allowDelegated=false` everywhere except the data-plane routes that opt
  in. Returns the consenting human (`kind:'user'`, `delegated:true`, `clientId`).
- **`jwksUrl = <auth>/api/auth/jwks`** — the same central JWKS the gateway uses, which
  resolves the long-open "same keys?" question: yes, one JWKS.

**`mcp-external` = OAuth resource server:** serves `/.well-known/oauth-protected-resource`
(points at the control plane) and, when `WADDLING_MCP_OAUTH=1`, returns `401 +
WWW-Authenticate: resource_metadata=…` on a no-credential request (off by default so
anonymous device-link onboarding still works). Forwards the bearer unchanged.

**Delegated identity + the one-key-per-agent interaction (advisor blocker, fixed):**
- The sessions-connect route provisions a delegated agent idempotently
  (`INSERT … ON CONFLICT (org_id,name)`, name `claude:<userId>`, `mode='delegated'`,
  `api_key_id` NULL), after checking the human is a member of the endpoint's org.
- Sessions get **`origin='delegated'`** (migration-004) → **exempt** from the
  one-active-per-`(agent,endpoint)` index. Two concurrent Claude chats from the same
  human coexist instead of killing each other (Claude exposes no per-instance id).
- Data-plane routes opened to delegated callers: sessions connect/query, endpoints
  list, describe. Management routes (acl/agents/audit/usage/billing/settings/…) refuse
  delegated tokens (`delegated_not_allowed`).

**Audience is the security boundary (RFC 8707):** the control plane verifies
`audience = WADDLING_MCP_RESOURCE` (the mcp-external public URL). Since mcp-external
forwards the bearer blind, this is the only chokepoint against token redirection —
never widen it. `env.ts` adds `getMcpResourceUrl()`.

**Env:** `WADDLING_MCP_RESOURCE` (control plane + mcp-external, must match);
`WADDLING_MCP_OAUTH=1` (mcp-external, enable the 401 challenge).

**Verified:** all packages typecheck; `mcp` plugin loads into the betterAuth config.
**Not yet run end-to-end** (dev stack was down): the browser consent → token → connect
flow, and `getMigrations` creating the OAuth tables. See verification steps below.

**Known limitation:** delegated callers on list/describe scope to the user's *first*
org membership (`resolveCaller`); connect/query are correct for any org (membership
checked against the chosen endpoint/session). Multi-org delegated list/describe = follow-up.

### Migrations & dev bring-up
- **`pnpm db:migrate`** (`scripts/migrate.ts`) is the single "make the control DB current"
  command: applies `schema.sql` + every `migrations-NNN-*.sql`, then Better Auth
  `getMigrations()` — which **creates the OAuth tables** (`oauthApplication`/
  `oauthAccessToken`/`oauthConsent`). Idempotent. (Verified end-to-end on a fresh PGlite:
  all three tables created.) Needs `DATABASE_URL`; runs under `SKIP_ENV_VALIDATION=1` so
  `lib/auth` imports without real Stripe creds (`getStripeWebhookSecret` now falls back).
- **`pnpm dev`** (`run-local.sh`) now: binds the lake + control-plane Postgres to **open
  ports** (no fixed 5470/5432 collisions; reuses a running lake container's port),
  **migrates then seeds the control DB before the app starts**, and exports
  `WADDLING_MCP_RESOURCE` + `WADDLING_MCP_OAUTH=1` to mcp-external. `DATABASE_URL` is passed
  inline to `next dev`, so the app always uses the freshly-seeded port (Next won't override
  an already-set `process.env`).

### Verify the OAuth flow (stack up via `pnpm dev`)
1. `curl localhost:3100/.well-known/oauth-authorization-server` → JSON metadata.
2. `curl localhost:8810/.well-known/oauth-protected-resource` (mcp-external) → resource doc.
3. In Claude: add the remote MCP server URL → browser consent → confirm `verifyAccessToken`
   accepts the token (issuer/jwks/audience line up) → `waddling_connect` opens a
   `origin='delegated'` session.

## Open decisions for mirri

1. **Strategy A (recommended) vs. B.** A = AAP enriches identity/tracing, data plane
   untouched (this doc). **B** = AAP *replaces* the API-key flow: `waddling_connect/query`
   become AAP capabilities executed in `onExecute`, the External MCP server is rebuilt on
   AAP's MCP adapter. B is more unified but rewrites `packages/mcp-external` and re-treads
   the token model your security audit already validated. Recommend A now, revisit B later.
2. **Autonomous principal.** For autonomous agents, what does `resolveAutonomousUser`
   return — a synthetic per-org service user, or null with `on_behalf_of` omitted? Affects
   PostHog identity stitching.
3. **Phase 2 scope.** Adopt device/CIBA approval + `/.well-known/agent-configuration`, or
   keep onboarding on the existing dashboard-issues-API-key flow?
4. **MCP delegated mode** — add the Better Auth `mcp` plugin to `packages/mcp-external`
   (OAuth discovery + protected-resource endpoints) so Claude's browser-consent flow works?
   Required for delegated mode; static-API-key autonomous mode already works without it.
5. **Ratify** the `@better-auth/agent-auth` (+ `mcp` plugin) dependency and the four
   `audit_event` columns in ARCHITECTURE.md before implementation.
