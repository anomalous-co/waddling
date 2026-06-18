import { DuckDBInstance } from "@duckdb/node-api";

function norm(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) !== Object.prototype) return String(v);
  return v;
}

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

  const tests: [string, string][] = [
    ["orders", "FROM remote.query('FROM lake.sales.orders LIMIT 2')"],
    ["customers (name,email)", "FROM remote.query('SELECT name, email FROM lake.sales.customers LIMIT 1')"],
    ["customers (ssn)", "FROM remote.query('SELECT ssn FROM lake.sales.customers LIMIT 1')"],
    ["aggregate", "FROM remote.query('SELECT status, COUNT(*) as cnt FROM lake.sales.orders GROUP BY status ORDER BY cnt DESC')"],
  ];

  for (const [label, sql] of tests) {
    try {
      const reader = await conn.runAndReadAll(sql);
      const cols = reader.columnNames();
      const rows = reader.getRowObjects().map(r => Object.fromEntries(cols.map(c => [c, norm(r[c as any])])));
      console.log(`✅ ${label}:`);
      console.log(JSON.stringify(rows.slice(0, 3), null, 2));
      if (rows.length > 3) console.log(`   ... ${rows.length} total rows`);
    } catch (err) {
      console.log(`❌ ${label}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
}

main().catch(err => console.error("FATAL:", err.message));
