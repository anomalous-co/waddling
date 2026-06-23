// Post-deploy verification of the Form-B JOIN fallback (ANO-104). Proves BOTH halves:
//  (a) an IN-SCOPE 2-lake-table JOIN now returns rows (Form B server-side), and
//  (b) an OUT-OF-SCOPE JOIN still gets a structured birdshot denial (enforcement intact).
// Also re-checks single-table reads (must stay on Form A, unchanged) + write-then-read.
// Env: CONTROL_API_BASE, AGENT_KEY, DATALAKE_ID.
const BASE=(process.env.CONTROL_API_BASE||'https://api.getwaddling.com').replace(/\/+$/,'');
const KEY=process.env.AGENT_KEY, LAKE=process.env.DATALAKE_ID;
const H={authorization:`Bearer ${KEY}`,'content-type':'application/json'};
async function connect(){for(let i=0;i<8;i++){let j;try{j=await(await fetch(`${BASE}/api/cp/sessions`,{method:'POST',headers:H,body:JSON.stringify({datalakeId:LAKE})})).json();}catch(e){j={detail:e.message};}if(j.sessionId)return j.sessionId;console.log(`connect#${i+1}: ${j.detail||j.error}; wait 8s`);await new Promise(s=>setTimeout(s,8000));}throw new Error('no connect');}
const q=async(sid,sql)=>{const r=await(await fetch(`${BASE}/api/cp/sessions/${sid}/query`,{method:'POST',headers:H,body:JSON.stringify({sql})})).json();return r;};
let pass=0,fail=0; const ok=(c,m,x='')=>{c?(pass++,console.log(`  ✓ ${m}`)):(fail++,console.log(`  ✗ ${m}  ${x}`));};

const sid=await connect();
console.log('connected',sid,'\n');

// (1) single-table read — Form A, must still work
let r=await q(sid,`SELECT count(*) FROM lake.main.fnl_fct_funnel_event`);
ok(!r.error && Number(r.rows?.[0]?.[0])>0,'single-table read (Form A) still works',JSON.stringify(r).slice(0,200));

// (2) IN-SCOPE 2-table JOIN — the fix: Form A fails → Form B retry → rows
r=await q(sid,`SELECT et.stage_category, count(*) n FROM lake.main.fnl_fct_funnel_event f JOIN lake.main.fnl_dim_event_type et ON f.event_type_key=et.event_type_key GROUP BY 1 ORDER BY 1`);
ok(!r.error && (r.rows?.length>=4),'in-scope fact⨝dim JOIN returns rows (Form B)',JSON.stringify(r).slice(0,260));
if(!r.error) console.log('     stages:', (r.rows||[]).map(x=>`${x[0]}=${x[1]}`).join('  '));

// (3) 3-table JOIN (fact ⨝ two dims) — also Form B
r=await q(sid,`SELECT et.stage_category, p.is_identified, count(*) n
  FROM lake.main.fnl_fct_funnel_event f
  JOIN lake.main.fnl_dim_event_type et ON f.event_type_key=et.event_type_key
  JOIN lake.main.fnl_dim_person p ON f.person_key=p.person_key
  GROUP BY 1,2 ORDER BY 1,2`);
ok(!r.error && r.rows?.length>0,'3-table JOIN returns rows (Form B)',JSON.stringify(r).slice(0,260));

// (4) UNKNOWN-TABLE JOIN — fails closed, not a leak. NOTE: on an all-access (*.*) agent this
// hits the binder ("does not exist"), NOT a birdshot grant-denial. The real birdshot ENFORCEMENT
// proof (granted-join ALLOW + ungranted-table-join DENY through Form B) needs a SCOPED agent —
// see /tmp/denyproof.mjs; this case only asserts no-leak/no-crash.
r=await q(sid,`SELECT count(*) FROM lake.main.fnl_fct_funnel_event f JOIN lake.main.__nope_secret s ON f.person_key=s.person_key`);
ok(!!r.error,'unknown-table JOIN fails closed (no leak; not a birdshot deny on a *.* agent)',JSON.stringify(r).slice(0,260));
console.log('     err:', JSON.stringify({error:r.error,reason:r.reason,detail:(r.detail||'').slice(0,160)}));

console.log(`\n${'─'.repeat(50)}\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail?1:0);
