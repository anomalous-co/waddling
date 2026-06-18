import { DuckDBInstance } from "@duckdb/node-api";

async function main() {
  const resp = await fetch("http://localhost:8810/", {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_agent_analyst_demo",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "waddling_connect", arguments: { endpoint_id: "a4c3cb44-640c-44b7-a8da-62795496c922" } },
      id: 1,
    }),
  });
  const text = await resp.text();
  let jwt = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) jwt = JSON.parse(line.slice(6)).result.structuredContent.session_jwt;
  }

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL quack; LOAD quack; INSTALL httpfs; LOAD httpfs;");
  await conn.run(`CREATE SECRET (TYPE quack, TOKEN '${jwt.replace(/'/g, "''")}', SCOPE 'quack:localhost:9500');`);
  await conn.run("ATTACH 'quack:localhost:9500' AS remote (disable_ssl true);");

  // Use query() as baseline
  console.log("=== query() baseline ===");
  for (const [label, inner] of [
    ["orders", "FROM lake.sales.orders LIMIT 2"],
    ["ssn", "SELECT ssn FROM lake.sales.customers LIMIT 1"],
    ["name/email", "SELECT name, email FROM lake.sales.customers LIMIT 1"],
  ] as const) {
    try {
      const reader = await conn.runAndReadAll(`FROM remote.query('${inner}')`);
      console.log(`  ✅ ${label}: ${reader.getRowObjects().length} rows`);
    } catch (err) {
      console.log(`  ❌ ${label}: ${(err as Error).message.slice(0, 100)}`);
    }
  }
}

main().catch(err => console.error("FATAL:", err.message));
