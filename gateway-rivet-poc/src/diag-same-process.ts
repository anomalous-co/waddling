// DIAGNOSTIC (no Rivet, no proxy): does a quack CLIENT and a quack SERVER in the
// SAME OS process collide? Reproduces the agent-actor topology minus Rivet:
// boot the gateway (quack_serve) and a second DuckDB that ATTACHes to it, all in
// one process, then run a scan. If this throws "Missing hostname", the failure
// is a same-process quack limitation — orthogonal to Rivet — and the fix is to
// run agent vs gateway in separate processes/pools (which verify-b already does).

import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bootDuckRuntime, applySnapshot } from "../../packages/gateway/src/duck.ts";
import type { GatewayConfig } from "../../packages/gateway/src/config.ts";

const POC_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO_ROOT = resolve(POC_ROOT, "..");
const LOCAL = resolve(POC_ROOT, ".local-diag");
const ENDPOINT = "diag";
const ISSUER = "poc-issuer";
const AUD = `gw:${ENDPOINT}`;
const KID = "k1";
const PRINCIPAL = "agent:demo";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  const dataDir = resolve(LOCAL, "data");
  mkdirSync(dataDir, { recursive: true });
  const config: GatewayConfig = {
    birdshotExtensionPath:
      process.env.BIRDSHOT_EXTENSION_PATH ??
      resolve(REPO_ROOT, "birdshot/build/release/extension/birdshot/birdshot.duckdb_extension"),
    quackPort: port, serverToken: "poc-server-token", ctrlPort: 0,
    ducklakeCatalogDsn: "", ducklakeCatalogFile: resolve(LOCAL, "lake.ducklake"),
    ducklakeDataPath: `${dataDir}/`, localData: true, lakeAlias: "lake", encrypted: false,
    s3: { endpoint: "", keyId: "", secret: "", region: "auto", useSsl: false, urlStyle: "path" },
  };

  // SERVER (quack_serve) in this process.
  const rt = await bootDuckRuntime(config);
  await rt.run("CREATE TABLE IF NOT EXISTS memory.main.allowed (id INTEGER, val VARCHAR)");
  await rt.run("INSERT INTO memory.main.allowed VALUES (1,'ok')");

  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  await applySnapshot(
    rt,
    { userRoles: [{ userId: PRINCIPAL, role: "r1" }], roleGrants: [{ role: "r1", tableRef: "main.allowed", action: "read" }] },
    { issuer: ISSUER, audience: AUD, jwks: [{ kid: KID, n: pub.n!, e: pub.e! }] },
  );
  const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUD)
    .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("5m").sign(privateKey);
  console.log(`server up on quack:localhost:${port}; policy applied`);

  // CLIENT (quack ATTACH) in the SAME process.
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  await conn.run("INSTALL quack; LOAD quack");
  await conn.run(`ATTACH 'quack:localhost:${port}' AS lake (TOKEN '${jwt}', DISABLE_SSL true)`);
  console.log("client ATTACHed (same process as server)");

  const rows = (await conn.runAndReadAll("SELECT * FROM lake.allowed")).getRowObjects();
  console.log("scan rows:", rows);
  console.log("\nRESULT: same-process client+server WORKS (so the actor failure is Rivet-runtime-specific, not quack same-process)");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nRESULT: same-process client+server FAILED →", e instanceof Error ? e.message : String(e));
  console.error("(confirms quack client+server collide in one process — agent & gateway must be separate pools)");
  process.exit(1);
});
