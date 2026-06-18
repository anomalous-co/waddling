# Stage C — WorkspaceSandbox DO + Sandbox container (Model B)

Proves the **durable, encrypted, isolated per-agent DuckDB workspace** lifecycle on real
Cloudflare. Collapses the proven Rivet pieces (`gateway-rivet-poc/src/workspace-{sidecar,runner,actor,store}.ts`)
into one CF Durable Object.

## What runs

- **`container/`** — `docker.io/cloudflare/sandbox:0.12.1` + `@duckdb/node-api@1.5.3-r.3` +
  the adapted `workspace-sidecar.mjs`. No birdshot (gateway-side). No CMD (the base
  ENTRYPOINT is the SDK process-server). Image ≈ 292 MB.
- **`worker/`** — `WorkspaceSandbox extends Sandbox`. The DO is **pure c2** (Model B):
  it reads R2 S3-API creds from Secrets Store, mints short-lived single-object presigned
  R2 GET/PUT URLs (aws4fetch), and hands them to the sidecar over `/init`. The DO never
  touches the `.duckdb` bytes — the **sidecar** fetches/persists its own encrypted file
  with plain Node `fetch`.

## Run

```
curl https://cf-stagec-ws-probe.<account>.workers.dev/probe
```

Returns `{verdict:"WSDO-PASS"|"WSDO-FAIL", durability, snapshot, isolation, encryptedAtRest, fifo, deferred:["quack-lake-leg"], detail}`.

## Deploy-time caveats (cannot be validated locally)

1. **Container→R2 TLS trust (highest risk).** `interceptHttps=true` MITMs the container's
   outbound HTTPS with a per-instance **ephemeral CA** that the *system* trust store carries.
   Node's undici `fetch` verifies against Node's *own* bundled CA list and ignores the system
   store by default. Mitigation: the DO launches the sidecar with `node --use-system-ca`
   (Node 22+). If the deployed run shows a durability FAIL with a presigned-GET/PUT TLS error,
   this is the cause — fall back to `NODE_EXTRA_CA_CERTS=<system bundle>` or, for a throwaway
   probe, `NODE_TLS_REJECT_UNAUTHORIZED=0` on the sidecar launch (peer is a CF-internal proxy).
2. **Egress allowlist.** `setAllowedHosts([R2_HOST])` engaged at RUNTIME (the class field does
   NOT propagate — hop-probe finding). NO custom outbound handler for R2: an allowlisted host
   with no handler hits the SDK step-7 fallback (`fetch(request)` → real R2). The gateway-DO
   routing handler is a later step (the quack leg).
3. **ENCRYPTION_KEY** lives in the **Worker** (fixed 32-byte hex for the probe; control-api vends
   it in the real system). NOT in DO storage — session 2 uses a *fresh sandbox id* (different DO,
   different storage) to force a real restore-from-R2, so a DO-stored key would be unreachable.
   The R2 object key is constant across sessions, so both sessions hit the same object.
4. **Deferred: the quack→lake leg.** The `/init` contract carries optional `lakeProxy`/`lakeToken`
   and the ATTACH code path exists, but the probe never sends them (the gateway is infra-blocked).

## Validate (no deploy)

```
cd worker && npm install && npx wrangler types && npx tsc --noEmit && npx wrangler deploy --dry-run
```
