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
import { createServer } from "node:http";
import { applySnapshot, birdshotRevoke, birdshotStatus, describeTables, ducklakeSnapshot, } from "./duck";
function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
}
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw)
        return {};
    return JSON.parse(raw);
}
export function startCtrlServer(port, deps) {
    const { runtime } = deps;
    const server = createServer((req, res) => {
        void handle(req, res).catch((err) => {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[gateway] ctrl ${req.method} ${req.url} → 500: ${reason}`);
            send(res, 500, { error: "internal_error", reason });
        });
    });
    async function handle(req, res) {
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
            const body = await readJson(req);
            if (!body.snapshot)
                return send(res, 400, { error: "bad_request", reason: "missing snapshot" });
            await applySnapshot(runtime, body.snapshot, body.auth);
            return send(res, 200, { ok: true, grants: body.snapshot.roleGrants.length });
        }
        if (method === "POST" && url === "/gw/revoke") {
            const body = await readJson(req);
            if (!body.kind || !body.id)
                return send(res, 400, { error: "bad_request", reason: "missing kind/id" });
            await birdshotRevoke(runtime, body.kind, body.id, body.reason ?? "", body.expiresUs);
            return send(res, 200, { ok: true });
        }
        if (method === "POST" && url === "/gw/describe") {
            // Internal route (control plane → gateway). Returns FULL columns/types for
            // the requested tables; the control plane filters to the agent's grants
            // (columns included) before any of this reaches a client.
            const body = await readJson(req);
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
                reason: "POST /gw/query is retired. Run queries through an MCP session (waddling_connect → waddling_query); agent SQL reaches the lake only via the birdshot-gated quack path.",
            });
        }
        return send(res, 404, { error: "not_found", reason: `no route ${method} ${url}` });
    }
    server.listen(port);
    return server;
}
