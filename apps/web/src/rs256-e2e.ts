// End-to-end: Better Auth (RS256) -> JWT -> birdshot verification -> ACL.
//
// 1. boot the stack (birdshot loaded, authDb wire up)
// 2. run Better Auth migrations into authDb
// 3. create a user + mint a real RS256 JWT via Better Auth's HTTP handler
// 4. fetch the published JWKS, configure birdshot in rs256 mode with it
// 5. assert: birdshot accepts the real JWT, rejects a tampered one, and the
//    user's role grants gate a query.
import { getStack } from "@pglite-sandbox/db";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./lib/auth.ts";

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";
const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}
const call = (path: string, init?: RequestInit) => auth.handler(new Request(`${baseURL}${path}`, init));

const stack = await getStack();
const duck = stack.duck;
console.log(`birdshotActive=${stack.birdshotActive}`);

// 2. migrate Better Auth's schema into authDb.
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log("better-auth migrations applied to authDb");

// 3. create a user + mint a JWT.
const email = `peer-${Date.now()}@example.com`;
const signup = await call("/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "correct-horse-battery", name: "Peer User" }),
});
const signupBody = (await signup.json()) as { user?: { id: string } };
const userId = signupBody.user?.id ?? "";
const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0];
check("sign-up returned a user id", !!userId);

const tokenRes = await call("/api/auth/token", { headers: { cookie } });
const { token } = (await tokenRes.json()) as { token: string };
check("Better Auth issued a JWT", !!token && token.split(".").length === 3);

const jwks = (await (await call("/api/auth/jwks")).json()) as { keys: { kty: string; kid?: string; n?: string; e?: string; alg?: string }[] };
const rsaKeys = jwks.keys.filter((k) => k.kty === "RSA" && k.n && k.e);
check("JWKS publishes an RSA (RS256) key", rsaKeys.length > 0);
console.log(`  user=${userId} alg=${jwks.keys[0]?.alg} kid=${jwks.keys[0]?.kid}`);

// 4. configure birdshot in rs256 mode with the real JWKS + a role for this user.
await duck.run("SELECT birdshot_reset_config()");
await duck.run(`SELECT birdshot_set_auth(${q(baseURL)}, ${q(baseURL)}, 'rs256')`);
for (const k of rsaKeys) await duck.run(`SELECT birdshot_add_jwk(${q(k.kid ?? "")}, ${q(k.n!)}, ${q(k.e!)})`);
await duck.run(`SELECT birdshot_add_role_grant('member', 'main.todos', 'read')`);
await duck.run(`SELECT birdshot_add_user_role(${q(userId)}, 'member')`);
await duck.run("SELECT birdshot_commit_config()");

// 5. assertions through the real hooks.
async function authenticate(sid: string, tok: string): Promise<boolean> {
  const r = await duck.runAndReadAll(`SELECT birdshot_authenticate(${q(sid)}, ${q(tok)}, '') AS ok`);
  return r.getRowObjects()[0]?.ok === true;
}
async function authorize(sid: string, sql: string): Promise<boolean> {
  const r = await duck.runAndReadAll(`SELECT birdshot_authorize(${q(sid)}, ${q(sql)}) AS ok`);
  return r.getRowObjects()[0]?.ok === true;
}

check("birdshot ACCEPTS the real RS256 JWT", await authenticate("rs-good", token));

const tampered = token.slice(0, -3) + (token.slice(-3) === "AAA" ? "BBB" : "AAA");
check("birdshot REJECTS a tampered JWT", !(await authenticate("rs-bad", tampered)));

const forged = token.split(".").slice(0, 2).join(".") + ".Zm9yZ2Vk";
check("birdshot REJECTS a forged-signature JWT", !(await authenticate("rs-forge", forged)));

check("authenticated user can read granted table", await authorize("rs-good", "SELECT * FROM main.todos"));
check("authenticated user denied write (read-only role)", !(await authorize("rs-good", "INSERT INTO main.todos VALUES (1)")));
check("authenticated user denied ungranted table", !(await authorize("rs-good", "SELECT * FROM secrets")));

console.log(failures === 0 ? "\nALL RS256 E2E CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
