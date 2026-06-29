// Author direct agent-subject grants + a source policy for the HN-ingest proof.
// Idempotent: clears prior proof rows for (agent, datalake) first. Delete after use.
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ORG = 'oqx0DcZlnCGChsvcLKViDGChrX4I5al0';
const DL = '0d4ae298-2039-46a8-9473-c5f41d1620af';
const AGENT = 'e4244e3c-a765-4aa7-a59b-36f284d609d7';
const CB = 'phase3-proof';
try {
  await pool.query(
    `DELETE FROM waddling.acl_rule WHERE agent_id=$1 AND datalake_id=$2 AND created_by=$3`,
    [AGENT, DL, CB],
  );
  await pool.query(
    `DELETE FROM waddling.acl_policy WHERE agent_id=$1 AND datalake_id=$2 AND created_by=$3`,
    [AGENT, DL, CB],
  );
  // create on main.* (CTAS target) + read on main.* (SELECT back / describe).
  for (const cap of ['create', 'read']) {
    await pool.query(
      `INSERT INTO waddling.acl_rule
         (org_id,datalake_id,agent_id,subject_kind,capability,schema_name,table_name,verb,effect,created_by)
       VALUES ($1,$2,$3,'agent',$4,'main','*',$5,'allow',$6)`,
      [ORG, DL, AGENT, cap, cap === 'read' ? 'read' : 'read', CB],
    );
  }
  // source policy: read_source allowed against hn.algolia.com (subdomains match).
  await pool.query(
    `INSERT INTO waddling.acl_policy
       (org_id,datalake_id,subject_kind,agent_id,policy_kind,capability,pattern,created_by)
     VALUES ($1,$2,'agent',$3,'source','read_source','hn.algolia.com',$4)`,
    [ORG, DL, AGENT, CB],
  );
  const r = await pool.query(
    `SELECT capability FROM waddling.acl_rule WHERE agent_id=$1 AND datalake_id=$2 AND created_by=$3
     UNION ALL SELECT 'policy:'||capability FROM waddling.acl_policy WHERE agent_id=$1 AND datalake_id=$2 AND created_by=$3`,
    [AGENT, DL, CB],
  );
  console.log('AUTHORED:', r.rows.map((x) => x.capability).join(', '));
} finally {
  await pool.end();
}
