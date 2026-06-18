// Federation server (instance B) for the live revocation demo. Boots, serves,
// and after a delay REVOKES the 'peer' user — proving instant revocation cuts
// off an already-connected peer on its next query.
import { getStack } from "./stack.ts";
import { revoke } from "./birdshot.ts";

const stack = await getStack();
const tag = `[${stack.config.instance}]`;
await stack.db.exec(`INSERT INTO todos (title) VALUES ('from-${stack.config.instance}')`);
console.log(`${tag} server up, birdshotActive=${stack.birdshotActive}`);

setTimeout(async () => {
  await revoke(stack.duck, stack.authDb, "user", "peer", "live-revocation-demo");
  console.log(`${tag} >>> REVOKED user 'peer'`);
}, 7000);

setTimeout(() => process.exit(0), 20000);
