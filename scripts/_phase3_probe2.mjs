// Read-only: how is the connected agent represented? Delete after use.
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ORG = 'oqx0DcZlnCGChsvcLKViDGChrX4I5al0';
const ID = 'dwnWoyXAO0l8vG0BMKGBdrLREFKXMxHo';
const q = async (s, p = []) => (await pool.query(s, p)).rows;
try {
  console.log('AGENTS:', JSON.stringify(
    await q(`SELECT id, name, mode, owner_user_id, status FROM waddling.agent WHERE org_id=$1`, [ORG]),
  ));
  console.log('AGENT by id?:', JSON.stringify(
    await q(`SELECT id,name,mode FROM waddling.agent WHERE id=$1`, [ID]),
  ));
  console.log('USER by id?:', JSON.stringify(
    await q(`SELECT id, email FROM "user" WHERE id=$1`, [ID]),
  ));
} finally {
  await pool.end();
}
