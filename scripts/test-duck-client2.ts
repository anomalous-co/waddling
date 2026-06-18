import { DuckDBInstance } from "@duckdb/node-api";

async function main() {
  // Get JWT from MCP
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
    if (line.startsWith("data: ")) {
      const sc = JSON.parse(line.slice(6)).result.structuredContent;
      jwt = sc.session_jwt;
      console.log(`session: ${sc.session_id.slice(0, 8)}…`);
      console.log(`granted: ${JSON.stringify(sc.granted.tables.map((t: any) => `${t.schema}.${t.table}[${t.verbs}]${t.columns ? " cols=" + t.columns.join(",") : ""}`))}`);
      break;
    }
  }

  // Boot in-memory DuckDB
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL quack; LOAD quack; INSTALL httpfs; LOAD httpfs;");
  await conn.run(`CREATE SECRET (TYPE quack, TOKEN '${jwt.replace(/'/g, "''")}', SCOPE 'quack:localhost:9500');`);
  await conn.run("ATTACH 'quack:localhost:9500' AS remote (disable_ssl true);");

  const queries: [string, string][] = [
    ["direct FROM orders", "FROM remote.sales.orders LIMIT 2"],
    ["direct FROM customers", "FROM remote.sales.customers LIMIT 1"],
    ["query() ssn", "FROM remote.query('SELECT ssn FROM lake.sales.customers LIMIT 1')"],
    ["query() name/email", "FROM remote.query('SELECT name, email FROM lake.sales.customers LIMIT 1')"],
    ["query() orders", "FROM remote.query('FROM lake.sales.orders LIMIT 2')"],
  ];

  for (const [label, sql] of queries) {
    try {
      const reader = await conn.runAndReadAll(sql);
      const cols = reader.columnNames();
      const rows = reader.getRowObjects();
      console.log(`\n✅ ${label}: ${rows.length} rows, cols=[${cols.join(",")}]`);
      if (rows.length <= 2) console.log(`   ${JSON.stringify(rows[0])}`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 100);
      console.log(`\n❌ ${label}: ${msg}`);
    }
  }
}

main().catch(err => console.error("FATAL:", err.message));
