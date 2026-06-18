// Demonstrates: (1) each instance holds DISTINCT fake PII, and (2) birdshot gates
// PII across the federation — a quack peer may read the shared `todos` but is
// DENIED the peer's contacts / addresses / memories. Run one copy per instance
// (crossed ports); each reads its own local data, then probes the peer.
import { getStack } from "./stack.ts";

const stack = await getStack();
const tag = `[${stack.config.instance}]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Own data is NOT birdshot-gated (local in-process queries don't traverse the
// quack hooks). Shows the per-instance dataset is distinct.
const localContacts = await stack.duck.runAndReadAll("SELECT name FROM main.contacts ORDER BY name");
const localMemories = await stack.duck.runAndReadAll("SELECT title FROM main.memories ORDER BY id");
console.log(`${tag} LOCAL contacts: ${localContacts.getRowObjects().map((r) => r.name).join(", ")}`);
console.log(`${tag} LOCAL memories: ${localMemories.getRowObjects().map((r) => r.title).join(" | ")}`);

await sleep(2000); // let both instances' quack servers bind first
let attached = false;
for (let i = 0; i < 30 && !(attached = await stack.ensurePeer()); i++) await sleep(1000);
console.log(`${tag} peer attached: ${attached}`);

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);
async function probe(label: string, sql: string) {
  try {
    const r = await stack.duck.runAndReadAll(sql);
    const first = r.getRowObjects()[0];
    console.log(`${tag} PEER ${label}: ALLOWED (${JSON.stringify(first, bigintSafe)})`);
  } catch (err) {
    console.log(`${tag} PEER ${label}: DENIED  (${(err as Error).message.split("\n")[0]})`);
  }
}

await probe("todos    ", "SELECT count(*) AS n FROM peer_db.main.todos");
await probe("contacts ", "SELECT name FROM peer_db.main.contacts LIMIT 1");
await probe("addresses", "SELECT street FROM peer_db.main.addresses LIMIT 1");
await probe("memories ", "SELECT title FROM peer_db.main.memories LIMIT 1");
await sleep(6000); // stay up so the peer can finish probing us too
process.exit(0);
