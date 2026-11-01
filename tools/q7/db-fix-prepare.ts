import {Client} from 'pg';
import {readFileSync} from 'fs';

const url = readFileSync('.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))!.slice(13).trim();
const led=JSON.parse(readFileSync('.storage/q7-run-20261101/ledger.json','utf8'));
const targets:string[]=[];
for (const [k,v] of Object.entries<any>(led)) { const j=v.prepare_job||v.prepare_job_orphaned; if (j && !v.prepared) targets.push(j); }

const c = new Client({connectionString:url, ssl:{rejectUnauthorized:false}});
await c.connect();
const own = await c.query(`select distinct executor_id from ai_distill.execution_dispatches where job_id = any($1::uuid[])`,[targets]);
const owners=(own.rows as any[]).map(r=>r.executor_id);
console.log('归属执行节点:', owners.join(','));
if (owners.length!==1) { console.log('归属不唯一，中止'); process.exit(1); }
await c.query(`set application_name = 'ai-distill-executor:${owners[0]}'`);
const chk = await c.query(`select current_setting('application_name') as a`);
console.log('当前会话身份:', (chk.rows[0] as any).a);

await c.query('begin');
const upd = await c.query(
  `update ai_distill.library_jobs
      set status='failed',
          error_code='lease_expired_orphaned',
          error_message='worker restarted while holding an expired lease (manual recovery 2026-11-01); superseded by new prepare job',
          finished_at=now(),
          lease_token=null,
          lease_expires_at=null,
          heartbeat_at=null
    where id = any($1::uuid[]) and status='running'
    returning id, status, error_code`,[targets]);
await c.query('commit');
console.log('更新行数:', upd.rowCount);
for (const r of upd.rows as any[]) console.log(' fixed', r.id.slice(0,8), r.status, r.error_code);
await c.end();
