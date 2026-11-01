import {Client} from 'pg';
import {readFileSync} from 'fs';
const url = readFileSync('.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))!.slice(13).trim();
const c = new Client({connectionString:url, ssl:{rejectUnauthorized:false}});
await c.connect();
const t = await c.query(`select now() as db_now, current_setting('TimeZone') as tz`);
console.log('DB now:', (t.rows[0] as any).db_now.toISOString(), '| tz:', (t.rows[0] as any).tz);
console.log('本机 now:', new Date().toISOString());
const q = await c.query(`select j.id,j.kind,j.status,j.error_code,j.created_at,j.finished_at,p.name as package, j.progress->>'phase' as phase
  from ai_distill.library_jobs j left join ai_distill.library_packages p on p.id=j.package_id
  where j.created_at > now() - interval '3 hours' order by j.created_at`);
for (const r of q.rows as any[]) console.log(r.created_at.toISOString(), r.kind, r.status, r.error_code||'-', (r.package||'').slice(0,40), r.id.slice(0,8));
await c.end();
