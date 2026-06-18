// Two-instance federation probe. Boots one instance from env, seeds a row, then
// repeatedly tries to ATTACH + query the peer over quack — exercising the OTHER
// instance's birdshot hooks. Drains this instance's audit so we can see exactly
// which queries birdshot allowed/denied during a peer ATTACH (open item #2).
//
// Run two copies with crossed ports/tokens (see scripts/federation-check.sh).
import { getStack } from "./stack.ts";
import { getAnalytics } from "./analytics.ts";
import { drainAudit } from "./birdshot.ts";

const stack = await getStack();
const tag = `[${stack.config.instance}]`;
console.log(`${tag} up. birdshotActive=${stack.birdshotActive} quackPort=${stack.config.quackPort} peer=${stack.config.peerQuackPort}`);

// Seed one local row so a successful federated read returns a non-zero count.
await stack.db.exec(`INSERT INTO todos (title, done) VALUES ('from-${stack.config.instance}', false)`);

for (let i = 0; i < 8; i++) {
  let result = "";
  try {
    const a = await getAnalytics();
    result = `peer_connected=${a.peer_connected} local=${JSON.stringify(a.local)} peer=${JSON.stringify(a.peer)}`;
  } catch (err) {
    result = `analytics error: ${(err as Error).message}`;
  }
  console.log(`${tag} iter${i} ${result}`);

  // Show what birdshot decided for inbound peer traffic this round.
  if (stack.birdshotActive) {
    const audit = await drainAudit(stack.duck, null, 200);
    for (const e of audit) {
      const q = e.query.length > 90 ? e.query.slice(0, 90) + "…" : e.query;
      console.log(`${tag}   audit ${e.event}/${e.decision}(${e.reason}) ${q}`);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
process.exit(0);
