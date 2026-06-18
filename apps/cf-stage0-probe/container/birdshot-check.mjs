// Probe #2 (birdshot half): prove the distributed birdshot extension loads inside
// the SAME base image the workspace sidecar uses. birdshot itself runs in the
// GATEWAY only (the sidecar loads quack+httpfs, NOT birdshot) — this check
// de-risks the FUTURE gateway image by confirming the published artifact installs
// and loads on this linux/amd64 glibc base, and tells us empirically whether it
// requires allow_unsigned_extensions.
//
// Two paths are tested independently:
//   A) signed path  : INSTALL birdshot FROM repo; LOAD birdshot;  (unsigned OFF)
//   B) unsigned path : SET allow_unsigned_extensions=true; INSTALL …; LOAD …
// The brief states birdshot is SIGNED (loads without unsigned). We REPORT which
// path actually works rather than assume — it determines the gateway image config.
//
// env: BIRDSHOT_REPO (default https://ext.getwaddling.com)

import { DuckDBInstance } from "@duckdb/node-api";
import dns from "node:dns/promises";

const REPO = process.env.BIRDSHOT_REPO || "https://ext.getwaddling.com";
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

async function loadStatus(con) {
  try {
    const r = await con.runAndReadAll(
      "SELECT extension_version, loaded, installed FROM duckdb_extensions() WHERE extension_name='birdshot'",
    );
    return r.getRowObjects()[0] ?? null;
  } catch (e) { return { error: e.message.split("\n")[0] }; }
}

console.log(`\n=== Probe #2 (birdshot): load published artifact from ${REPO} on this base image ===`);

// Reachability preflight: this probe needs egress to the birdshot CDN. Some local
// environments cannot resolve the public custom domain (DNS sandboxing). In that
// case the result is PENDING (env limitation), NOT a birdshot failure — distinguish
// the two so a CI/dev DNS quirk is never mistaken for a broken artifact.
const repoHost = new URL(REPO).hostname;
let reachable = true, reachDetail = "";
try {
  const addrs = await dns.resolve4(repoHost);
  reachDetail = `resolves to ${addrs[0]}`;
} catch (e) {
  reachable = false;
  reachDetail = `DNS ${e.code} for ${repoHost}`;
}
if (!reachable) {
  // Show the EXACT URL DuckDB will construct (so the layout is verifiable against
  // the R2 bucket: v<ver>/<platform>/birdshot.duckdb_extension[.gz]).
  const builtUrl = `${REPO}/v1.5.3/linux_amd64/birdshot.duckdb_extension(.gz)`;
  console.log(`  PENDING  birdshot CDN unreachable from this environment — ${reachDetail}`);
  console.log(`           loader would fetch: ${builtUrl}`);
  console.log(`           Re-run where ${repoHost} resolves to clear this. NOT a birdshot defect.`);
  console.log(`\n  VERDICT: birdshot load UNVERIFIED (CDN unreachable here) — re-run with egress to ${repoHost}`);
  process.exit(2); // 2 = PENDING (distinct from 0=pass, 1=fail)
}

// Version context.
{
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  const ver = await c.runAndReadAll("PRAGMA version");
  const v = ver.getRowObjects()[0];
  check("DuckDB v1.5.3 (matches birdshot pin)", String(v.library_version ?? v.version).includes("1.5.3"), String(v.library_version ?? v.version));
}

// ── Path A: signed (unsigned OFF) ─────────────────────────────────────────────
let signedWorks = false, signedDetail = "";
try {
  const inst = await DuckDBInstance.create(":memory:"); // allow_unsigned NOT set => default false
  const c = await inst.connect();
  await c.run(`INSTALL birdshot FROM '${REPO}';`);
  await c.run("LOAD birdshot;");
  const st = await loadStatus(c);
  signedWorks = !!st && st.loaded === true;
  signedDetail = signedWorks ? `v=${st.extension_version}` : JSON.stringify(st);
} catch (e) {
  signedDetail = e.message.split("\n")[0];
}
check("birdshot INSTALL FROM repo + LOAD with unsigned OFF (signed path)", signedWorks, signedDetail);

// ── Path B: unsigned ON (fallback) ────────────────────────────────────────────
let unsignedWorks = false, unsignedDetail = "";
try {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await inst.connect();
  await c.run(`INSTALL birdshot FROM '${REPO}';`);
  await c.run("LOAD birdshot;");
  const st = await loadStatus(c);
  unsignedWorks = !!st && st.loaded === true;
  unsignedDetail = unsignedWorks ? `v=${st.extension_version}` : JSON.stringify(st);
} catch (e) {
  unsignedDetail = e.message.split("\n")[0];
}
check("birdshot INSTALL FROM repo + LOAD with unsigned ON (fallback path)", unsignedWorks, unsignedDetail);

// ── Functional smoke: a birdshot_* control fn exists once loaded ──────────────
if (signedWorks || unsignedWorks) {
  const inst = await DuckDBInstance.create(":memory:", signedWorks ? {} : { allow_unsigned_extensions: "true" });
  const c = await inst.connect();
  await c.run(`INSTALL birdshot FROM '${REPO}';`);
  await c.run("LOAD birdshot;");
  let fnOk = false, fnDetail = "";
  try {
    const r = await c.runAndReadAll("SELECT function_name FROM duckdb_functions() WHERE function_name LIKE 'birdshot%' ORDER BY function_name");
    const fns = r.getRowObjects().map((x) => x.function_name);
    fnOk = fns.length > 0;
    fnDetail = fns.join(", ");
  } catch (e) { fnDetail = e.message.split("\n")[0]; }
  check("birdshot_* control functions registered after LOAD", fnOk, fnDetail);
}

console.log(`\n  VERDICT: birdshot loads ${signedWorks ? "SIGNED (no unsigned flag needed)" : unsignedWorks ? "ONLY with allow_unsigned_extensions=true" : "NOT AT ALL"}`);
console.log(`  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
// A FAIL on the signed path is INFORMATIVE, not fatal to Stage 0 (it just tells the
// gateway image which flag to set). Only hard-fail if birdshot won't load at all.
process.exit((signedWorks || unsignedWorks) ? 0 : 1);
