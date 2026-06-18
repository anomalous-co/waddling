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
  // Stops the CONTAINER (not just the sidecar) and frees its instance slot. /shutdown
  // only `process.exit()`s the sidecar — the base image's process-server (PID 1) keeps
  // the container running until idle-expiry, so it frees ZERO slots. destroy() is the
  // only thing that reclaims a slot immediately, which is what keeps max_instances from
  // starving back-to-back runs. Always call it AFTER the R2 persist (disk is ephemeral;
  // R2 holds the bytes).
  destroy(): Promise<void>;
}

/** Best-effort container teardown to free the instance slot. Never throws. */
async function destroyQuietly(env: Env, sandboxId: string): Promise<void> {
  try {
    await (getSandbox(env.WORKSPACE, sandboxId) as unknown as WsHandle).destroy();
  } catch { /* already gone / mid-teardown — slot frees either way */ }
}

// Lowercase sandbox id with a per-run random suffix. Lowercase because the SDK warns
// uppercase ids break case-insensitive preview-URL hostnames (and will become a
// default-on breaking change). Random suffix → each call is a genuinely fresh DO
// instance (real cold boot / cold restore), never a warm reuse.
function rid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}

// Shared across steps (separate HTTP requests). FIXED 32-byte hex so session 1 (write)
// and session 2 (cold restore on a DIFFERENT instance) open the SAME R2 object with the
// SAME key. In the real system control-api vends this per workspace; here it is a probe
// constant passed to each instance over /init (never DO storage — step 2 uses a fresh
// instance with no shared storage).
const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const WRONG_KEY = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const WORKSPACE_ID = "ws-probe";

// A freshly-created container (this probe uses a fresh random sandbox id per run, so
// EVERY session is a cold boot — unlike the gw/hop probes' stable, kept-warm ids) can
// throw on the FIRST method that touches it while the SDK is still bringing the
// "default session" up: "Default session initialization was invalidated by a container
// stop". It is a startup race, not a real failure — retry until the session stabilizes.
const BOOT_RACE = /invalidated by a container stop|container (is )?(stop|not running|starting)|no (running )?instance|default session/i;
async function withBootRetry<T>(fn: () => Promise<T>, label: string, tries = 15, delayMs = 2500): Promise<T> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!BOOT_RACE.test(msg)) throw e;
      lastErr = msg;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label}: still racing container boot after ${tries} tries: ${lastErr}`);
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

  // Cold-boot the container with a tolerant warmup BEFORE any real call. The first
  // method on a fresh container races its startup (see withBootRetry); a cheap exec
  // retried until it succeeds is what lets the default session stabilize — mirrors the
  // gw-probe's exec-first boot, which kept its (stable-id) container warm.
  await withBootRetry(() => sandbox.exec("echo ready"), `warmup ${sandboxId}`);

  // Engage deny-by-default egress at RUNTIME — forces interceptAll so the allowlisted
  // R2 host reaches the SDK step-7 fallback (real fetch). No custom handler needed.
  // Also boot-retried: changing egress config can momentarily restart the container.
  await withBootRetry(() => sandbox.setAllowedHosts([env.R2_HOST]), `setAllowedHosts ${sandboxId}`);

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

// ── probe steps ───────────────────────────────────────────────────────────────
// Split across THREE short HTTP requests (one cold container each) instead of one
// monolithic /probe. Rationale, learned empirically: three sequential cold DuckDB-
// container boots in a single request run 60–120s — over the workers.dev edge timeout
// (the request gets canceled mid-flight). Each step here boots ONE container, does its
// work, persists to R2 where needed, then destroy()s the container to free its instance
// slot before returning. State between steps = the R2 object key (returned by /s1,
// passed to /s2 + /s3 as ?objectKey=). The caller assembles the WSDO verdict from the
// three sub-proofs (each step returns its own booleans).

// ── /s1: create a table + snapshot it to R2 (the WRITE session) ──────────────────
async function step1(env: Env): Promise<Record<string, unknown>> {
  // Unique object key per run so a re-run starts fresh (no stale durability false-pass).
  const objectKey = workspaceKey(WORKSPACE_ID, `agent-probe-${crypto.randomUUID().slice(0, 8)}`);
  const s1Id = rid("ws-a");
  try {
    await ensureWorkspace(env, s1Id, KEY, objectKey, { getStatus404Ok: true });
    const create = await sidecar(env, s1Id, "/run", { sql: "CREATE TABLE t AS SELECT 42 AS answer" });
    // /snapshot = CHECKPOINT + presigned PUT to R2. The encrypted bytes now live in R2;
    // the container's disk is ephemeral, so destroy() below loses nothing.
    const snap = await sidecar(env, s1Id, "/snapshot");
    const snapshotOk = snap.status === 200 && snap.json?.ok === true;
    return {
      step: "s1",
      ok: create.status === 200 && snapshotOk,
      objectKey,
      sandboxId: s1Id,
      createOk: create.status === 200,
      snapshotOk,
      snapshot: { status: snap.status, json: snap.json },
    };
  } finally {
    // Free the slot regardless — without this the container lingers (the base process-
    // server holds PID 1) and starves the next run's max_instances.
    await destroyQuietly(env, s1Id);
  }
}

// ── /s2: FRESH instance → cold restore-from-R2 → durability + isolation + FIFO ───
async function step2(env: Env, objectKey: string): Promise<Record<string, unknown>> {
  const s2Id = rid("ws-b");
  try {
    // getStatus404Ok:false → a missing object is a hard FAIL here (this MUST be a real
    // restore of what /s1 wrote, on a different instance).
    await ensureWorkspace(env, s2Id, KEY, objectKey, { getStatus404Ok: false });

    // Durability: the table /s1 created must be present after a cold restore.
    const read = await sidecar(env, s2Id, "/query", { sql: "SELECT * FROM t" });
    const answer = read.json?.rows?.[0]?.[0];
    const durabilityOk = read.status === 200 && Number(answer) === 42;

    // Isolation (S1): s3:// + http:// reads blocked "by configuration";
    // allow_unsigned_extensions false; no leaked secret; disabled_filesystems pinned.
    const s3Read = await sidecar(env, s2Id, "/query", { sql: "SELECT * FROM read_csv('s3://waddling-ws-probe/x/y.csv')" });
    const httpRead = await sidecar(env, s2Id, "/query", { sql: "SELECT * FROM read_csv('http://example.com/y.csv')" });
    const unsigned = await sidecar(env, s2Id, "/query", { sql: "SELECT current_setting('allow_unsigned_extensions') AS v" });
    const secretsLeak = await sidecar(env, s2Id, "/query", { sql: "SELECT count(*) AS n FROM duckdb_secrets()" });
    const disabledFs = await sidecar(env, s2Id, "/query", { sql: "SELECT current_setting('disabled_filesystems') AS v" });

    const s3Blocked = s3Read.json?.error != null && /disabled by configuration|disabled/i.test(String(s3Read.json.error));
    const httpBlocked = httpRead.json?.error != null && /disabled by configuration|disabled/i.test(String(httpRead.json.error));
    const unsignedFalse = String(unsigned.json?.rows?.[0]?.[0]).toLowerCase() === "false";
    const noSecrets = Number(secretsLeak.json?.rows?.[0]?.[0]) === 0;
    // disabled_filesystems is a CONSUMED (write-only) DuckDB setting: once applied it is
    // NOT reflected by current_setting() — it reads back '' (verified on the deployed
    // run). So the setting value is the wrong signal. The DIRECT, stronger proof that it
    // is in effect is that read_csv over s3:// and http:// fail with the VFS error "File
    // system S3FileSystem/HTTPFileSystem has been disabled by configuration" — which
    // DuckDB emits ONLY when that filesystem is in the disabled set. That is exactly what
    // s3Blocked && httpBlocked assert, so they ARE the disabled_filesystems proof.
    const fsList = String(disabledFs.json?.rows?.[0]?.[0] ?? "");
    const isolationOk = s3Blocked && httpBlocked && unsignedFalse && noSecrets;

    // FIFO: several /query dispatched together via Promise.all must serialize on the one
    // connection. peakDepth (the sidecar's monotonic high-water mark of queue depth) ≥ 2
    // proves they were queued at once — sound because the per-task decrement registers
    // before the caller's await continuation, so a LIVE queueDepth read could never
    // witness the overlap.
    //   Two pitfalls this avoids: (1) `count(*) FROM range(N)` is cardinality-optimized
    // in DuckDB (near-instant for ANY N) — a useless "slow" query that often finishes
    // before the other even arrives over the containerFetch round-trip → spurious
    // peakDepth=1. `sum(hash(i))` forces N real per-row hashes, so it stays busy
    // (hundreds of ms) while the others queue. (2) Racing only two queries is timing-
    // fragile; dispatching FOUR makes the overlap essentially deterministic (all four
    // enqueue before the first finishes), so peakDepth lands at ~4.
    const slowSql = "SELECT sum(hash(i)) AS s FROM range(20000000) t(i)";
    const fifoResults = await Promise.all(
      Array.from({ length: 4 }, () => sidecar(env, s2Id, "/query", { sql: slowSql })),
    );
    const peak = Math.max(...fifoResults.map((r) => Number(r.json?.peakDepth ?? 0)));
    const fifoOk = fifoResults.every((r) => r.status === 200) && peak >= 2;

    return {
      step: "s2",
      ok: durabilityOk && isolationOk && fifoOk,
      sandboxId: s2Id,
      durability: { ok: durabilityOk, answer },
      isolation: {
        ok: isolationOk, s3Blocked, httpBlocked, unsignedFalse, noSecrets,
        s3Error: s3Read.json?.error ?? null, httpError: httpRead.json?.error ?? null,
        allowUnsignedExtensions: unsigned.json?.rows?.[0]?.[0] ?? null,
        duckdbSecretsCount: secretsLeak.json?.rows?.[0]?.[0] ?? null,
        // '' by design (consumed setting); the s3Blocked/httpBlocked errors are the proof.
        disabledFilesystems: fsList,
      },
      fifo: { ok: fifoOk, peakDepth: peak, concurrency: fifoResults.length, perCallPeak: fifoResults.map((r) => r.json?.peakDepth) },
    };
  } finally {
    await destroyQuietly(env, s2Id);
  }
}

// ── /s3: encrypted-at-rest (ciphertext on R2 + wrong-key reopen fails) ───────────
async function step3(env: Env, objectKey: string): Promise<Record<string, unknown>> {
  // (a) PROBE-HARNESS read (NOT the Model-B data path): presigned GET Range bytes=0-3.
  // A plaintext DuckDB file starts with the 'DUCK' magic; an encrypted one is ciphertext.
  const headUrl = await mintPresigned(env, "GET", objectKey);
  const headRes = await fetch(headUrl, { method: "GET", headers: { Range: "bytes=0-3" } });
  const firstBytes = headRes.ok ? new Uint8Array(await headRes.arrayBuffer()) : new Uint8Array();
  // Require exactly 4 bytes (Range honored, 206): if R2 ignored Range and returned the
  // whole object, later plaintext bytes could mask the magic and falsely pass.
  const rangeHonored = firstBytes.length === 4;
  const magic = new TextDecoder().decode(firstBytes.slice(0, 4));
  const notPlaintext = headRes.ok && rangeHonored && magic !== "DUCK";

  // (b) Wrong-key reopen: a FRESH, UNBOOTED instance whose first /init carries a wrong
  // key must fail at ATTACH (a booted instance's 2nd /init is a no-op, so this is only
  // testable cold). ensureWorkspace throws when /init 500s.
  const s3Id = rid("ws-c");
  let wrongKeyRejected = false;
  let wrongKeyError: string | null = null;
  try {
    await ensureWorkspace(env, s3Id, WRONG_KEY, objectKey, { getStatus404Ok: false });
    wrongKeyRejected = false; // unexpected: init succeeded with the wrong key
  } catch (e) {
    wrongKeyRejected = true;
    wrongKeyError = e instanceof Error ? e.message : String(e);
  } finally {
    await destroyQuietly(env, s3Id);
  }

  const encryptedAtRestOk = notPlaintext && wrongKeyRejected;
  return {
    step: "s3",
    ok: encryptedAtRestOk,
    encryptedAtRest: {
      ok: encryptedAtRestOk, notPlaintext, rangeHonored,
      firstBytesHex: Array.from(firstBytes).map((b) => b.toString(16).padStart(2, "0")).join(""),
      magicAttempt: magic, wrongKeyRejected, wrongKeyError,
    },
  };
}

const HELP =
  "Stage C workspace probe (WorkspaceSandbox DO + Sandbox container, Model B).\n" +
  "Run as three short requests (one cold container each; a single combined request\n" +
  "exceeds the edge timeout):\n" +
  "  1) GET /s1                      -> { objectKey, createOk, snapshotOk }\n" +
  "  2) GET /s2?objectKey=<from s1>  -> { durability, isolation, fifo }\n" +
  "  3) GET /s3?objectKey=<from s1>  -> { encryptedAtRest }\n" +
  "WSDO-PASS = createOk && snapshotOk && durability && isolation && encryptedAtRest && fifo.\n";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const objectKey = url.searchParams.get("objectKey") ?? "";
    try {
      if (url.pathname === "/s1") return Response.json(await step1(env));
      if (url.pathname === "/s2") {
        if (!objectKey) return Response.json({ step: "s2", ok: false, error: "missing ?objectKey" }, { status: 400 });
        return Response.json(await step2(env, objectKey));
      }
      if (url.pathname === "/s3") {
        if (!objectKey) return Response.json({ step: "s3", ok: false, error: "missing ?objectKey" }, { status: 400 });
        return Response.json(await step3(env, objectKey));
      }
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined },
        { status: 500 },
      );
    }
    return new Response(HELP, { status: 200 });
  },
};
