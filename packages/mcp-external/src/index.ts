#!/usr/bin/env node
// waddling External MCP server (W3) — data plane, for the org's analytics agents.
//
// Exposes the 8 §4a tools as a thin client of the control-plane REST API. Ships
// over stdio (default; for `npx @waddling/mcp` / `claude mcp add`) and over
// streamable HTTP (`--http`, env PORT) for remote hosts. Holds NO DB creds — auth
// is the org API key in env WADDLING_API_KEY against WADDLING_URL.
//
//   stdio:  npx -y @waddling/mcp@latest
//   http :  waddling-mcp --http   (listens on $PORT, default 8810)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WaddlingClient } from "./client";
import { registerTools } from "./tools";
import { registerOnboardingTools, type LinkState } from "./onboarding";
import { createTelemetry, type Telemetry } from "./telemetry";
import { getOrCreateDeviceId, resolveCredentials, onboardingBaseUrl } from "./credentials";

// Process-wide telemetry (flushed on exit). Bound to the stable device id.
const DEVICE_ID = getOrCreateDeviceId();
const TELEMETRY: Telemetry = createTelemetry(DEVICE_ID);

function buildServer(reqApiKey?: string): McpServer {
  // Resolve credentials up front; null => ONBOARDING MODE (signup tools + gated
  // data tools). LinkState is mutable so a mid-session claim unlocks everything
  // without a restart (the data tools read state.creds on every call).
  //
  // Over remote HTTP, each client presents its OWN org API key in the request's
  // Authorization: Bearer header (the server is multi-tenant and holds no creds
  // of its own). That per-request key takes precedence over any env fallback, so
  // distinct agents (e.g. analyst vs etl-bot) are correctly scoped. stdio mode
  // has no per-request header, so it falls back to env (resolveCredentials).
  const envCreds = resolveCredentials();
  const creds = reqApiKey
    ? { apiKey: reqApiKey, baseUrl: envCreds?.baseUrl ?? onboardingBaseUrl(), source: "env" as const }
    : envCreds;
  const state: LinkState = { creds, deviceId: DEVICE_ID };

  // Startup funnel split: already-linked → mcp_connect; cold/unlinked → onboarding.
  if (state.creds) {
    TELEMETRY.capture("mcp_connect", { source: state.creds.source });
  } else {
    TELEMETRY.capture("mcp_onboarding_started", {});
  }

  // Client resolves {baseUrl, apiKey} live from LinkState on every request.
  const client = new WaddlingClient(() => {
    if (!state.creds) throw new Error("not linked — run waddling_signup first");
    return { baseUrl: state.creds.baseUrl, apiKey: state.creds.apiKey };
  });

  const server = new McpServer(
    { name: "waddling", version: "0.1.0" },
    {
      instructions:
        "waddling governs AI-agent access to analytics lakehouses. If a tool returns " +
        "{ error:'not_linked' }, run waddling_signup (show the human the link + code), then poll " +
        "waddling_signup_status until connected — then retry. Once connected: waddling_list_endpoints, " +
        "waddling_describe to learn the catalog you're allowed to see, waddling_connect to open a " +
        "session, waddling_query to run governed SQL. Use waddling_whoami / waddling_explain to check " +
        "permissions WITHOUT triggering denials. Denials are structured { error, table, reason } — read " +
        "`reason` and self-correct.",
    },
  );

  // Onboarding tools are always present (idempotent once linked); the 8 data
  // tools self-gate via state.creds.
  registerOnboardingTools(server, state);
  registerTools(server, client, { state, telemetry: TELEMETRY });
  return server;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio: process stays alive on the transport; nothing more to do.
}

async function runHttp(port: number): Promise<void> {
  // OAuth resource-server config (delegated MCP auth — agent-auth.md). This server is
  // the OAuth *resource*; the control plane (WADDLING_URL) is the authorization
  // server. RESOURCE_URL is what Claude binds its token audience to (RFC 8707) and
  // MUST equal the control plane's WADDLING_MCP_RESOURCE.
  const RESOURCE_URL = process.env.WADDLING_MCP_RESOURCE ?? `http://localhost:${port}`;
  const AUTH_SERVER = onboardingBaseUrl();
  const PROTECTED_RESOURCE_METADATA = JSON.stringify({
    resource: RESOURCE_URL,
    authorization_servers: [AUTH_SERVER],
    bearer_methods_supported: ["header"],
  });
  // Opt-in: when set, an MCP request with NO Authorization header gets a 401 +
  // WWW-Authenticate so OAuth-capable clients (Claude) start the consent flow.
  // Default off so anonymous device-link onboarding over HTTP still works.
  const OAUTH_ENABLED = process.env.WADDLING_MCP_OAUTH === "1";

  // Stateless streamable HTTP: a fresh server+transport per request keeps the
  // server horizontally scalable and avoids cross-request session state (each
  // call already carries its own WADDLING_API_KEY-derived auth via env/headers).
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = req.url ? req.url.split("?")[0] : "/";
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // OAuth Protected Resource Metadata (RFC 9728) — points Claude at the auth server.
      if (path === "/.well-known/oauth-protected-resource") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(PROTECTED_RESOURCE_METADATA);
        return;
      }
      // OAuth challenge: no credential present → tell the client how to authenticate.
      if (OAUTH_ENABLED && !req.headers["authorization"]) {
        res.writeHead(401, {
          "content-type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "unauthorized", reason: "authenticate via OAuth" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }));
        return;
      }
      // Per-request org API key from Authorization: Bearer (multi-tenant).
      const authz = req.headers["authorization"] ?? "";
      const reqApiKey = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : undefined;
      const server = buildServer(reqApiKey || undefined);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error", reason: err instanceof Error ? err.message : String(err) }));
      }
    });
  });
  httpServer.listen(port, () => {
    console.error(`[waddling-mcp] streamable HTTP on :${port} (POST /)`);
  });
}

async function shutdown(code = 0): Promise<void> {
  await TELEMETRY.shutdown();
  process.exit(code);
}

async function main(): Promise<void> {
  // Flush telemetry before the process dies.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void shutdown(0);
    });
  }

  const http = process.argv.includes("--http");
  if (http) {
    const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? "8810");
    await runHttp(port);
  } else {
    await runStdio();
  }
}

main().catch((err: unknown) => {
  console.error("[waddling-mcp] fatal:", err instanceof Error ? err.message : err);
  void TELEMETRY.shutdown().finally(() => process.exit(1));
});
