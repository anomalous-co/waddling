// waddling gateway runtime entrypoint (W3).
//
// One process per org endpoint: boots DuckDB + birdshot + DuckLake, serves the
// quack data-plane endpoint (quack_serve), and exposes the HTTP control channel
// (W1's gateway-client contract). See ARCHITECTURE.md §1, §3, §9-W3; ducklake.md
// (ATTACH + secrets); repo.md (quack/birdshot).
//
// There is NO agent data path in this process besides the birdshot-gated quack
// endpoint. The control channel runs control ops only (snapshot/revoke/describe/
// status); agent SQL never executes on the trusted control connection.
//
//   QUACK_PORT  data-plane quack endpoint (agents ATTACH 'quack:host:PORT'), birdshot-gated
//   CTRL_PORT   internal control HTTP server (this process)
import { loadGatewayConfig } from "./config";
import { bootDuckRuntime } from "./duck";
import { startCtrlServer } from "./ctrl-server";
async function main() {
    const config = loadGatewayConfig();
    console.log(`[gateway] booting DuckDB + birdshot (quack :${config.quackPort})`);
    const runtime = await bootDuckRuntime(config);
    console.log(`[gateway] DuckLake attached as '${config.lakeAlias}' from ${config.ducklakeDataPath}`);
    startCtrlServer(config.ctrlPort, { runtime });
    console.log(`[gateway] ctrl server on :${config.ctrlPort} (POST /gw/{snapshot,revoke,describe}, GET /gw/status)`);
    // Keep the process alive; quack_serve runs on a DuckDB background thread.
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
}
main().catch((err) => {
    console.error("[gateway] fatal:", err);
    process.exit(1);
});
