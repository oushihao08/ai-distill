/**
 * 职责：真实PostgreSQL小规模验收库任务取消/提交竞争、回滚、失租及JSONB原因记录。
 * 入口：bun --no-env-file scripts/verification/verify-worker-transactions.ts --port <本机临时PG端口> --out <证据JSON>。
 * 边界：仅连接127.0.0.1的worker_verify专用数据库，随机schema及合成任务；复用生产jobs函数，finally删除schema。不读取.env、不跑迁移器、不调用模型或操作业务库。
 */
import {Pool} from 'pg';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {cancelLibraryJob,failLibraryJob,finishLibraryJob,readLibraryJob} from '../../server/material-library/jobs';
import {withTaskSignal} from '../../server/task-signal';

const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const port=Number(arg('--port')),out=arg('--out');
if(!Number.isInteger(port)||port<1024||port>65535||!out)throw new Error('需要显式本机测试端口和--out证据路径');
const schema=`verify_worker_${randomUUID().replaceAll('-','')}`,application=`worker-test-${randomUUID()}`;
const raw=new Pool({host:'127.0.0.1',port,user:'postgres',database:'worker_verify',ssl:false,max:8,connectionTimeoutMillis:5000,application_name:application,options:'-c statement_timeout=5000'});
const sql=(text:string)=>text.replaceAll('ai_distill.',`${schema}.`);
const scoped={query:(text:string,values?:unknown[])=>raw.query(sql(text),values),connect:async()=>{
 const client=await raw.connect();return{query:(text:string,values?:unknown[])=>client.query(sql(text),values),release:()=>client.release()};
}} as unknown as Pool;
const results:{name:string;passed:boolean}[]=[];
let created=false,cleaned=false,version='';
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
async function check(name:string,fn:()=>Promise<void>){await fn();results.push({name,passed:true});console.log(`PASS ${name}`);}
async function seed(status='running'){
 const id=randomUUID(),packageId=randomUUID(),revision=randomUUID(),lease=randomUUID();
 await raw.query(`INSERT INTO ${schema}.library_revisions(package_id,id) VALUES($1,$2)`,[packageId,revision]);
 await raw.query(`INSERT INTO ${schema}.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,result_summary,lease_token,lease_expires_at,heartbeat_at,started_at,deadline_at)
 VALUES($1,$2,$3,'extract',$4,$5,$6,'{}',$6,'{}','api','local','{"existing":"keep"}',$7,CASE WHEN $4='running' THEN now()+interval '2 minutes' END,CASE WHEN $4='running' THEN now() END,CASE WHEN $4='running' THEN now() END,CASE WHEN $4='running' THEN now()+interval '5 minutes' END)`,[id,packageId,revision,status,randomUUID(),'a'.repeat(64),status==='running'?lease:null]);
 return{id,lease};
}
async function artifact(db:any,id:string,label='one'){await db.query('INSERT INTO ai_distill.verify_artifacts(job_id,label) VALUES($1,$2)',[id,label]);}
async function count(id:string){return Number((await raw.query(`SELECT count(*) FROM ${schema}.verify_artifacts WHERE job_id=$1`,[id])).rows[0].count);}
async function waitLocks(minimum:number){
 const until=Date.now()+3000;
 while(Date.now()<until){
  const n=Number((await raw.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",[application])).rows[0].count);
  if(n>=minimum)return;
  await Bun.sleep(10);
 }
 throw new Error('并发场景未进入预期数据库锁等待');
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}

let failure:unknown;
try{
 const env=(await raw.query('SELECT current_database() AS db,version() AS version')).rows[0];
 assert(env.db==='worker_verify','拒绝非专用测试数据库');version=env.version;
 await raw.query(`CREATE SCHEMA ${schema}`);created=true;
 await raw.query(`CREATE TABLE ${schema}.library_revisions(package_id uuid NOT NULL,id uuid PRIMARY KEY,UNIQUE(package_id,id))`);
 const migration=await readFile(new URL('../../migrations/042_shared_material_library.sql',import.meta.url),'utf8');
 const ddl=migration.slice(migration.indexOf('CREATE TABLE ai_distill.library_jobs ('),migration.indexOf('CREATE TABLE ai_distill.library_documents ('));
 assert(ddl.startsWith('CREATE TABLE'),'无法定位真实library_jobs约束');await raw.query(sql(ddl));
 await raw.query(`ALTER TABLE ${schema}.library_jobs ADD COLUMN origin text NOT NULL DEFAULT 'execution' CHECK(origin IN ('execution','legacy_import'))`);
 await raw.query(`CREATE TABLE ${schema}.verify_artifacts(job_id uuid NOT NULL REFERENCES ${schema}.library_jobs(id),label text NOT NULL)`);

 await check('排队取消符合真实状态约束并记录原因',async()=>{
  const j=await seed('queued'),row=await cancelLibraryJob(scoped,j.id);
  assert(row.status==='cancelled'&&row.error_code===null,'排队取消终态错误');
  assert(row.result_summary.execution_stop.reason_code==='user_cancelled'&&row.result_summary.existing==='keep','取消原因或旧摘要丢失');
 });
 await check('运行中用户取消优先于随后worker停止且保留JSONB旧字段',async()=>{
  const j=await seed();await cancelLibraryJob(scoped,j.id);await failLibraryJob(scoped,j.id,j.lease,'worker_shutdown','synthetic stop','cancelled');
  const row=await readLibraryJob(scoped,j.id);
  assert(row.status==='cancelled'&&row.error_code===null,'取消状态错误');
  assert(row.result_summary.execution_stop.reason_code==='user_cancelled'&&row.result_summary.execution_stop.local_reason_code==='worker_shutdown'&&row.result_summary.existing==='keep','JSONB原因优先级错误');
 });
 await check('超时与心跳故障符合failed约束并保留不同原因',async()=>{
  for(const reason of ['deadline_exceeded','heartbeat_unavailable']){
   const j=await seed();await failLibraryJob(scoped,j.id,j.lease,reason,'synthetic failure');const row=await readLibraryJob(scoped,j.id);
   assert(row.status==='failed'&&row.error_code===reason&&row.result_summary.execution_stop.reason_code===reason,'失败原因被吞掉');
  }
 });
 await check('旧租约无法发布或覆盖新持有者',async()=>{
  const j=await seed(),next=randomUUID();await raw.query(`UPDATE ${schema}.library_jobs SET lease_token=$2 WHERE id=$1`,[j.id,next]);let called=false;
  const attempt=await Promise.allSettled([finishLibraryJob(scoped,j.id,j.lease,{},async()=>{called=true;})]);
  assert(attempt[0].status==='rejected'&&!called,'旧租约发生发布');
  assert(!await failLibraryJob(scoped,j.id,j.lease,'lease_lost','old owner'),'旧持有者覆盖新状态');
  const row=(await raw.query(`SELECT lease_token,status FROM ${schema}.library_jobs WHERE id=$1`,[j.id])).rows[0];assert(row.lease_token===next&&row.status==='running','新持有者被改写');
 });
 await check('包内部分写入后异常全部回滚，无半包成果',async()=>{
  const j=await seed();const result=await Promise.allSettled([finishLibraryJob(scoped,j.id,j.lease,{},async db=>{await artifact(db,j.id,'one');await artifact(db,j.id,'two');throw new Error('synthetic publication failure');})]);
  assert(result[0].status==='rejected'&&await count(j.id)===0,'部分成果泄漏');assert((await readLibraryJob(scoped,j.id)).status==='running','失败事务错误更新终态');
 });
 await check('发布中收到worker停止时事务回滚',async()=>{
  const j=await seed(),c=new AbortController();
  const result=await Promise.allSettled([withTaskSignal(c.signal,()=>finishLibraryJob(scoped,j.id,j.lease,{},async db=>{await artifact(db,j.id);c.abort(new Error('synthetic stop'));}))]);
  assert(result[0].status==='rejected'&&await count(j.id)===0,'停止后仍提交成果');
 });
 await check('提交先获锁时完整成功，随后取消不能反转成功',async()=>{
  const j=await seed(),entered=deferred(),release=deferred();
  const finish=finishLibraryJob(scoped,j.id,j.lease,{complete:true},async db=>{await artifact(db,j.id);entered.resolve();await release.promise;});
  await entered.promise;const cancel=cancelLibraryJob(scoped,j.id);
  try{await waitLocks(1);}finally{release.resolve();}
  const [done,cancelled]=await Promise.all([finish,cancel]);assert(done===true&&cancelled.status==='succeeded'&&await count(j.id)===1,'提交获锁后终态不一致');
 });
 await check('取消先排入锁队列时后续发布被拒绝',async()=>{
  const j=await seed(),blocker=await raw.connect();let cancel:Promise<unknown>|undefined,finish:Promise<unknown>|undefined,called=false;
  try{
   await blocker.query('BEGIN');await blocker.query(`SELECT id FROM ${schema}.library_jobs WHERE id=$1 FOR UPDATE`,[j.id]);
   cancel=cancelLibraryJob(scoped,j.id);await waitLocks(1);
   finish=finishLibraryJob(scoped,j.id,j.lease,{},async db=>{called=true;await artifact(db,j.id);});
   // Handle the expected rejection before releasing the lock to avoid an unhandled rejection.
   const settled=Promise.allSettled([cancel,finish]);await waitLocks(2);await blocker.query('COMMIT');
   const result=await settled;assert(result[0].status==='fulfilled'&&result[1].status==='rejected'&&!called&&await count(j.id)===0,'取消获锁后仍发布');
   await failLibraryJob(scoped,j.id,j.lease,'worker_shutdown','synthetic settlement','cancelled');assert((await readLibraryJob(scoped,j.id)).status==='cancelled','取消未终结');
  }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled([cancel,finish].filter(Boolean));}
 });
 await check('COMMIT已成功但回执丢失时同job回读确认，迟到失败不能覆盖',async()=>{
  const j=await seed();let lose=true;
  const lost={...scoped,connect:async()=>{
   const client=await scoped.connect();return{query:async(text:string,values?:unknown[])=>{const value=await client.query(text,values);if(text==='COMMIT'&&lose){lose=false;throw new Error('synthetic lost commit acknowledgement');}return value;},release:()=>client.release()};
  }} as unknown as Pool;
  const result=await Promise.allSettled([finishLibraryJob(lost,j.id,j.lease,{complete:true},db=>artifact(db,j.id))]);assert(result[0].status==='rejected','未注入回执丢失');
  assert((await readLibraryJob(scoped,j.id)).status==='succeeded'&&await count(j.id)===1,'真实COMMIT未保留');
  assert(!await failLibraryJob(scoped,j.id,j.lease,'unknown','late failure'),'迟到失败覆盖成功');
 });
 await check('过期任务拒绝发布，不误记为用户取消',async()=>{
  const j=await seed();await raw.query(`UPDATE ${schema}.library_jobs SET deadline_at=now()-interval '1 second' WHERE id=$1`,[j.id]);let called=false;
  const result=await Promise.allSettled([finishLibraryJob(scoped,j.id,j.lease,{},async()=>{called=true;})]);assert(result[0].status==='rejected'&&!called,'过期任务仍调用发布');
  await failLibraryJob(scoped,j.id,j.lease,'deadline_exceeded','expired');assert((await readLibraryJob(scoped,j.id)).status==='failed','过期错误分类');
 });
}catch(error){failure=error;}
finally{
 try{if(created){await raw.query(`DROP SCHEMA ${schema} CASCADE`);cleaned=true;}}finally{await raw.end();}
 await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify({recorded_at:new Date().toISOString(),database:'local dedicated worker_verify',postgres_version:version,schema_cleaned:cleaned,tests:results,passed:results.length,error:failure instanceof Error?failure.message:null,scope:'真实jobs SQL和约束/事务；合成成果表；COMMIT回执丢失为提交后注入异常，未模拟真实断网；无模型/业务数据'},null,2)+'\n');
}
if(failure)throw failure;
console.log(`${results.length} PostgreSQL checks passed; schema cleaned=${cleaned}`);
