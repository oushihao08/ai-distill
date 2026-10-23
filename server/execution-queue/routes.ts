/** 本机队列状态、取消与有日志证据的失败对账入口；不暴露正文、凭证或调用检查点。由createApp挂载。 */
import type {Hono} from 'hono';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {localQueueEnabled,localQueue,registerLocalJob,synchronizeCancellation} from './runtime';
import type {JobKind,Lane} from './store';
import {uuid} from '../validation';
import {sanitizeLogRecord} from '../logging';

/** 只接受本机worker日志中可核实的失败事件；扫描上限与诊断CLI一致，截断即拒绝。 */
async function verifiedFailureEvent(root:string,attemptId:string,eventId:string,instanceId:string){
 const logRoot=join(root,'logs'),dayPattern=/^\d{4}-\d{2}-\d{2}$/;
 let days;try{days=(await readdir(logRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&dayPattern.test(entry.name)).map(entry=>entry.name).sort().reverse();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 const files:{path:string;modified:number}[]=[];
 for(const day of days){
  for(const entry of await readdir(join(logRoot,day),{withFileTypes:true}))if(entry.isFile()&&entry.name.startsWith(`worker-${instanceId}-`)&&/^worker-[a-f0-9-]{36}-\d{3}\.jsonl$/.test(entry.name)){const path=join(logRoot,day,entry.name);files.push({path,modified:(await stat(path)).mtimeMs});}
 }
 files.sort((a,b)=>b.modified-a.modified||a.path.localeCompare(b.path));
 if(files.length>50)return null;
 let bytes=0;const records:Record<string,unknown>[]=[];
 for(const file of files){const info=await stat(file.path);bytes+=info.size;if(bytes>20*1024*1024)return null;const content=await readFile(file.path,'utf8');for(const line of content.split('\n')){if(!line)continue;let raw:unknown;try{raw=JSON.parse(line);}catch{return null;}const record=sanitizeLogRecord(raw);if(record&&record.service==='worker'&&record.attempt_id===attemptId)records.push(record);}}
 const failure=records.find(record=>record.event==='attempt.failed'&&record.event_id===eventId&&record.state==='failed'&&record.level==='error');
 if(!failure)return null;
 const failedAt=Date.parse(String(failure.occurred_at));
 if(records.some(record=>record.event==='attempt.completed'&&Date.parse(String(record.occurred_at))>=failedAt))return null;
 return failure;
}
export function registerExecutionQueueRoutes(app:Hono,pool:Pool,root:string){
 app.get('/api/system/execution-queue',c=>{
  if(!localQueueEnabled())return c.json({mode:'legacy',executor_id:null,items:[]});
  const q=localQueue(root);return c.json({mode:'local',executor_id:q.executorId,items:q.list().map(({pid,lease,error,...job})=>job)});
 });
 app.post('/api/system/execution-queue/adopt',async c=>{
  if(!localQueueEnabled())throw new HTTPException(409,{message:'尚未启用本机独立队列'});
  const body=await c.req.json<{jobs:{id:string;kind:JobKind}[]}>().catch(()=>{throw new HTTPException(400,{message:'认领参数须为JSON'});});
  if(!body||!Array.isArray(body.jobs)||!body.jobs.length||body.jobs.length>100||body.jobs.some(j=>!j||typeof j.id!=='string'||!['step','skill','library','hook','remote'].includes(j.kind)))throw new HTTPException(400,{message:'必须明确指定1至100个旧任务，不能自动导入全库'});
  const q=localQueue(root),db=await pool.connect(),accepted:string[]=[];
  try{await db.query('BEGIN');for(const input of body.jobs){
   uuid(input.id);const table=({step:'step_attempts',skill:'project_skill_attempts',library:'library_jobs',hook:'hook_runs',remote:'remote_material_operations'} as const)[input.kind];if(!table)throw new HTTPException(400,{message:'任务类型无效'});
   const j=(await db.query(`SELECT to_jsonb(j) AS job FROM ai_distill.${table} j WHERE id=$1 FOR UPDATE`,[input.id])).rows[0]?.job;
   if(!j||!['waiting','queued'].includes(j.status))throw new HTTPException(409,{message:'只能认领明确指定的未开始任务'});
   const owner=(await db.query('SELECT executor_id FROM ai_distill.execution_dispatches WHERE job_id=$1',[input.id])).rows[0];if(owner&&owner.executor_id!==q.executorId)throw new HTTPException(409,{message:'任务已归属另一台电脑，不自动迁移'});
   let route:string,lane:Lane;
   if(input.kind==='library'){route=`library:${j.kind}`;lane=j.executor_kind;}
   else if(input.kind==='skill'){route='skill';lane='agent';}
   else if(input.kind==='hook'){if(j.mode!=='async')throw new HTTPException(409,{message:'同步钩子属于原主任务'});route='hook';lane='hook';}
   else if(input.kind==='remote'){route='remote';lane='remote';}
   else{route=({1:'intake',2:'extract',4:'authoring',5:'answer',6:'score',8:'publish',9:'redact'} as Record<number,string>)[j.ordinal];if(!route)throw new HTTPException(409,{message:'该步骤不属于后台执行队列'});lane=j.ordinal===1||j.ordinal===8?'internal':j.ordinal===2?'api':j.ordinal===4?'agent':j.config?.provider==='codex'||j.ordinal===6&&j.config?.provider!=='api'?'agent':'api';}
   await registerLocalJob(db,input.id,input.kind,lane,route);accepted.push(input.id);
  }await db.query('COMMIT');return c.json({executor_id:q.executorId,ids:accepted});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.post('/api/system/execution-queue/:id/cancel',async c=>{
  if(!localQueueEnabled())throw new HTTPException(409,{message:'尚未启用本机独立队列'});
  const id=uuid(c.req.param('id'));const q=localQueue(root),job=q.get(id);if(!job)throw new HTTPException(404,{message:'任务不属于本机队列'});
  q.cancel(id); // local cancellation persists even when cloud is temporarily unavailable
  await synchronizeCancellation(pool,q,id);return c.json({id,cancel_requested:Boolean(q.get(id)?.cancel_requested),cloud_synced:Boolean(q.get(id)?.cancel_synced),executor_id:q.executorId});
 });
 app.post('/api/system/execution-queue/:id/reconcile-failed',async c=>{
  if(!localQueueEnabled())throw new HTTPException(409,{message:'尚未启用本机独立队列'});
  const id=uuid(c.req.param('id')),body=await c.req.json<{failure_event_id:string;failure_instance_id:string}>().catch(()=>{throw new HTTPException(400,{message:'对账参数须为JSON'});});
  if(!body||typeof body.failure_event_id!=='string'||typeof body.failure_instance_id!=='string')throw new HTTPException(400,{message:'必须提供attempt.failed日志事件ID及worker实例ID'});
  const eventId=uuid(body.failure_event_id),instanceId=uuid(body.failure_instance_id),q=localQueue(root),job=q.get(id);
  if(!job||job.kind!=='step'||job.state!=='needs_review'||job.pid!==null||job.lease!==null||job.cancel_requested)throw new HTTPException(409,{message:'仅可对账已停止且待核实的本机步骤任务'});
  const hasStartedCall=q.db.query("SELECT 1 FROM calls WHERE job_id=? AND state='started' LIMIT 1").get(id);
  if(!hasStartedCall)throw new HTTPException(409,{message:'缺少未决外部调用记录，不能按模型失败结算'});
  const evidence=await verifiedFailureEvent(root,id,eventId,instanceId);
  if(!evidence)throw new HTTPException(409,{message:'未找到完整、匹配且未被成功事件覆盖的失败日志'});
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const owner=(await db.query('SELECT executor_id,generation,job_kind FROM ai_distill.execution_dispatches WHERE job_id=$1 FOR UPDATE',[id])).rows[0];
   if(!owner||owner.executor_id!==q.executorId||owner.generation!==job.generation||owner.job_kind!=='step')throw new HTTPException(409,{message:'本机任务归属或代次已变化'});
   const attempt=(await db.query("SELECT id,workflow_id,ordinal,status FROM ai_distill.step_attempts WHERE id=$1 FOR UPDATE",[id])).rows[0];
   if(!attempt||attempt.status!=='running')throw new HTTPException(409,{message:'数据库步骤已变化，未执行对账'});
   const latest=(await db.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=$2 ORDER BY attempt DESC LIMIT 1',[attempt.workflow_id,attempt.ordinal])).rows[0];
   if(latest?.id!==id)throw new HTTPException(409,{message:'该尝试已不是当前步骤的最新尝试'});
   const step=(await db.query("SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=$2 FOR UPDATE",[attempt.workflow_id,attempt.ordinal])).rows[0];
   if(step?.status!=='running')throw new HTTPException(409,{message:'当前步骤状态已变化，未执行对账'});
   const error={kind:evidence.error_kind,reason_code:evidence.reason_code??null,retryable:false,provider_retryable:evidence.retryable??false,retry_suppressed:true,source:'verified_worker_log',event_id:eventId};
   const message='执行失败已由本机结构化日志核实';
   await db.query("UPDATE ai_distill.step_attempts SET status='failed',result=COALESCE(result,'{}'::jsonb)||jsonb_build_object('error',$2::jsonb,'failure_reconciled',true),error=$3,finished_at=now() WHERE id=$1 AND status='running'",[id,JSON.stringify(error),message]);
   const updated=await db.query("UPDATE ai_distill.steps SET status='failed',result=COALESCE(result,'{}'::jsonb)||jsonb_build_object('error',$3::jsonb,'failure_reconciled',true),error=$4,finished_at=now() WHERE workflow_id=$1 AND ordinal=$2 AND status='running'",[attempt.workflow_id,attempt.ordinal,JSON.stringify(error),message]);
   if(updated.rowCount!==1)throw new HTTPException(409,{message:'步骤状态并发变化，事务已回滚'});
   await db.query('COMMIT');q.settle(id,'failed');
   return c.json({id,state:'failed',reconciled:true,evidence_event_id:eventId});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
}
