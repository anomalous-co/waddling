// FORK B — public quack ingress (the "edge" in front of Rivet).
//
// An agent's DuckDB ATTACHes to `quack:127.0.0.1:7800` (this server). quack
// can't speak Rivet's `/gateway/{id}/request/...` URL scheme itself, so this
// thin HTTP proxy translates a plain quack POST into a RivetKit client call to
// the target gateway actor's onRequest handler. In production this role belongs
// to the waddling control-plane / MCP ingress, which already fronts the gateway.
//
//   agent DuckDB ──HTTP /quack──▶ proxy ──RivetKit .fetch──▶ gatewayActor.onRequest
//                                                              └─▶ loopback quack
//
// Run: `npm run proxy` (after the engine + `npm run dev`).

import { createServer } from "node:http";
import { createClient } from "rivetkit/client";
import type { registry } from "./registry.ts";

const RIVET_ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
const PORT = Number(process.env.QUACK_PROXY_PORT ?? 7800);

// Hop-by-hop headers that must not cross the proxy hop (Node sets its own).
const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding",
  "keep-alive", "upgrade", "proxy-connection", "te", "trailer",
]);

const client = createClient<typeof registry>(RIVET_ENDPOINT);

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }

    const path = req.url ?? "/quack";

    // PoC: route ALL quack traffic to one endpoint actor. Production decodes the
    // session JWT's `aud` claim (gw:<endpointId>) from the request to pick
    // [org, endpointId] — sidestepped here. (Open Q: does quack send the TOKEN
    // on every request, or only the ATTACH handshake? The PoC doesn't depend on
    // it because routing is static.)
    const gw = client.gateway.getOrCreate(["poc-org", "poc-endpoint"]);

    // Pass a RequestInit dict (NOT a Request object — the client doesn't carry
    // method/body off a Request passed as init). Body is a raw Buffer, so no
    // duplex/stream needed.
    const resp = await gw.fetch(path, {
      method: req.method,
      headers,
      body: body.length ? new Uint8Array(body) : undefined,
    });

    res.statusCode = resp.status;
    resp.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) res.setHeader(k, v);
    });
    res.end(Buffer.from(await resp.arrayBuffer()));
  } catch (e) {
    res.statusCode = 502;
    res.end(`quack proxy error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `quack proxy on http://127.0.0.1:${PORT} → Rivet gateway actor [poc-org, poc-endpoint]`,
  );
});
