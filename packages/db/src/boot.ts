// Smoke test: boot the stack and run a local aggregate without any web layer.
// Run via: pnpm --filter @pglite-sandbox/db boot
import { getStack } from "./stack.ts";
import { getAnalytics } from "./analytics.ts";

const stack = await getStack();
console.log(`[boot] stack up for instance ${stack.config.instance}`);
console.log("[boot] analytics:", await getAnalytics());
console.log("[boot] OK — stack initialized without throwing");
process.exit(0);
