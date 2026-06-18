// Probe #1 — THE STAGE 0 GATE (cloud-required).
//
// Proves the single viable EGRESS SHAPE for the workspace data plane on Cloudflare:
// a containerized process inside a `Sandbox` subclass can reach exactly ONE
// allowlisted host over HTTPS:443, WHILE every other host is 403'd and any non-443
// egress is denied. This is the network twin of `disabled_filesystems`: a
// deny-by-default egress allowlist agent code cannot bypass (the outbound handler
// runs in the runtime sidecar, not in the container).
//
// SCOPE OF THIS PROBE: the gate is about egress SHAPE (which host, which port),
// which is protocol-agnostic — a plain HTTPS GET to the allowlisted host fully
// exercises the mechanism (allowedHosts + outbound handler + enableInternet=false).
// We therefore point GATEWAY_HOST at a trivial HTTPS endpoint that returns a known
// body. Whether that host speaks the quack protocol over TLS depends on the gateway
// container, which does not exist until Stage D — so the quack ATTACH is run only as
// an explicitly-labeled "Stage D protocol follow-through" and is EXPECTED to fail
// against a non-quack target. Conflating the two would test "does a dumb HTTPS server
// speak quack," not egress shape.
//
// Research basis: CF container outbound controls intercept ONLY HTTP 80/443 + DNS.
// With enableInternet=false, only 80/443/DNS leave the container at all; a non-443
// connection is denied even to an allowlisted host. `Sandbox` intercepts HTTPS by
// default (ephemeral per-instance CA, trusted in-container) — interception stays ON
// so the static `outbound` handler routes the one allowed request and 403s all else.
//
// TLS-TRUST vs EGRESS: the positive HTTPS GET uses `curl -k` so a CA-trust artifact
// (the ephemeral interception CA not being trusted by curl) is not mistaken for an
// egress failure. The block happens at connect/routing, BEFORE TLS, so the negatives
// hold regardless of `-k`.

import { getSandbox, Sandbox, ContainerProxy } from "@cloudflare/sandbox";

// Required when using outbound interception: the SDK routes intercepted container
// egress through this WorkerEntrypoint, so it must be exported from the Worker.
export { ContainerProxy };

interface Env {
  Sandbox: DurableObjectNamespace<ProbeSandbox>;
  // The single host the workspace container is allowed to reach. Host only, no
  // scheme/port. For this probe it is the trivial gateway-stub Worker's *.workers.dev
  // hostname. Set as a wrangler var.
  GATEWAY_HOST: string;
  // The quack TOKEN (session JWT stand-in) for the Stage D protocol follow-through.
  // In production this is vended over the /init control channel, never an env var;
  // for this throwaway probe a secret is acceptable.
  LAKE_TOKEN: string;
}

export class ProbeSandbox extends Sandbox<Env> {
  // Deny-by-default egress. Two layers, both load-bearing:
  //  • enableInternet=false is the secure default (no open internet). Per the
  //    @cloudflare/containers API, ALLOWED hosts still get egress even when
  //    enableInternet is false — so a tight allowlist grants exactly the one
  //    gateway exception and nothing else. EMPIRICAL FINDING: setting `allowedHosts`
  //    as a constructor class field did NOT propagate to the ContainerProxy
  //    (the interception config is built/propagated separately); the allowlist must
  //    be engaged at RUNTIME via `setAllowedHosts()` on the running instance (done
  //    in runProbe before any egress).
  enableInternet = false;
  // HTTPS (443) is only routed through the outbound handler/allowlist chain when this
  // is true (containers README: `interceptHttps`). Without it, under enableInternet=false
  // there is NO path for HTTPS egress, so even the allowlisted host CONN_FAILs — exactly
  // the symptom we hit. With it on, the chain is: deniedHosts → allowedHosts gate
  // (non-match ⇒ blocked) → handlers → "allowed-host internet fallback" (forwarded even
  // when enableInternet=false). curl -k tolerates the proxy's ephemeral CA at the TLS layer.
  interceptHttps = true;
  allowedHosts: string[] = [];

  // Matches the @cloudflare/sandbox Sandbox constructor signature exactly.
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Single source of truth: derive the allowlist from env.GATEWAY_HOST so the
    // host lives in exactly one place (wrangler.jsonc var), not duplicated in code.
    if (env.GATEWAY_HOST) this.allowedHosts = [env.GATEWAY_HOST];
  }

  // The static `outbound` handler intercepts EVERY outbound HTTP(S) request the
  // container makes. It receives `env` as its 2nd argument, so it reads GATEWAY_HOST
  // directly — no module-global. Allow-lists the one gateway-bound request and 403s
  // all else (belt-and-suspenders alongside enableInternet=false + allowedHosts). In
  // Stage D this `fetch(request)` becomes a service binding / RPC to the gateway DO.
  static outbound = async (request: Request, env: Env): Promise<Response> => {
    const host = new URL(request.url).hostname;
    if (env.GATEWAY_HOST && host === env.GATEWAY_HOST) {
      return fetch(request); // the one gated egress: workspace → gateway (quack/HTTPS:443)
    }
    return new Response(`egress to ${host} blocked (only ${env.GATEWAY_HOST}:443 allowed)`, { status: 403 });
  };
}

// ProbeSandbox is exported (the class declaration above is `export class …`) so the
// DO binding can bind to it. We do NOT also alias it as `Sandbox` — that alias is
// only needed when binding to the SDK's base class directly; here class_name is
// ProbeSandbox in wrangler.jsonc.

// curl that prints the HTTP status code OR a labeled connection failure, so we can
// tell "reached the host, got a status" from "egress denied / could not connect".
function curlStatus(target: string, extra = ""): string {
  return `curl -s -o /dev/null --max-time 10 ${extra} -w 'HTTP_%{http_code}' ${target} 2>/dev/null || echo 'CONN_FAIL'`;
}

async function runProbe(env: Env): Promise<Response> {
  // Fresh id → a clean container instance that boots under the current config.
  const gw = env.GATEWAY_HOST;
  const sandbox = getSandbox(env.Sandbox, "stage0-probe-egress-v4");
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;
  // Engage deny-by-default egress at RUNTIME (the documented API): the allowlisted
  // gateway gets egress even though enableInternet=false; every other host is denied.
  let allowSet = "ok";
  try {
    await (sandbox as unknown as { setAllowedHosts(h: string[]): Promise<void> }).setAllowedHosts([gw]);
  } catch (e) {
    allowSet = "FAILED: " + (e instanceof Error ? e.message : String(e));
  }
  console.log(`[probe] setAllowedHosts([${gw}]) -> ${allowSet}, ${el()}`);

  // ── POSITIVE (the gate): reach the ONE allowlisted host on HTTPS:443. ──────────
  // `-k` isolates egress from CA-trust: a strict TLS failure would be a CA artifact,
  // not an egress failure. We capture BOTH so the CA-trust data point is visible.
  const posK = await sandbox.exec(curlStatus(`https://${gw}/`, "-k"));
  const posStrict = await sandbox.exec(curlStatus(`https://${gw}/`));
  // The known body proves we actually reached the stub (not a proxy/handler reply).
  const posBody = await sandbox.exec(`curl -s -k --max-time 10 https://${gw}/ 2>/dev/null || echo 'CONN_FAIL'`);

  console.log(`[probe] positives done ${el()}`);

  // ── NEGATIVE 1: a NON-allowlisted host on HTTPS:443 must be blocked. ───────────
  const negHost = await sandbox.exec(curlStatus("https://example.com/", "-k"));

  // ── NEGATIVE 2: the allowlisted host on a NON-443 port must be denied ──────────
  // (enableInternet=false → only 80/443 leave the container at all).
  const negPort = await sandbox.exec(curlStatus(`https://${gw}:8443/`, "-k"));
  console.log(`[probe] negatives done ${el()}`);

  // ── STAGE D follow-through (NOT the gate): a quack ATTACH on :443. Expected to ──
  // fail against this non-quack stub; recorded only to show the ATTACH egresses to
  // the allowed host (vs being blocked) — protocol success is a Stage D concern.
  const driver = `
import { DuckDBInstance } from "@duckdb/node-api";
const GATEWAY = process.env.GATEWAY_HOST, TOKEN = process.env.LAKE_TOKEN;
const out = {};
try {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run("INSTALL quack; LOAD quack;");
  await c.run("ATTACH 'quack:" + GATEWAY + ":443' AS lake (TOKEN '" + TOKEN + "', DISABLE_SSL false)");
  await c.runAndReadAll("FROM lake.query('SELECT 42 AS answer')");
  out.result = "ATTACH+query succeeded (would only happen vs a real quack gateway)";
} catch (e) { out.result = "ATTACH failed: " + String(e.message).split("\\n")[0]; }
console.log(JSON.stringify(out));
`;
  await sandbox.writeFile("/app/quack-followthrough.mjs", driver);
  // BOUNDED + non-fatal. `INSTALL quack` needs the DuckDB extension repo, which the
  // egress lockdown (correctly) blocks — so this is EXPECTED to fail/stall here and
  // must NOT hang the whole /probe response (the verdict is already computed from
  // the curls above). In Stage C/D the workspace image pre-bakes quack, so there is
  // no runtime INSTALL. `timeout` caps the exec; try/catch keeps a stall non-fatal.
  let quackOut = "";
  try {
    const quack = await sandbox.exec("node /app/quack-followthrough.mjs", {
      env: { GATEWAY_HOST: gw, LAKE_TOKEN: env.LAKE_TOKEN },
      timeout: 8000,
    });
    quackOut = quack.stdout || quack.stderr;
  } catch (e) {
    quackOut = "bounded/aborted (expected — INSTALL quack blocked by egress lockdown): " +
      (e instanceof Error ? e.message : String(e));
  }
  console.log(`[probe] quack follow-through done ${el()}`);

  // ── Verdict (egress shape only) ───────────────────────────────────────────────
  const reached = posK.stdout.includes("HTTP_") && posBody.stdout.includes("OK-GATEWAY-STAGE0");
  const hostBlocked = !negHost.stdout.includes("HTTP_2") && !negHost.stdout.includes("HTTP_3"); // not a real 2xx/3xx from example.com
  const portBlocked = negPort.stdout.includes("CONN_FAIL") || !negPort.stdout.includes("HTTP_2");
  const gatePass = reached && hostBlocked && portBlocked;

  return Response.json({
    verdict: gatePass ? "EGRESS-GATE-PASS" : "EGRESS-GATE-FAIL",
    enableInternet: false,
    gatewayHost: gw,
    positive: {
      "allowlisted host HTTPS:443 (-k, expect HTTP_200 + known body)": posK.stdout,
      "  known body present (expect OK-GATEWAY-STAGE0)": posBody.stdout,
      "  strict TLS (CA-trust data point; failure here is NOT an egress failure)": posStrict.stdout,
    },
    negative: {
      "non-allowlisted host example.com HTTPS:443 (expect blocked, NOT HTTP_2xx)": negHost.stdout,
      "allowlisted host on NON-443 port 8443 (expect CONN_FAIL — only 80/443 leave)": negPort.stdout,
    },
    stageD_followthrough_quack_attach: {
      note: "NOT part of the gate. Expected to fail vs the non-quack stub; protocol success belongs to Stage D.",
      output: quackOut,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/probe") {
      try {
        return await runProbe(env);
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    return new Response(
      "Stage 0 probe #1 (egress gate). GET /probe to run.\n" +
        "GATEWAY_HOST must be the allowlisted host; LAKE_TOKEN is for the Stage D quack follow-through.\n",
      { status: 200 },
    );
  },
};
