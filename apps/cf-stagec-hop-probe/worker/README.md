# Stage C lynchpin probe #1 — outbound → Durable-Object-binding hop

## What this proves

Stage 0 proved a `Sandbox`-subclass container's static `outbound` handler can
`return fetch(request)` (re-originate to the one allowlisted host) or
`return new Response(…,{status})` (block). It did **not** prove the handler can

```ts
return env.GATEWAY_DO.get(id).fetch(request);
```

— route the single allowlisted egress to an **internal Durable Object via a binding**
and have the **container actually receive the DO's response body**.

This is the lynchpin for the waddling CF data plane: if it passes, the real gateway can
be a **private internal DO** (never publicly exposed). If it fails, the gateway needs a
public `:443` host (the fallback).

**Scope:** this proves the request/response **binding hop** only. It does **not** prove
the quack wire protocol (streaming, long-lived ATTACH) survives the DO hop — that is a
Stage D concern. A `HOP-PASS` must not be over-read as "quack works through a DO".

## How it works

- `HopProbeSandbox extends Sandbox<Env>` carries the proven Stage 0 egress config
  verbatim: `enableInternet=false`, `interceptHttps=true`, allowlist engaged at
  **runtime** via `setAllowedHosts([GATEWAY_HOST])` (the class field did not propagate).
- Its `static outbound = async (request, env) => …` — for the one allowlisted host —
  routes to `env.GATEWAY_DO.get(idFromName("gw")).fetch(request)` instead of `fetch`.
- `GatewayStubDO extends DurableObject` stands in for the real gateway. Its `fetch`
  returns `OK-FROM-DO-BINDING:<path>` — the path echo proves the DO received the
  intercepted request intact.
- `GATEWAY_HOST = example.com` — a **DNS-resolvable** host (resolution happens before
  interception) whose **real** body is "Example Domain". Because the DO body is
  "OK-FROM-DO-BINDING", a pass unambiguously proves the handler short-circuited to the
  DO and the container never reached the real example.com.

### Verdict

- **`HOP-PASS`** iff `positiveBody` contains `OK-FROM-DO-BINDING`.
- Diagnosing a **`HOP-FAIL`** from the raw `positiveBody` (surfaced verbatim):
  - `Example Domain` → fell through to a **real** fetch (handler not registered /
    allowlist fallback) — the DO was never reached.
  - `CONN_FAIL` / 500 → the DO call **threw** (binding unreachable from the handler's
    proxy-entrypoint context).

### Negative test caveat

`example.org` (a different, non-allowlisted host) is blocked at the **allowlist gate**
inside `ContainerProxy.fetch` (status **520**, "Origin is disallowed") **before** the
handler runs — not by the handler's `else → 403` branch. Under a single-host allowlist
that 403 branch is effectively unreachable; we keep it as the deny default. The negative
therefore proves the allowlist gate, while the handler's DO short-circuit is exercised
by the **positive**.

## Why this needs a real deploy

The outbound handler runs in the runtime **sidecar** (`ContainerProxy` WorkerEntrypoint),
not locally — `wrangler dev` does not exercise the real interception path. The lone
residual risk is a platform I/O-context restriction on DO calls inside the proxy
entrypoint; source shows no such restriction, but only a deployed run confirms it.

## Deploy / run / teardown

```bash
cd apps/cf-stagec-hop-probe/worker
pnpm install            # or npm install
npx wrangler deploy

# Run the probe (replace <subdomain> with your workers.dev subdomain):
curl https://cf-stagec-hop-probe.<subdomain>.workers.dev/probe

# Expect: {"verdict":"HOP-PASS", "positiveBody":"OK-FROM-DO-BINDING:/hello", ...}

# Teardown:
npx wrangler delete
```
