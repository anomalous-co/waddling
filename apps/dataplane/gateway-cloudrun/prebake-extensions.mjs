// Build-time extension pre-bake. Cold-boot was dominated by the gateway downloading
// its DuckDB extensions (quack/httpfs/ducklake/postgres/fts) from the network on EVERY
// boot. We INSTALL them here, at image-build time, into a FIXED extension_directory baked
// into the image; bootDuckRuntime opens DuckDB with the SAME extension_directory, so its
// INSTALL statements become local cache hits (no network) and boot is fast.
//
// Must run with the SAME @duckdb/node-api version the gateway uses (the image's npm install),
// so the cached extensions match the runtime's version/platform path
// (<extension_directory>/v<ver>/<platform>/<ext>.duckdb_extension). birdshot is NOT baked here
// — it is a path-LOADed unsigned extension already COPYed into the image.
import { DuckDBInstance } from "@duckdb/node-api";

const EXT_DIR = process.env.DUCKDB_EXTENSION_DIR || "/opt/duckdb-extensions";
// Bake the gateway's extensions so boot is a local cache hit, no network. quack installs
// from DuckDB's DEFAULT repo (verified) — bake it so flipping serveQuack on for a native
// agent-ATTACH transport (WF-3) needs no network. httpfs = GCS; ducklake+postgres = the lake.
const EXTENSIONS = ["httpfs", "quack", "ducklake", "postgres"];

const inst = await DuckDBInstance.create(":memory:", {
  allow_unsigned_extensions: "true",
  extension_directory: EXT_DIR,
});
const c = await inst.connect();

let failed = [];
for (const ext of EXTENSIONS) {
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      await c.run(`INSTALL ${ext}`);
      ok = true;
      console.log(`[prebake] INSTALL ${ext} → cached in ${EXT_DIR}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[prebake] INSTALL ${ext} attempt ${attempt}/3 failed: ${msg}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  if (!ok) failed.push(ext);
}

if (failed.length) {
  // Don't fail the build — boot still works by downloading the missing one (slow path).
  // But make it LOUD so a regressed cold-boot is traceable to an un-baked extension.
  console.log(`[prebake] WARNING: not baked (boot will download these): ${failed.join(", ")}`);
} else {
  console.log(`[prebake] all extensions baked: ${EXTENSIONS.join(", ")}`);
}
