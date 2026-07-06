import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ResolvedCredentials } from "./credentials";
/**
 * Mutable link state shared with the data tools. `creds` is null until a link is
 * claimed; the data tools read `state.creds` on every call so a mid-session
 * claim takes effect immediately.
 */
export interface LinkState {
    creds: ResolvedCredentials | null;
    deviceId: string;
    /** poll_token of the in-flight link, set by waddling_signup. */
    pollToken?: string;
    verifyUrl?: string;
    /** Profile name the in-flight signup will persist the claimed key into. */
    profileName?: string;
}
/** The structured payload every gated data tool returns while unlinked. */
export declare function notLinked(): CallToolResult;
export declare function registerOnboardingTools(server: McpServer, state: LinkState): void;
