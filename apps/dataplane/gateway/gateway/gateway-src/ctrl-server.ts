// Gateway HTTP control server (W3).
//
// Implements W1's gateway-client contract on CTRL_PORT. ALL routes are internal
// (control plane → gateway). There is no agent data path here: agent SQL reaches
// the lake through exactly one path — a quack connection into the gateway, gated
// by birdshot_authorize. This server's connection runs CONTROL ops only.
//
//   POST /gw/snapshot    apply a BirdshotSnapshot (§3e) via birdshot_* calls
//   POST /gw/revoke      birdshot_revoke (instant denylist)
//   POST /gw/describe    introspect lake columns/types (control plane filters)
//   GET  /gw/status      birdshot_status() + ducklake snapshot info
//   POST /gw/query       RETIRED → 410 { error:'use_mcp_session' } (data path is /mcp)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  applySnapshot,
  birdshotRevoke,
  birdshotStatus,
  describeTables,
  ducklakeSnapshot,
  type DuckRuntime,
} from "./duck";

interface SnapshotBody {
  // CONFIG-ONLY (spec §13): no grant tuples — birdshot pulls literal GRANT/DENY SQL from the
  // ATTACHed store. `endpointId` (the datalakeId) scopes that pull; `grantStoreDsn` is the
  // read-only Postgres DSN the gateway ATTACHes as the protected `__birdshot` catalog.
  endpointId?: string;
  auth?: { issuer: string; audience: string; jwks?: { kid: string; n: string; e: string }[] };
  lakeCatalog?: string;
  grantStoreDsn?: string;
}

interface RevokeBody {
  kind: "user" | "jti" | "session";
  id: string;
  reason: string;
  expiresUs?: number;
}

interface DescribeBody {
  /** Restrict introspection to these "schema.table" refs (the agent's grants). */
  tables?: { schema: string; table: string }[];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export interface CtrlServerDeps {
  runtime: DuckRuntime;
}

export function startCtrlServer(port: number, deps: CtrlServerDeps): ReturnType<typeof createServer> {
  const { runtime } = deps;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] ctrl ${req.method} ${req.url} → 500: ${reason}`);
      send(res, 500, { error: "internal_error", reason });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = (req.url ?? "/").split("?")[0];

    if (method === "GET" && url === "/gw/health") {
      return send(res, 200, { ok: true });
    }

    if (method === "GET" && url === "/gw/status") {
      const [status, lake] = await Promise.all([birdshotStatus(runtime), ducklakeSnapshot(runtime)]);
      return send(res, 200, {
        birdshot: status,
        ducklake: lake,
      });
    }

    if (method === "POST" && url === "/gw/snapshot") {
      const body = await readJson<SnapshotBody>(req);
      await applySnapshot(runtime, {
        auth: body.auth,
        grantStoreDsn: body.grantStoreDsn,
        datalakeId: body.endpointId,
      });
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/gw/revoke") {
      const body = await readJson<RevokeBody>(req);
      if (!body.kind || !body.id) return send(res, 400, { error: "bad_request", reason: "missing kind/id" });
      await birdshotRevoke(runtime, body.kind, body.id, body.reason ?? "", body.expiresUs);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/gw/describe") {
      // Internal route (control plane → gateway). Returns FULL columns/types for
      // the requested tables; the control plane filters to the agent's grants
      // (columns included) before any of this reaches a client.
      const body = await readJson<DescribeBody>(req);
      const tables = await describeTables(runtime, body.tables);
      return send(res, 200, { tables });
    }

    if (method === "POST" && url === "/gw/query") {
      // RETIRED. This route used to execute agent SQL on the gateway's TRUSTED
      // control connection (the one privileged to call birdshot_* mutators) —
      // the single bypass of the birdshot chokepoint. The agent data path is now
      // the MCP session → per-agent workspace actor → quack into the gateway,
      // gated by birdshot_authorize. There is no SQL execution on this server.
      return send(res, 410, {
        error: "use_mcp_session",
        reason:
          "POST /gw/query is retired. Run queries through an MCP session (waddling_connect → waddling_query); agent SQL reaches the lake only via the birdshot-gated quack path.",
      });
    }

    return send(res, 404, { error: "not_found", reason: `no route ${method} ${url}` });
  }

  server.listen(port);
  return server;
}
