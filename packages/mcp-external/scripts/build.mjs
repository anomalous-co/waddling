// Build @waddling/mcp for npm distribution AND MCPB packaging.
//
// Two outputs:
//   1. dist/index.js      — external deps (npm bundle, ~47 KB)
//   2. dist/index.mcpb.js  — self-contained (MCPB single-file, all deps inlined)
//
// Runtime deps (@modelcontextprotocol/sdk, zod, posthog-node) stay external in
// the npm build (real dependencies); the only workspace import
// (@waddling/control-schema) is type-only, so it erases at build and never
// reaches the bundle — which is why it lives in devDependencies and the
// published package has zero workspace deps.
//
// The MCPB build inlines everything (all three runtime deps are pure JS, so
// esbuild can safely bundle them). No node_modules needed in the .mcpb zip.

import { build } from "esbuild";
import { chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// --- CL args ---
const selfContained = process.argv.includes("--self-contained");

// --- npm build (always) ---
if (!selfContained) {
  // Clean stale artifacts so the tarball only carries the fresh bundle + d.ts.
  rmSync(dist, { recursive: true, force: true });
}

const npmOut = join(dist, "index.js");
await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: npmOut,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  // The entry file's `#!/usr/bin/env node` hashbang is preserved by esbuild.
  logLevel: "info",
});
chmodSync(npmOut, 0o755);
console.error(`[build]       wrote ${npmOut}`);

// --- MCPB self-contained build ---
// Inlines all deps so the .mcpb zip is a single file — no node_modules needed.
// All three runtime deps (@modelcontextprotocol/sdk, zod, posthog-node) are
// pure JavaScript with no native addons, so esbuild can safely bundle them.
if (selfContained) {
  const mcpbOut = join(dist, "index.mcpb.js");
  await build({
    entryPoints: [join(root, "src", "index.ts")],
    outfile: mcpbOut,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // No "packages: external" — inline everything.
    logLevel: "info",
  });
  chmodSync(mcpbOut, 0o755);
  console.error(`[build:mcpb]  wrote ${mcpbOut}`);
}
