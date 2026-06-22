# Full-funnel E2E proof (ANO-100)

Proves the money + product path end-to-end against a **deployed** environment:
**signup → pay (test-mode Stripe) → provision → governed query → debit**, plus the
**star-schema** load is queryable through the product. Scope = subscription + the
existing session/query debit; credit-pack purchase + balance-zero cutoff are a tracked
fast-follow (ANO-69/70) and are not asserted here.

Two artifacts, run together:

1. **`full-funnel.mjs`** — a reproducible HTTP harness (the durable gate). Drives the
   live API and asserts backend state.
2. **Browser-driven signup** (Claude-in-Chrome, or by hand) — completes the Stripe
   Checkout (test card) and proves the **cross-subdomain identity stitch** that single-
   origin HTTP can't: one PostHog Person carrying both a `getwaddling.com` `$pageview`
   and the post-signup `signup_completed` / `checkout_completed`.

## Prerequisites (the "stop point" — operator supplies these)

Deploy with real **test-mode** keys set (see the secrets manifest in the plan), then:

- A **sandbox Stripe product** "Waddling Pro" with a monthly recurring price →
  `STRIPE_PRICE_PRO` (create in the Stripe test dashboard, or:
  `stripe products create --name "Waddling Pro"` then `stripe prices create --product <id> --unit-amount 9900 --currency usd --recurring interval=month`).
- The deployed **Stripe webhook endpoint** registered at
  `https://<api-host>/api/auth/stripe/webhook` with its signing secret →
  `STRIPE_WEBHOOK_SECRET`.
- An analytics **agent key** (`sk_agent_…`) scoped to a lake, for the query assertions,
  and a lake id (or `CREATE_DATALAKE=1`).

## Run the HTTP harness

```bash
export CONTROL_API_BASE="https://api.getwaddling.com"
export WEB_ORIGIN="https://app.getwaddling.com"

# governed-query assertions (optional but recommended):
export DATALAKE_ID="<an existing running lake>"        # or: export CREATE_DATALAKE=1
export AGENT_KEY="sk_agent_…"
export IN_SCOPE_SQL="SELECT 1"                          # something the agent is granted
export OUT_OF_SCOPE_SQL="SELECT * FROM lake.secret.t"   # something it is NOT granted
export STAR_JOIN_SQL="SELECT et.stage_category, count(*) FROM lake.marketing.fct_funnel_event f JOIN lake.marketing.dim_event_type et ON f.event_type_key = et.event_type_key GROUP BY 1"

# Stripe: pause for a browser to complete Checkout (test card 4242 4242 4242 4242),
# then poll until the subscription is active:
export WITH_STRIPE=poll          # or 'skip' to assert only that the Checkout URL mints

node scripts/e2e/full-funnel.mjs
```

Exit 0 = all assertions passed. The script prints the Checkout URL to open when
`WITH_STRIPE=poll`.

## Browser-driven signup (the visual + identity-stitch proof)

1. Visit `https://getwaddling.com` (marketing) — generates an anonymous `$pageview`
   on the `.getwaddling.com` cookie.
2. Click a CTA → land on `app.getwaddling.com/sign-up`, create the fake account
   (`identify()` fires → anon person merges into the new user id).
3. Dashboard → Billing → **Upgrade to Pro** (fires `checkout_started` server-side) →
   complete Stripe Checkout with test card `4242 4242 4242 4242`, any future expiry/CVC.
4. Back on the dashboard, confirm the plan flipped to **Pro** (the webhook →
   `checkout_completed`).
5. Connect an agent (MCP) and run a governed query → activation events
   (`mcp_connect`, `first_query`, `query_executed`).

## Verify in PostHog (events the harness can't see)

These fire server-side / client-side and are confirmed in PostHog, not by the harness:

- One **Person** has both a `getwaddling.com` `$pageview` and `signup_completed`
  (the cross-subdomain stitch — the make-or-break for the funnel).
- The conversion funnel **visit → signup → activation → paid** renders:
  `$pageview` → `signup_completed` → `first_query` → `checkout_completed`.

## Verify the star schema landed (through the product)

Run the pipeline once (`apps/pipelines`: cron tick or `GET /run?pipeline=posthog-funnel`),
then through `waddling_query` as the analytics agent:

```sql
SELECT stage_category, count(*)
FROM lake.marketing.fct_funnel_event
JOIN lake.marketing.dim_event_type USING (event_type_key)
GROUP BY 1 ORDER BY 2 DESC;
```

Re-running the pipeline must leave `fct_funnel_event`'s row count stable (idempotent
rebuild: uuid-dedup + `CREATE OR REPLACE` + deterministic md5 surrogate keys).

> **Assert run #2 actually rebuilt — don't trust the row count alone.** `CREATE OR
> REPLACE` is an implicit drop-then-create, so run #2 exercises the birdshot `drop`
> verb that run #1 never did. If the agent lacks `drop`, run #2 is **denied** and the
> previous tables persist unchanged — the row count stays stable for the WRONG reason
> and the idempotency check passes falsely. So when you run the pipeline the second
> time, confirm the `governed-load` step **succeeded**: `wrangler tail waddling-pipelines`
> should show the step completing with all six statements and **no**
> `AuthorizationDeniedError` (and the D1 cursor row's `last_status` = `ok`, not `error`).
> Only then does a stable row count prove idempotence. See the grant set (all four
> verbs) in `apps/pipelines/README.md`.
