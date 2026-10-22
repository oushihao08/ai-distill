/** 047定向迁移入口：默认只盘点；--apply仅在其余必要迁移已登记时应用047；未归属的在途任务保持旧语义，绝不运行其他未登记迁移。使用现有环境连接，不输出凭证。 */
import {createPool} from '../../server/db';
import type {PoolClient} from 'pg';
import {readFile,readdir} from 'node:fs/promises';
const target='047_local_execution_dispatch.sql',apply=process.argv.includes('--apply');
let pool:ReturnType<typeof createPool>|undefined;
let db:PoolClient|undefined;
try{
 pool=createPool();db=await pool.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='10s'");await db.query("SELECT pg_advisory_xact_lock(hashtext('ai-distill-migrations'))");
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort();
 const registered=new Set((await db.query('SELECT name FROM ai_distill.schema_migrations')).rows.map(r=>r.name));const pending=files.filter(n=>!registered.has(n));
 const activity=(await db.query("SELECT (SELECT count(*) FROM ai_distill.step_attempts WHERE status='running')::int AS steps,(SELECT count(*) FROM ai_distill.library_jobs WHERE status='running')::int AS library,(SELECT count(*) FROM ai_distill.project_skill_attempts WHERE status='running')::int AS skill")).rows[0];
 const optional=(await db.query("SELECT to_regclass('ai_distill.hook_runs') AS hooks,to_regclass('ai_distill.remote_material_operations') AS remote")).rows[0];
 for(const [key,table]of [['hooks','hook_runs'],['remote','remote_material_operations']] as const)activity[key]=optional[key]?Number((await db.query(`SELECT count(*) AS n FROM ai_distill.${table} WHERE status='running'`)).rows[0].n):0;
 if(registered.has(target))activity.unowned_steps=Number((await db.query("SELECT count(*) AS n FROM ai_distill.step_attempts a WHERE a.status='running' AND NOT EXISTS(SELECT 1 FROM ai_distill.execution_dispatches d WHERE d.job_id=a.id)")).rows[0].n);
 console.log(JSON.stringify({mode:apply?'apply':'inspect',pending,running:activity,target}));
 if(apply){if(pending.some(n=>n!==target&&n!=='033_workflow_hooks.sql'))throw new Error('存在其他必要未登记迁移，未执行047；需先核对版本');if(!registered.has(target)){await db.query(await readFile(new URL(`../../migrations/${target}`,import.meta.url),'utf8'));await db.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)',[target]);}}
 await db.query('COMMIT');
}catch(error){if(db)await db.query('ROLLBACK');const safe=error instanceof Error&&/^(仍有在途任务|存在其他必要未登记迁移)/.test(error.message)?error.message:'047盘点或迁移未完成，请核对运行状态与数据库连接；未输出连接参数';console.error(safe);process.exitCode=1;}
finally{db?.release();await pool?.end();}
