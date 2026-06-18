// Stage C workspace data-plane probe — the WorkspaceSandbox Durable Object + its
// Cloudflare Sandbox container (Model B), proving the durable-encrypted-workspace
// lifecycle + S1 isolation on real Cloudflare.
//
// WHAT THIS PROVES. The waddling data plane needs each agent to get a durable,
// encrypted, PRIVATE DuckDB workspace that survives across sessions and cannot reach
// the lake's object store directly. This probe collapses the proven Rivet pieces
// (workspace-runner + workspace-actor + workspace-store) into ONE CF DO that:
//   • is a Sandbox subclass (Sandbox ⊂ Container ⊂ DO) running the workspace sidecar;
//   • is "pure c2" (Model B): it reads per-team R2 creds from Secrets Store, mints
//     SHORT-LIVED SINGLE-OBJECT presigned R2 GET/PUT URLs (aws4fetch), and hands them
//     to the sidecar over /init. The DO NEVER touches the .duckdb bytes; the SIDECAR
//     fetches/persists its own encrypted file. No R2 creds ever enter the container.
//
// PROOF PATH (honest scope):
//   Worker /probe
//     → session 1: ensure(WorkspaceSandbox "ws-A") → startProcess(sidecar) →
//        mint presigned GET/PUT → containerFetch /init (restore: empty first time) →
//        /run CREATE TABLE t AS SELECT 42 → /snapshot (CHECKPOINT + presigned PUT to R2)
//     → session 2: ensure(WorkspaceSandbox "ws-B", a FRESH sandbox id → real
//        restore-from-R2) → /init (presigned GET pulls the .duckdb) → /query SELECT *
//        FROM t → assert answer=42  (DURABILITY across a cold, different instance)
//     → isolation / encrypted-at-rest / FIFO sub-probes.
//   The quack→lake leg (lakeProxy/lakeToken in the /init contract + the ATTACH path)
//   is present but DEFERRED — the gateway is infra-blocked, so the probe never sends it.
//
// EGRESS. The sidecar's only outbound need is the R2 host (to fetch/persist its own
// encrypted file). enableInternet=false + interceptHttps=true + setAllowedHosts([R2])
// at runtime. For an allowlisted host with NO custom outbound handler the SDK's step-7
// fallback does a real fetch(request) → reaches real R2. So allowedHosts=[R2_HOST] is
// enough; no custom handler is registered here (the gateway-DO routing handler is a
// later step, when the quack leg is wired).

import { getSandbox, Sandbox, ContainerProxy } from "@cloudflare/sandbox";
import { AwsClient } from "aws4fetch";

// Required when a Sandbox subclass is used: the SDK routes container control through
// this WorkerEntrypoint, so it must be exported from the Worker. (Carried over from
// the proven hop/gw probes.)
export { ContainerProxy };

interface Env {
  WORKSPACE: DurableObjectNamespace<WorkspaceSandbox>;
  // R2 S3-API creds (REAL — the same token /probe/r2 proved), read to MINT presigned
  // URLs. The DO holds them only long enough to sign; they never reach the container.
  R2_ACCESS_KEY_ID: { get(): Promise<string> };
  R2_SECRET_ACCESS_KEY: { get(): Promise<string> };
  R2_ENDPOINT: string; // https://<acct>.r2.cloudflarestorage.com
  R2_BUCKET: string;   // waddling-ws-probe
  R2_REGION: string;   // auto
  R2_HOST: string;     // <acct>.r2.cloudflarestorage.com (egress allowlist entry)
}

// The sidecar's control surface inside the container. One sidecar per container, fixed
// port (baked in the Dockerfile ENV). The DO reaches it via containerFetch.
const SIDECAR_PORT = 8080;
const SIDECAR_CMD = "node /opt/workspace/workspace-sidecar.mjs";

// S3 object key for a workspace DB — CONSTANT across sessions (independent of the
// sandbox id), so session 2 (a different DO instance) hits the same R2 object that
// session 1 wrote. Mirrors workspace-store.ts workspaceKey().
function workspaceKey(workspaceId: string, agentId: string): string {
  return `workspace/${workspaceId}/db/${agentId}.duckdb`;
}

// ── WorkspaceSandbox DO ────────────────────────────────────────────────────────
// Collapses workspace-runner (restore→spawn→init→checkpoint→upload) + workspace-actor
// (lifecycle) into a CF Sandbox subclass. The probe drives it through SDK methods on
// the getSandbox handle (startProcess / containerFetch / exec — the proven method
// class), NOT through custom subclass RPC.
export class WorkspaceSandbox extends Sandbox<Env> {
  // Deny-by-default egress, carried over VERBATIM from the proven hop probe.
  enableInternet = false;
  // HTTPS (443) is only routed through the allowlist chain when this is true. Required
  // for the container→R2 HTTPS leg.
  interceptHttps = true;
  // EMPIRICAL hop-probe finding: this class field does NOT propagate to the
  // ContainerProxy — the allowlist is engaged at RUNTIME via setAllowedHosts() before
  // any egress. Kept here only for documentation/single-source-of-host.
  allowedHosts: string[] = [];
}

// ── presigned-URL minting (aws4fetch, Model B) ──────────────────────────────────
// Mirrors apps/control-api /probe/r2 verbatim: region 'auto', service 's3',
// signQuery:true → a query-signed single-object URL. SHORT-LIVED (X-Amz-Expires).
async function mintPresigned(
  env: Env,
  method: "GET" | "PUT",
  key: string,
  expiresSec = 300,
): Promise<string> {
  const accessKeyId = await env.R2_ACCESS_KEY_ID.get();
  const secretAccessKey = await env.R2_SECRET_ACCESS_KEY.get();
  const client = new AwsClient({ accessKeyId, secretAccessKey, region: env.R2_REGION, service: "s3" });
  const url = new URL(`${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client.sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

// The SDK methods the probe uses on a getSandbox handle (it returns a handle, not a
// WorkspaceSandbox instance — only SDK methods are callable).
interface WsHandle {
  exec(cmd: string): Promise<{ stdout: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
  setAllowedHosts(hosts: string[]): Promise<void>;
}

/** Bring up the sidecar in a sandbox instance + engage egress, then /init it with
 *  freshly-minted presigned GET/PUT + the workspace key. Idempotent on the process
 *  (guarded by a /tmp marker like gw-probe), but always re-mints + re-/inits (presigned
 *  URLs are short-lived; /init is idempotent on the sidecar once `booted`). */
async function ensureWorkspace(
  env: Env,
  sandboxId: string,
  key: string,
  objectKey: string,
  opts: { getStatus404Ok?: boolean } = {},
): Promise<{ initBody: Record<string, unknown>; started: boolean }> {
  const sandbox = getSandbox(env.WORKSPACE, sandboxId) as unknown as WsHandle;

  // Engage deny-by-default egress at RUNTIME — forces interceptAll so the allowlisted
  // R2 host reaches the SDK step-7 fallback (real fetch). No custom handler needed.
  await sandbox.setAllowedHosts([env.R2_HOST]);

  // Launch the sidecar once (marker guard so a re-/probe doesn't spawn a second).
  const marker = await sandbox.exec("test -f /tmp/ws-started && echo yes || echo no");
  let started = false;
  if (marker.stdout.trim() !== "yes") {
    await sandbox.exec("touch /tmp/ws-started");
    // --use-system-ca so undici trusts the per-instance ephemeral CA the intercept
    // injects (see Dockerfile). Without it the sidecar's presigned-R2 fetch fails cert
    // verification → silent durability FAIL.
    await sandbox.startProcess(`node --use-system-ca /opt/workspace/workspace-sidecar.mjs`);
    started = true;
  }

  // Wait for sidecar /health (reachability == ready-for-/init).
  const deadline = Date.now() + 90_000;
  let healthy = false;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await sandbox.containerFetch("http://ws/health", { method: "GET" }, SIDECAR_PORT);
      if (r.ok) { healthy = true; break; }
      lastErr = `health ${r.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!healthy) throw new Error(`sidecar did not become healthy in 90s: ${lastErr}`);

  // Mint presigned GET (restore) + PUT (persist) for THIS session, hand them to the
  // sidecar over /init. The DO never reads/writes the bytes.
  const presignedGet = await mintPresigned(env, "GET", objectKey);
  const presignedPut = await mintPresigned(env, "PUT", objectKey);
  const initBody: Record<string, unknown> = {
    key,
    presignedGet,
    presignedPut,
    getStatus404Ok: opts.getStatus404Ok ?? true,
    lockConfiguration: true,
    // lakeProxy/lakeToken DEFERRED (gateway infra-blocked) — not sent.
  };
  const initRes = await sandbox.containerFetch("http://ws/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(initBody),
  }, SIDECAR_PORT);
  const initTxt = await initRes.text();
  if (!initRes.ok) throw new Error(`sidecar /init ${initRes.status}: ${initTxt}`);

  return { initBody, started };
}

/** POST a control command to the sidecar over containerFetch and parse JSON. */
async function sidecar(
  env: Env,
  sandboxId: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const sandbox = getSandbox(env.WORKSPACE, sandboxId) as unknown as WsHandle;
  const r = await sandbox.containerFetch(`http://ws${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, SIDECAR_PORT);
  const txt = await r.text();
  let json: any = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  return { status: r.status, json };
}

// ── /probe ──────────────────────────────────────────────────────────────────────
async function runProbe(env: Env): Promise<Response> {
  const result: Record<string, unknown> = {};
  const deferred = ["quack-lake-leg"];

  // The workspace ENCRYPTION_KEY lives in the WORKER (Model-B faithful: control-api
  // vends it in the real system). FIXED 32-byte hex for the probe so session 1 and
  // session 2 — DIFFERENT DO instances — use the same key against the same R2 object.
  // It must NOT live in DO storage: session 2 uses a fresh sandbox id (different DO,
  // different storage) to force a real restore-from-R2, so a DO-stored key would be
  // unreachable. Passed to whichever instance over /init.
  const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const WORKSPACE_ID = "ws-probe";
  const AGENT_ID = "agent-probe";
  // Unique object key per run so a re-run starts fresh (no stale durability false-pass).
  const objectKey = workspaceKey(WORKSPACE_ID, `${AGENT_ID}-${crypto.randomUUID().slice(0, 8)}`);
  result.objectKey = objectKey;

  // ── SESSION 1: create the table + snapshot to R2 ───────────────────────────────
  const s1Id = `ws-A-${crypto.randomUUID().slice(0, 8)}`;
  const s1 = await ensureWorkspace(env, s1Id, KEY, objectKey, { getStatus404Ok: true });
  result.session1 = { sandboxId: s1Id, started: s1.started };

  const create = await sidecar(env, s1Id, "/run", { sql: "CREATE TABLE t AS SELECT 42 AS answer" });
  const snap = await sidecar(env, s1Id, "/snapshot");
  result.session1Create = create.json;
  result.session1Snapshot = { status: snap.status, json: snap.json };
  const snapshotOk = snap.status === 200 && snap.json?.ok === true;

  // ── SESSION 2: FRESH instance → real restore-from-R2 → read it back ─────────────
  const s2Id = `ws-B-${crypto.randomUUID().slice(0, 8)}`;
  const s2 = await ensureWorkspace(env, s2Id, KEY, objectKey, { getStatus404Ok: false });
  result.session2 = { sandboxId: s2Id, started: s2.started };

  const read = await sidecar(env, s2Id, "/query", { sql: "SELECT * FROM t" });
  result.session2Read = read.json;
  const answer = read.json?.rows?.[0]?.[0];
  const durabilityOk = read.status === 200 && Number(answer) === 42;
  result.durability = { ok: durabilityOk, answer };

  // ── ISOLATION (run on the live session-2 instance) ─────────────────────────────
  // s3:// and http:// reads must fail "by configuration"; allow_unsigned_extensions
  // must be false; the workspace key / any token must NOT be readable.
  const s3Read = await sidecar(env, s2Id, "/query", {
    sql: "SELECT * FROM read_csv('s3://waddling-ws-probe/x/y.csv')",
  });
  const httpRead = await sidecar(env, s2Id, "/query", {
    sql: "SELECT * FROM read_csv('http://example.com/y.csv')",
  });
  const unsigned = await sidecar(env, s2Id, "/query", {
    sql: "SELECT current_setting('allow_unsigned_extensions') AS v",
  });
  const secretsLeak = await sidecar(env, s2Id, "/query", {
    sql: "SELECT count(*) AS n FROM duckdb_secrets()",
  });
  const disabledFs = await sidecar(env, s2Id, "/query", {
    sql: "SELECT current_setting('disabled_filesystems') AS v",
  });

  const s3Blocked = s3Read.json?.error != null && /disabled by configuration|disabled/i.test(String(s3Read.json.error));
  const httpBlocked = httpRead.json?.error != null && /disabled by configuration|disabled/i.test(String(httpRead.json.error));
  const unsignedFalse = String(unsigned.json?.rows?.[0]?.[0]).toLowerCase() === "false";
  // No agent S3/lake secret present (the workspace holds none) — duckdb_secrets() empty.
  const noSecrets = Number(secretsLeak.json?.rows?.[0]?.[0]) === 0;
  const fsList = String(disabledFs.json?.rows?.[0]?.[0] ?? "");
  const fsLocked = /S3FileSystem/.test(fsList) && /HTTPFileSystem/.test(fsList);

  const isolationOk = s3Blocked && httpBlocked && unsignedFalse && noSecrets && fsLocked;
  result.isolation = {
    ok: isolationOk,
    s3Blocked, httpBlocked, unsignedFalse, noSecrets, fsLocked,
    s3Error: s3Read.json?.error ?? null,
    httpError: httpRead.json?.error ?? null,
    allowUnsignedExtensions: unsigned.json?.rows?.[0]?.[0] ?? null,
    duckdbSecretsCount: secretsLeak.json?.rows?.[0]?.[0] ?? null,
    disabledFilesystems: fsList,
  };

  // ── ENCRYPTED-AT-REST ──────────────────────────────────────────────────────────
  // PROBE-HARNESS read (NOT the Model-B data path): the Worker mints a presigned GET
  // with Range: bytes=0-3 and asserts the first 4 bytes are NOT 'DUCK' (a plaintext
  // DuckDB file starts with the 'DUCK' magic; an encrypted one is ciphertext). Then a
  // FRESH instance /init with a WRONG key must fail at ATTACH.
  const headUrl = await mintPresigned(env, "GET", objectKey);
  const headRes = await fetch(headUrl, { method: "GET", headers: { Range: "bytes=0-3" } });
  const firstBytes = headRes.ok ? new Uint8Array(await headRes.arrayBuffer()) : new Uint8Array();
  // Assert exactly 4 bytes came back (Range honored, status 206): if R2 ignored Range
  // and returned the full object, a plaintext file's later bytes could mask the 'DUCK'
  // magic and falsely pass. Decode only the first 4 bytes regardless.
  const rangeHonored = firstBytes.length === 4;
  const magic = new TextDecoder().decode(firstBytes.slice(0, 4));
  const notPlaintext = headRes.ok && rangeHonored && magic !== "DUCK";

  // Wrong-key reopen: a FRESH, UNBOOTED instance whose first /init carries a wrong key
  // must 500 at ATTACH (a live instance's 2nd /init is a no-op once booted, so it can
  // only be tested on a cold sidecar).
  const s3Id = `ws-C-${crypto.randomUUID().slice(0, 8)}`;
  const WRONG_KEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  let wrongKeyRejected = false;
  let wrongKeyError: string | null = null;
  try {
    await ensureWorkspace(env, s3Id, WRONG_KEY, objectKey, { getStatus404Ok: false });
    // If ensure() did not throw, init unexpectedly succeeded with the wrong key.
    wrongKeyRejected = false;
  } catch (e) {
    wrongKeyRejected = true;
    wrongKeyError = e instanceof Error ? e.message : String(e);
  }
  const encryptedAtRestOk = notPlaintext && wrongKeyRejected;
  result.encryptedAtRest = {
    ok: encryptedAtRestOk,
    notPlaintext, rangeHonored, firstBytesHex: Array.from(firstBytes).map((b) => b.toString(16).padStart(2, "0")).join(""),
    magicAttempt: magic,
    wrongKeyRejected, wrongKeyError,
  };

  // ── FIFO ─────────────────────────────────────────────────────────────────────
  // Two overlapping /query calls must serialize on the single connection. queueDepth
  // observed > 1 on the second-in proves they queued rather than ran concurrently.
  // A slow query (a big generate_series aggregate) keeps the connection busy while the
  // second arrives.
  const slowSql = "SELECT count(*) AS n FROM range(20000000)";
  const fastSql = "SELECT 1 AS n";
  const [slow, fast] = await Promise.all([
    sidecar(env, s2Id, "/query", { sql: slowSql }),
    sidecar(env, s2Id, "/query", { sql: fastSql }),
  ]);
  // Assert on the sidecar's MONOTONIC peakDepth, not the live queueDepth: the per-task
  // decrement is registered before the caller's await continuation, so a live read can
  // never show the overlap (it would always be ≤1 even under correct serialization).
  // peakDepth is decrement-proof — peakDepth ≥ 2 proves both queries were queued at once.
  const peak = Math.max(Number(slow.json?.peakDepth ?? 0), Number(fast.json?.peakDepth ?? 0));
  const fifoOk = slow.status === 200 && fast.status === 200 && peak >= 2;
  result.fifo = { ok: fifoOk, peakDepth: peak, slowPeak: slow.json?.peakDepth, fastPeak: fast.json?.peakDepth };

  // ── Final clean shutdown of the live instances (best-effort) ───────────────────
  try { await sidecar(env, s1Id, "/shutdown"); } catch { /* may already be gone */ }
  try { await sidecar(env, s2Id, "/shutdown"); } catch { /* may already be gone */ }

  const verdict =
    durabilityOk && snapshotOk && isolationOk && encryptedAtRestOk && fifoOk
      ? "WSDO-PASS"
      : "WSDO-FAIL";

  return Response.json({
    verdict,
    proves:
      "the WorkspaceSandbox DO + Sandbox container deliver a durable, encrypted, isolated per-agent DuckDB workspace on real Cloudflare (Model B): the DO mints presigned R2 URLs from Secrets-Store creds and never touches the file bytes; the sidecar restores/persists its own encrypted .duckdb; data survives a cold restore on a DIFFERENT DO instance; s3://+http:// are blocked by configuration; the file is ciphertext at rest and a wrong key fails to open; queries serialize FIFO.",
    durability: durabilityOk,
    snapshot: snapshotOk,
    isolation: isolationOk,
    encryptedAtRest: encryptedAtRestOk,
    fifo: fifoOk,
    deferred,
    detail: result,
    interpretation:
      verdict === "WSDO-PASS"
        ? "Durable-encrypted-workspace lifecycle + S1 isolation hold on real Cloudflare. The quack→lake leg is deferred (gateway infra-blocked) but the /init contract + ATTACH path exist."
        : "One or more assertions failed — see detail. The most likely deploy-time cause of a durability FAIL is the container→R2 TLS trust (Node undici vs the interceptHttps ephemeral CA); confirm --use-system-ca took effect.",
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
          { verdict: "WSDO-FAIL", error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined },
          { status: 500 },
        );
      }
    }
    return new Response(
      "Stage C workspace probe (WorkspaceSandbox DO + Sandbox container, Model B). GET /probe to run.\n",
      { status: 200 },
    );
  },
};
