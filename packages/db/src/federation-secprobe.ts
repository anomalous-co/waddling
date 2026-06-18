// Live revocation demo (client). Repeatedly reads the peer's todos over quack.
// The peer (federation-server) revokes user 'peer' partway through; this client's
// reads must flip from ALLOWED to DENIED on the very next query — instant
// revocation of an already-connected peer.
import { getStack } from "./stack.ts";

const stack = await getStack();
const tag = `[${stack.config.instance}]`;
for (let i = 0; i < 10 && !(await stack.ensurePeer()); i++) {
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`${tag} peer attached, reading peer todos every 1.5s…`);

for (let i = 0; i < 10; i++) {
  try {
    const r = await stack.duck.runAndReadAll("SELECT count(*) AS n FROM peer_db.main.todos");
    console.log(`${tag} read#${i}: ALLOWED (n=${r.getRowObjects()[0]?.n})`);
  } catch (err) {
    const msg = (err as Error).message.split("\n")[0];
    console.log(`${tag} read#${i}: DENIED  (${msg})`);
    stack.resetPeer();
    await stack.ensurePeer();
  }
  await new Promise((r) => setTimeout(r, 1500));
}
process.exit(0);
