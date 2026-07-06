// Build @waddling/mcp for npm distribution.
//
// esbuild bundles src/index.ts → dist/index.js as a single ESM file. Runtime deps
// (@modelcontextprotocol/sdk, zod, posthog-node) stay external (real
// dependencies); the only workspace import (@waddling/control-schema) is
// type-only, so it erases at build and never reaches the bundle — which is why it
// lives in devDependencies and the published package has zero workspace deps.

import { build } from "esbuild";
import { chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outfile = join(dist, "index.js");

// Clean stale artifacts so the tarball only carries the fresh bundle + d.ts.
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  // The entry file's `#!/usr/bin/env node` hashbang is preserved by esbuild.
  logLevel: "info",
});

// Make the bin runnable via `npx -y @waddling/mcp`.
chmodSync(outfile, 0o755);
console.error(`[build] wrote ${outfile}`);
