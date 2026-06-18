// Stage C lynchpin probe #1 — the OUTBOUND → DURABLE-OBJECT-BINDING HOP.
//
// THE QUESTION. Stage 0 proved a `Sandbox`-subclass container's static `outbound`
// handler can `return fetch(request)` (re-originate to the one allowlisted host) or
// `return new Response(...,{status})` (block). It did NOT prove the handler can
//     return <DurableObject-binding>.get(id).fetch(request)
// i.e. route the single allowlisted egress to an INTERNAL Durable Object via a
// binding and have the CONTAINER actually receive the DO's response body. If it can,
// the real waddling gateway can be a PRIVATE internal DO (never publicly exposed); if
// it can't, the gateway needs a public :443 host. This probe answers exactly that.
//
// WHY IT SHOULD PASS (source-level argument, stronger than the type analysis).
// @cloudflare/containers@0.3.5 `ContainerProxy.fetch` invokes the static handler as
//   handlers[name](request, this.env, ctx)            // container.js:252
// where `this.env` is the ContainerProxy WorkerEntrypoint's LIVE env — it holds every
// configured binding, including GATEWAY_DO. `setAllowedHosts()` forces interceptAll
// (effectiveAllowedHosts !== undefined → shouldInterceptAllOutbound true,
// container.js:1124), so for the allowlisted host the flow reaches line 252 and our
// handler fires (rather than the per-host direct-fetch shortcut). Stage 0 ALREADY
// proved a handler-RETURNED Response body reaches the container's curl (the
// "OK-GATEWAY-STAGE0" body came back through the intercepted tunnel). A DO-sourced
// Response is the same object on the same return path. The ONLY genuinely new thing
// here is whether `env` holds a *live, callable* DO binding in that context — which
// source confirms but only a deployed run can verify (a platform I/O-context
// restriction on DO calls inside the proxy entrypoint is the lone residual risk).
//
// SCOPE. This proves the request/response BINDING HOP only. It does NOT prove the
// quack wire protocol survives the DO hop (streaming, long-lived ATTACH) — that is a
// Stage D concern. A HOP-PASS must not be over-read as "quack works through a DO".
//
// TLS. interceptHttps=true is REQUIRED for any HTTPS:443 egress path (Stage 0
// finding). The container trusts the ephemeral per-instance CA, but `curl -k` is used
// anyway so a CA-trust artifact is never mistaken for a hop failure.

import { getSandbox, Sandbox, ContainerProxy } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

// Required when using outbound interception: the SDK routes intercepted container
// egress through this WorkerEntrypoint, so it must be exported from the Worker.
export { ContainerProxy };

interface Env {
  Sandbox: DurableObjectNamespace<HopProbeSandbox>;
  GATEWAY_DO: DurableObjectNamespace<GatewayStubDO>;
  // The single host the workspace container is allowed to reach. Host only, no
  // scheme/port. MUST be DNS-RESOLVABLE: DNS resolution happens BEFORE interception,
  // so a made-up name fails at resolve, not at the handler. We use `example.com`
  // whose REAL body ("Example Domain") is distinguishable from the DO body
  // ("OK-FROM-DO-BINDING") — so a pass unambiguously proves the handler
  // short-circuited to the DO and the container never reached the real example.com.
  GATEWAY_HOST: string;
}

// The internal gateway stand-in. In production this is the real waddling gateway DO,
// reachable ONLY via its binding — never publicly exposed. Its fetch echoes the
// request path so a pass proves the DO received the intercepted request intact, not
// merely that "some DO answered".
export class GatewayStubDO extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    return new Response("OK-FROM-DO-BINDING:" + new URL(req.url).pathname, {
      status: 200,
    });
  }
}

export class HopProbeSandbox extends Sandbox<Env> {
  // Deny-by-default egress, carried over VERBATIM from the proven Stage 0 config.
  enableInternet = false;
  // HTTPS (443) is only routed through the outbound handler/allowlist chain when this
  // is true. Required for any HTTPS:443 egress path.
  interceptHttps = true;
  // EMPIRICAL Stage 0 finding: this class field did NOT propagate to the
  // ContainerProxy — the allowlist must be engaged at RUNTIME via setAllowedHosts()
  // on the running instance (done in runProbe before any egress). Kept here only so
  // the host lives in one place (env.GATEWAY_HOST) and for documentation.
  allowedHosts: string[] = [];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    if (env.GATEWAY_HOST) this.allowedHosts = [env.GATEWAY_HOST];
  }

}

// Register the outbound handler the SDK way. A `static outbound = …` class FIELD (the
// Stage-0 pattern) defines an OWN property and BYPASSES the inherited
// `static set outbound`/`outboundHandlers` accessor that populates the dispatch
// registry (container.js outboundHandlersRegistry). With an empty registry the
// handler never runs, and an allowlisted host falls through to the step-7 "allowed
// host → real internet" fallback — which is exactly why the first run returned the
// real example.com page. Registering via the setter (below) + engaging it per-host at
// runtime (setOutboundByHost, in runProbe) is what actually wires it. The handler
// receives the live ContainerProxy `env` as its 2nd arg, so GATEWAY_DO is callable
// here — routing the one allowlisted egress to the INTERNAL gateway DO via its binding.
(HopProbeSandbox as unknown as {
  outboundHandlers: Record<string, (request: Request, env: Env) => Promise<Response>>;
}).outboundHandlers = {
  toGateway: async (request: Request, env: Env): Promise<Response> => {
    const host = new URL(request.url).hostname;
    if (env.GATEWAY_HOST && host === env.GATEWAY_HOST) {
      const id = env.GATEWAY_DO.idFromName("gw");
      return env.GATEWAY_DO.get(id).fetch(request);
    }
    return new Response(`blocked ${host}`, { status: 403 });
  },
};

async function runProbe(env: Env): Promise<Response> {
  const gw = env.GATEWAY_HOST;
  const sandbox = getSandbox(env.Sandbox, "hop-probe-v2");

  // Engage deny-by-default egress at RUNTIME (the documented API + Stage 0 finding):
  // forces interceptAll so the allowlisted host reaches our static outbound handler.
  let allowSet = "ok";
  try {
    await (sandbox as unknown as { setAllowedHosts(h: string[]): Promise<void> }).setAllowedHosts([gw]);
  } catch (e) {
    allowSet = "FAILED: " + (e instanceof Error ? e.message : String(e));
  }
  console.log(`[hop-probe] setAllowedHosts([${gw}]) -> ${allowSet}`);

  // Route the allowlisted host to the registered `toGateway` handler at RUNTIME. This
  // populates outboundByHostOverrides → ContainerProxy.fetch step 3 invokes the
  // handler for this host (which runs regardless of interceptAll mode), so the DO hop
  // fires instead of the allowed-host internet fallback.
  let routeSet = "ok";
  try {
    await (sandbox as unknown as { setOutboundByHost(h: string, m: string): Promise<void> }).setOutboundByHost(gw, "toGateway");
  } catch (e) {
    routeSet = "FAILED: " + (e instanceof Error ? e.message : String(e));
  }
  console.log(`[hop-probe] setOutboundByHost(${gw}, toGateway) -> ${routeSet}`);

  // ── POSITIVE (the hop): the ONE allowlisted host on HTTPS:443. The handler must
  // short-circuit to the DO binding, so the body MUST be the DO's echo, NOT the real
  // example.com page. `|| echo CONN_FAIL` distinguishes a thrown DO call / no
  // connection from a returned body.
  const pos = await sandbox.exec(
    `curl -s -k --max-time 10 https://${gw}/hello || echo CONN_FAIL`,
  );
  const positiveBody = pos.stdout.trim();
  console.log(`[hop-probe] positive body: ${positiveBody}`);

  // ── NEGATIVE: a DIFFERENT, non-allowlisted host must be blocked. NOTE: this is
  // blocked at the allowlist GATE (ContainerProxy.fetch → 520 "Origin is disallowed")
  // BEFORE the handler runs, not by the handler's 403 branch. Either way it must not
  // be a real 2xx from example.org.
  const neg = await sandbox.exec(
    `curl -s -k --max-time 10 -o /dev/null -w 'HTTP_%{http_code}' https://example.org/ 2>/dev/null || echo CONN_FAIL`,
  );
  const negativeBody = neg.stdout.trim();
  console.log(`[hop-probe] negative body: ${negativeBody}`);

  // ── Verdict. PASS iff the positive body came from the DO binding. The exact body
  // is surfaced verbatim so a FAIL is diagnosable:
  //   • "Example Domain"  → fell through to a REAL fetch (handler not registered /
  //                         allowlist fallback) — DO never reached.
  //   • CONN_FAIL / 500   → the DO call THREW (binding unreachable from the handler).
  //   • OK-FROM-DO-BINDING → PASS (DO received the intercepted request, path intact).
  const hop = positiveBody.includes("OK-FROM-DO-BINDING");
  const negBlocked = !negativeBody.includes("HTTP_2") && !negativeBody.includes("HTTP_3");

  return Response.json({
    verdict: hop ? "HOP-PASS" : "HOP-FAIL",
    proves:
      "static outbound handler can route the one allowlisted egress to an INTERNAL Durable Object via its binding, and the container receives the DO's response body. Request/response binding hop ONLY — quack protocol survival through the DO hop is Stage D.",
    gatewayHost: gw,
    setAllowedHosts: allowSet,
    setOutboundByHost: routeSet,
    positiveBody, // expect: OK-FROM-DO-BINDING:/hello
    negativeBody, // expect: blocked / non-2xx (520 from the allowlist gate)
    negativeBlocked: negBlocked,
    interpretation: hop
      ? "DO binding is live and callable inside static outbound; gateway can be a private internal DO."
      : positiveBody.includes("Example Domain")
        ? "FELL THROUGH to a real fetch — handler did not route to the DO (registration/allowlist-fallback issue)."
        : "DO call appears to have thrown / not connected — binding may be unreachable from the proxy entrypoint context.",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/probe") {
      try {
        return await runProbe(env);
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    }
    return new Response(
      "Stage C hop probe #1 (outbound → DO-binding hop). GET /probe to run.\n",
      { status: 200 },
    );
  },
};
