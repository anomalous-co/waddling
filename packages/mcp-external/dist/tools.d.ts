import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type WaddlingClient } from "./client";
import { type LinkState } from "./onboarding";
import type { Telemetry } from "./telemetry";
export declare function registerTools(server: McpServer, client: WaddlingClient, opts: {
    state: LinkState;
    telemetry: Telemetry;
}): void;
