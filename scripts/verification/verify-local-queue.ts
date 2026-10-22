/** 每机队列隔离验收：仅127.0.0.1的queue_verify临时PG，完整迁移空库，双SQLite/双连接身份，真实材料入库提取；不调用模型、不连接业务库。 */
import {Pool} from 'pg';
import {createApp} from '../../server/app';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLibraryPackage,createLibraryRevision} from '../../server/material-library/service';
import {enqueueLibraryJob,claimLibraryJob} from '../../server/material-library/jobs';
import {runNextLibraryJob} from '../../server/material-library/runner';
import {localQueue,withLocalExecution,withLocalQueueRoot,reconcileRegistrations,registerLocalJob,cachedExternalCall,assertLocalQueueEnvironment,reconcileTerminalOutcome,rearmLocalJob} from '../../server/execution-queue/runtime';
const arg=(s:string)=>process.argv[process.argv.indexOf(s)+1];const port=Number(arg('--port')),out=arg('--out');
if(!process.argv.includes('--port')||!process.argv.includes('--out')||!Number.isInteger(port)||port<1024||port>65535)throw new Error('需要明确本机测试端口与证据路径');
process.env.EXECUTION_QUEUE_MODE='local';
const root=await mkdtemp(join(tmpdir(),'local-queue-pg-')),qA=localQueue(join(root,'A')),qB=localQueue(join(root,'B'));
const options={host:'127.0.0.1',port,user:'postgres',database:'queue_verify',ssl:false,max:4,connectionTimeoutMillis:5000,options:'-c statement_timeout=10000'};
const admin=new Pool({...options,application_name:'local-queue-test-admin'}),a=new Pool({...options,application_name:`ai-distill-executor:${qA.executorId}`}),b=new Pool({...options,application_name:`ai-distill-executor:${qB.executorId}`});
const results:{name:string;passed:boolean}[]=[];let schemaCreated=false,cleaned=false,failure:unknown;
function assert(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
async function check(name:string,run:()=>Promise<void>){await run();results.push({name,passed:true});console.log('PASS '+name);}
async function seed(pool:Pool,root:string,name:string){
 const p=await createLibraryPackage(pool,{name}),revision=await createLibraryRevision(pool,root,p.id,Number(p.lock_version),randomUUID(),[{original_name:'材料.txt',bytes:Buffer.from('合成测试材料。付款金额100元，日期2026年10月22日。')}]);
 const job=await withLocalQueueRoot(root,()=>enqueueLibraryJob(pool,p.id,revision.id,{kind:'intake',request_key:randomUUID(),execution_target:'local'},root));return{package:p.id,revision:revision.id,job:job.id};
}
async function run(pool:Pool,root:string,id:string){const q=localQueue(root);await reconcileRegistrations(pool,q);const job=q.claim('internal');assert(job?.id===id,'领取到非预期本机任务');await withLocalExecution(q,job,()=>runNextLibraryJob(pool,root,'internal','local',new AbortController().signal,id));q.finish(id,job.lease!,'committed');}
try{
 assert((await admin.query('SELECT current_database() AS name')).rows[0].name==='queue_verify','拒绝业务数据库');
 assert(!(await admin.query("SELECT to_regclass('ai_distill.schema_migrations') AS name")).rows[0].name,'验收只接受空的专用数据库');
 await admin.query('CREATE SCHEMA ai_distill');schemaCreated=true;await admin.query('CREATE TABLE ai_distill.schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
 for(const name of (await readdir(new URL('../../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){await admin.query('BEGIN');try{await admin.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));await admin.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)',[name]);await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw new Error(`隔离库迁移${name}失败`,{cause:e});}}
 await check('全部真实迁移可在隔离空库顺序应用',async()=>{assert((await admin.query("SELECT name FROM ai_distill.schema_migrations WHERE name='047_local_execution_dispatch.sql'")).rowCount===1,'047未登记');});
 await check('两个执行器连接保留各自身份',async()=>{await assertLocalQueueEnvironment(a,qA.root);await assertLocalQueueEnvironment(b,qB.root);});
 const A=await seed(a,qA.root,'verify-A'),B=await seed(b,qB.root,'verify-B');
 await check('入库派发先落本机意图，提交确认前不能领取',async()=>{assert(qA.get(A.job)?.state==='pending_registration','意图未持久化');assert(qA.claim('internal')===null,'未确认任务被执行');});
 await reconcileRegistrations(a,qA);await reconcileRegistrations(b,qB);
 await check('两机共享同一业务库但不共享本地队列',async()=>{assert(qA.get(B.job)===null&&qB.get(A.job)===null,'跨机导入任务');});
 await check('旧消费者不能抢领已登记任务',async()=>{let blocked=false;try{await admin.query("UPDATE ai_distill.library_jobs SET status='running' WHERE id=$1",[A.job]);}catch(e){blocked=(e as {code:string}).code==='55000';}assert(blocked,'归属保护未拦截旧消费者');});
 await check('另一台电脑不能回收本机任务',async()=>{let blocked=false;try{await b.query("UPDATE ai_distill.library_jobs SET status='failed' WHERE id=$1",[A.job]);}catch(e){blocked=(e as {code:string}).code==='55000';}assert(blocked,'跨机失租清理越权');});
 await check('真实原件校验入库，两台各自成功',async()=>{await Promise.all([run(a,qA.root,A.job),run(b,qB.root,B.job)]);for(const id of [A.job,B.job])assert((await admin.query('SELECT status FROM ai_distill.library_jobs WHERE id=$1',[id])).rows[0].status==='succeeded','入库未成功');});
 const E=await withLocalQueueRoot(qA.root,()=>enqueueLibraryJob(a,A.package,A.revision,{kind:'extract',request_key:randomUUID(),execution_target:'local'},qA.root));
 await check('既有提取器完整发布TXT结构，不调用模型',async()=>{await run(a,qA.root,E.id);assert((await admin.query('SELECT page_count FROM ai_distill.library_documents WHERE extraction_job_id=$1',[E.id])).rows[0]?.page_count===1,'结构化提取没有发布');});
 await check('云端登记回滚留下本地待确认记录，不执行半注册任务',async()=>{const id=randomUUID(),client=await a.connect();try{await client.query('BEGIN');await withLocalQueueRoot(qA.root,()=>registerLocalJob(client,id,'step','api','answer'));await client.query('ROLLBACK');await reconcileRegistrations(a,qA);assert(qA.get(id)?.state==='pending_registration','回滚意图错误激活');assert(qA.claim('api')===null,'回滚任务被调用');}finally{client.release();}});
 await check('同ID并发登记只保留原执行器，另一机不能复制消费',async()=>{const id=randomUUID();await withLocalQueueRoot(qA.root,()=>registerLocalJob(a,id,'step','api','answer'));await withLocalQueueRoot(qB.root,()=>registerLocalJob(b,id,'step','api','answer'));await reconcileRegistrations(a,qA);await reconcileRegistrations(b,qB);assert(qB.get(id)?.state==='cancelled','另一机仍可消费');assert((await admin.query('SELECT executor_id FROM ai_distill.execution_dispatches WHERE job_id=$1',[id])).rows[0].executor_id===qA.executorId,'owner被覆盖');qA.cancel(id);});
 await check('结果已返回后重复提交不会重复调用外部执行器',async()=>{const id=randomUUID();qA.intent(id,'step','api','answer');qA.confirm(id);let count=0;const job=qA.claim('api');assert(job,'无合成API任务');const call=()=>cachedExternalCall('synthetic_answer',async()=>{count++;return{text:'合成答案'};});const first=await withLocalExecution(qA,job,call);const second=await withLocalExecution(qA,job,call);assert(first.text===second.text&&count===1,'结果重交触发重复调用');});
 await check('云端COMMIT回执丢失后可按原ID确认，无第二次发布',async()=>{
  const C=await seed(a,qA.root,'verify-lost-ack');await reconcileRegistrations(a,qA);const job=qA.claim('internal');assert(job&&job.id===C.job,'合成任务领取错位');
  let publications=0;try{await withLocalExecution(qA,job,async()=>{publications++;await runNextLibraryJob(a,qA.root,'internal','local',new AbortController().signal,C.job);throw Object.assign(new Error('synthetic lost acknowledgement after COMMIT'),{code:'ECONNRESET'});});}catch{qA.finish(job.id,job.lease!,'result_pending_commit');}
  qA.db.query('UPDATE jobs SET updated_at=0 WHERE id=?').run(job.id);const retry=qA.claim('internal');assert(retry&&retry.id===job.id,'恢复ID改变');assert(await reconcileTerminalOutcome(a,qA,retry),'未按云端成功对账');assert(qA.get(job.id)?.state==='committed'&&publications===1,'重复执行或未完成确认');
 });
 await check('本机HTTP队列视图与取消不影响另一执行器',async()=>{
  const D=await seed(a,qA.root,'verify-http-cancel'),appA=createApp(a,qA.root),appB=createApp(b,qB.root);
  const response=await appA.request('/api/system/execution-queue');assert(response.status===200,'本机队列读取失败');const payload=await response.json();assert(payload.executor_id===qA.executorId&&payload.items.some((j:any)=>j.id===D.job),'队列视图归属错误');
  const deny=await appB.request(`/api/system/execution-queue/${D.job}/cancel`,{method:'POST'});assert(deny.status===404,'B能够取消A本地队列');
  const cancel=await appA.request(`/api/system/execution-queue/${D.job}/cancel`,{method:'POST'});assert(cancel.status===200,'本机取消失败');assert(qA.get(D.job)?.cancel_synced===1,'取消没有确认同步');assert((await admin.query('SELECT status FROM ai_distill.library_jobs WHERE id=$1',[D.job])).rows[0].status==='cancelled','云端业务取消未同步');
 });
 await check('旧队列只允许显式认领未开始的指定ID',async()=>{
  process.env.EXECUTION_QUEUE_MODE='legacy';let old;try{old=await seed(a,qA.root,'verify-explicit-adopt');}finally{process.env.EXECUTION_QUEUE_MODE='local';}
  assert(!qA.get(old.job),'旧队列被自动导入');const app=createApp(a,qA.root);const adopted=await app.request('/api/system/execution-queue/adopt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobs:[{id:old.job,kind:'library'}]})});assert(adopted.status===200,'明确旧任务认领失败');await reconcileRegistrations(a,qA);assert(qA.get(old.job)?.state==='queued'&&!qB.get(old.job),'旧任务被跨机复制');
 });
 await check('显式续跑新代在云端事务确认前不能消费',async()=>{
  const id=randomUUID();await withLocalQueueRoot(qA.root,()=>registerLocalJob(a,id,'step','api','answer'));await reconcileRegistrations(a,qA);qA.db.query("UPDATE jobs SET state='failed' WHERE id=?").run(id);
  const client=await a.connect();try{await client.query('BEGIN');await withLocalQueueRoot(qA.root,()=>rearmLocalJob(client,id));await client.query('ROLLBACK');await reconcileRegistrations(a,qA);assert(qA.get(id)?.state==='pending_registration'&&qA.get(id)?.generation===1,'回滚续跑被误激活');await client.query('BEGIN');await withLocalQueueRoot(qA.root,()=>rearmLocalJob(client,id));await client.query('COMMIT');await reconcileRegistrations(a,qA);assert(qA.get(id)?.state==='queued'&&qA.get(id)?.generation===1,'续跑新代未确认');
  }finally{client.release();}
 });

}catch(error){failure=error;console.error(error);}finally{
 try{if(schemaCreated){await admin.query('DROP SCHEMA ai_distill CASCADE');cleaned=!(await admin.query("SELECT to_regnamespace('ai_distill') AS name")).rows[0].name;}}finally{await Promise.all([a.end(),b.end(),admin.end()]);qA.close();qB.close();await rm(root,{recursive:true,force:true});await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify({at:new Date().toISOString(),passed:results.length,results,cleaned,models_called:false,error:failure instanceof Error?failure.message:null},null,2));}
}
if(failure)throw failure;
