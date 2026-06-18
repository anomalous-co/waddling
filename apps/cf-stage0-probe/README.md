# cf-stage0-probe — Cloudflare runtime probe (the migration gate)

A self-contained, throwaway probe that de-risks re-homing the waddling **data plane**
on Cloudflare (Durable Object + Cloudflare Sandbox/Container running our DuckDB
workspace sidecar) **before** any rewrite. It mirrors the discipline of the earlier
`packages/gateway/step0-probe.mjs`: prove the unknowns empirically.

## The four probes (risk order)

| # | Question | Where it runs | Status here |
|---|----------|---------------|-------------|
| 1 | quack `ATTACH … :443` works under the container egress allowlist while all other egress is blocked | **real CF deploy only** | **PENDING (cloud)** — `worker/` |
| 2 | DuckDB v1.5.3 + quack + httpfs (and birdshot) load in the container image | Docker (linux/amd64) | quack/httpfs **PASS**; birdshot **PENDING** (CDN unreachable here) |
| 3 | isolation levers identical in-container (s3/http blocked "by configuration"; unsigned off; lever irreversible; **lake token unreadable**; **env secret-free**) | Docker | **PASS (15/15)** |
| 4 | native encryption + cross-container file round-trip (R2 stand-in) | Docker | **PASS** |

Probe #1 is **the hard gate**: if it fails, "re-home the data plane on CF" does not
hold. It is also the one probe that **cannot be run locally** (local dev does not
enforce the platform egress restriction), so its verdict is **GO-PENDING-CLOUD** until
the user deploys `worker/`.

## Layout

```
container/                     one linux/amd64 image, FROM docker.io/cloudflare/sandbox:0.12.1
  Dockerfile                   (base required so the Sandbox SDK can drive the container)
  package.json                 @duckdb/node-api 1.5.3-r.3 (pulls linux-x64 glibc prebuilt)
  sidecar.mjs                  probe-local copy of gateway-rivet-poc/src/workspace-sidecar.ts
  probe.mjs                    in-container harness for probes #2/#3/#4 (full + reopen modes)
  birdshot-check.mjs           probe #2 birdshot half (de-risks the future gateway image)
run-local-probes.sh            builds the image + runs probes #2/#3/#4 (NO cloud needed)
worker/                        probe #1 — THE GATE (deploy to Cloudflare)
  src/index.ts                 Sandbox subclass: enableInternet=false + allowedHosts + outbound proxy
  wrangler.jsonc               containers + DO + migrations.new_sqlite_classes
  README.md                    EXACT deploy + verify commands; why the verdict is PENDING
```

## Run the local probes (no Cloudflare account)

```bash
cd apps/cf-stage0-probe
./run-local-probes.sh
```

Requires Docker (builds for `linux/amd64`; on Apple Silicon this uses emulation).

## Run the gate (Cloudflare account)

See `worker/README.md` for the exact `wrangler login` / `secret put` / `deploy` /
`curl …/probe` sequence and how to read PASS vs FAIL.

## Notes / divergences (probe-only)

- `container/sidecar.mjs` is a behavioural copy of `workspace-sidecar.ts` with
  `normalize` inlined (the real file imports it from `packages/gateway/src/duck.ts`,
  a workspace dependency chain we don't drag into a standalone image) and as `.mjs`.
  **Stage C keeps `workspace-sidecar.ts` unchanged as the container entrypoint** — this
  copy exists only to make the probe image self-contained.
- birdshot runs in the **gateway** only; the sidecar loads quack+httpfs, not birdshot.
  `birdshot-check.mjs` de-risks the *future* gateway image, not the sidecar.
