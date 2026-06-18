// Minimal Rivet registry for the workspace session actor — kept separate from the
// proven fork-A/B registry.ts so the workspace path can be exercised on its own
// (no gateway/birdshot boot needed). Run: tsx src/workspace-registry.ts (after the
// rivet-engine is up on :6420), then tsx src/verify-workspace.ts.

import { setup } from "rivetkit";
import { workspace } from "./workspace-actor.ts";

export const registry = setup({ use: { workspace } });

registry.start();
