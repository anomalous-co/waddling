# Stage 0 Probe #1 — the egress gate (Cloudflare deploy required)

This Worker proves the single load-bearing unknown of the whole Cloudflare re-home —
the **egress shape**:

> A containerized process inside a `Sandbox` subclass can reach exactly **one
> allowlisted host over HTTPS:443**, while **every other host is blocked** and **any
> non-443 egress is denied**.

If this fails, "re-home the data plane on Cloudflare" does not hold and Stages A–E
should be reassessed. It is the hard gate, and it is the **one probe that cannot run
locally** (local dev does not enforce the platform egress restriction) — so its
verdict is only authoritative on a real deploy.

## Scope: egress shape, not quack protocol

The gate is about *which host / which port* leaves the container — protocol-agnostic.
A plain HTTPS GET fully exercises the mechanism (`allowedHosts` + the `outbound`
handler + `enableInternet=false`). So the allowlisted target is a **trivial stub
Worker** (`../gateway-stub/`) that returns the known body `OK-GATEWAY-STAGE0`. Whether
that host speaks the **quack** protocol over TLS depends on the gateway container,
which does not exist until **Stage D** — so the probe also runs a quack `ATTACH` as an
explicitly-labeled "Stage D follow-through" that is **expected to fail** against the
non-quack stub. Conflating the two would test "does a dumb HTTPS server speak quack,"
not egress shape.

## Prerequisites

- A Cloudflare account with **Containers** + **Durable Objects** enabled (Containers
  may require a paid plan / beta entitlement; a deploy that fails on entitlement is
  BLOCKED-ON-ACCOUNT, not a gate failure — capture the exact error).
- Docker running locally (wrangler builds the linux/amd64 container image at deploy).

## Exact commands

```bash
# 1. Deploy the trivial allowlisted-gateway stub FIRST and note its hostname.
cd apps/cf-stage0-probe/gateway-stub
npm install
npx wrangler deploy          # prints https://cf-stage0-gateway-stub.<subdomain>.workers.dev

# 2. Deploy the probe Worker (builds ../container/Dockerfile for linux/amd64,
#    pushes to the CF registry, deploys Worker + the Sandbox DO). GATEWAY_HOST is
#    fully env-driven, so inject the stub host with --var — NO file edit needed
#    (host only, no scheme/port):
cd ../worker
npm install
npx wrangler secret put LAKE_TOKEN   # any value; only used by the Stage D follow-through
npx wrangler deploy --var GATEWAY_HOST:cf-stage0-gateway-stub.<subdomain>.workers.dev

# 3. Run the gate.
curl -s https://cf-stage0-probe.<subdomain>.workers.dev/probe | jq
```

## Reading the result

Top-level `verdict` is `EGRESS-GATE-PASS` or `EGRESS-GATE-FAIL`. It is PASS iff:

- **`positive`** — the allowlisted host on HTTPS:443 returns `HTTP_200` **and** the
  known body `OK-GATEWAY-STAGE0` is present (proves the container actually reached the
  stub). `-k` is used so a strict-TLS failure (the `strict TLS` line) is recorded as a
  CA-trust data point, **not** counted as an egress failure.
- **`negative`**:
  - non-allowlisted host `example.com` HTTPS:443 → **blocked** (not `HTTP_2xx`).
  - allowlisted host on **port 8443** → **`CONN_FAIL`** (with `enableInternet=false`,
    only 80/443 leave the container at all).
- **`stageD_followthrough_quack_attach`** — informational only; the quack ATTACH is
  expected to fail vs the stub. NOT part of the verdict.

### If the POSITIVE fails — distinguish three cases (not an instant NO-GO)

1. **`positive` strict-TLS fails but `-k` reaches `HTTP_200`** → CA-trust artifact, not
   an egress failure. The Sandbox injects an ephemeral interception CA; curl just
   doesn't trust it. The gate still PASSES on the `-k` result.
2. **`positive` `-k` also fails (CONN_FAIL) under `enableInternet=false`** → the
   `outbound` handler may not re-originate egress under `enableInternet=false`. Set
   `enableInternet = true` in `src/index.ts` (keep `allowedHosts`), redeploy, re-run.
   CAVEAT: with `enableInternet=true` the **non-443-port negative weakens** (allow/deny
   filter HTTP only) — report that. Do not oscillate; one flip.
3. **`-k` reaches the host but the gate still can't be made to pass after 1–2** → that
   is the true **NO-GO** for "single-host HTTPS egress under CF control"; reassess A–E.

## Teardown (do after recording the result)

```bash
npx wrangler delete                              # in worker/  → removes Worker + DO + container image
cd ../gateway-stub && npx wrangler delete        # removes the stub
# the LAKE_TOKEN secret is deleted with the Worker.
```

## What this shares with the offline probes

The container image (`../container/Dockerfile`, `FROM docker.io/cloudflare/sandbox:0.12.1`)
is the **same** image proven by `../run-local-probes.sh` for probes #2/#3/#4 — so the
extension load, isolation posture, and encryption are already validated on this exact
base; the deploy only adds the egress-shape proof.
