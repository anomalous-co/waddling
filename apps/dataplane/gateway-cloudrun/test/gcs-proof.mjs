// Proves the GCS parquet WRITE path (DuckLake DATA_PATH = s3://…@storage.googleapis.com via HMAC
// interop). The bring-up dial-in data was tiny → DuckLake inlined it in the Postgres catalog, so
// GCS stayed empty. Here a large governed CTAS exceeds the inline threshold, forcing DuckLake to
// write parquet data files to GCS. Run through the same authenticated proxy.
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE || "http://127.0.0.1:9999";
const ISSUER = "bringup-issuer", AUDIENCE = "gw:bringup", KID = "bringup-key-1", PRINCIPAL = "agent:bringup";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID })
  .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUDIENCE)
  .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m").sign(privateKey);
const post = async (p, b) => { const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
const grants = ["create", "drop", "write"].map((action) => ({ role: "r1", tableRef: "main.big_t", action }));
console.log("snapshot:", JSON.stringify(await post("/ctrl/snapshot", { snapshot: { userRoles: [{ userId: PRINCIPAL, role: "r1" }], roleGrants: grants }, auth, lakeCatalog: "lake" })));
console.log("big CTAS (250k rows):", JSON.stringify(await post("/governed-load", { token: jwt, sql: "CREATE OR REPLACE TABLE main.big_t AS SELECT range AS id, range * 10 AS v FROM range(250000)" })));
console.log("checkpoint:", JSON.stringify(await post("/ctrl/checkpoint", {})));
