import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Each instance (A/B) runs `next dev` from this same directory; a distinct
  // distDir per instance keeps their build output and dev-server locks separate
  // so two instances can run at once.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Allow loading dev resources (HMR, client chunks) from either localhost
  // hostname; otherwise Next 16 blocks cross-origin requests and hydration
  // silently fails when the app is opened via 127.0.0.1.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // The quack stack package is shipped as TypeScript source; let Next transpile it.
  transpilePackages: ["@pglite-sandbox/db"],
  // Native / Node-only deps must not be bundled — load them via Node require().
  serverExternalPackages: [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    "@electric-sql/pglite",
    "@electric-sql/pglite-socket",
  ],
  // Pin the workspace root so Turbopack doesn't infer a stray parent lockfile.
  turbopack: {
    root: join(here, "..", ".."),
  },
};

export default nextConfig;
