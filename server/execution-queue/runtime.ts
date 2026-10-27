/** 执行队列与业务记录的桥接：注册归属、限制指定ID领取、复用外部调用结果。仅local模式启用。 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient,QueryConfig} from 'pg';
import {logEvent,classifyLogError} from '../logging';
import {join} from 'node:path';
import {storageDirectory} from '../paths';
import {readConcurrencySettings,readActiveConcurrencyLimit} from '../concurrency';
import {LocalQueue,InvalidLocalCheckpoint,assertJobId,type JobKind,type Lane,type QueueJob,type QueueIntent} from './store';
export function localQueueEnabled(){const mode=process.env.EXECUTION_QUEUE_MODE;if(mode===undefined||mode==='legacy')return false;if(mode==='local')return true;throw new Error('EXECUTION_QUEUE_MODE只支持local或legacy');}
const queues=new Map<string,LocalQueue>();
export function localQueue(root=storageDirectory()){let q=queues.get(root);if(!q){q=new LocalQueue(root);queues.set(root,q);}return q;}
interface Execution {queue:LocalQueue;job:QueueJob}
const current=new AsyncLocalStorage<Execution>();
const registrationRoot=new AsyncLocalStorage<string>();
export function withLocalQueueRoot<T>(root:string,run:()=>T){return registrationRoot.run(root,run);}
export function localExecutionQueue(){return current.getStore()?.queue??localQueue(registrationRoot.getStore());}
export function withLocalExecution<T>(queue:LocalQueue,job:QueueJob,execute:()=>Promise<T>){return current.run({queue,job},execute);}
/** 仅用于领取/失租清理的SQL；UUID经过校验，alias仅允许代码内标识。 */
export function localClaimSql(alias:string,stale=false){if(!localQueueEnabled())return '';if(!/^[a-z_]+$/.test(alias))throw new Error('执行表别名无效');const c=current.getStore();if(stale||!c)return ' AND FALSE ';assertJobId(c.job.id);return ` AND ${alias}.id='${c.job.id}'::uuid `;}
export function localWaitingSql(alias:string){return localQueueEnabled()&&current.getStore()?`${alias}.status IN ('waiting','running')`:`${alias}.status='waiting'`;}
type ReplaceableKind='step'|'library'|'skill'|'advice';
/** 共享记录仅证明未开始的业务意图，不证明他机排队。与领取UPDATE竞争行锁；续作/已有结果不在此范围。 */
export function foreignUnstartedSql(alias:string,kind:ReplaceableKind,target:'local'|'server'='local'){
 if(!/^[a-z_]+$/.test(alias))throw new Error('执行表别名无效');
 if(!localQueueEnabled()||target!=='local')return 'FALSE';
 const owner=localExecutionQueue().executorId;assertJobId(owner);
 const state=kind==='library'
  ?`${alias}.status='queued' AND ${alias}.started_at IS NULL AND ${alias}.heartbeat_at IS NULL AND ${alias}.lease_token IS NULL AND ${alias}.result_summary='{}'::jsonb AND ${alias}.progress='{}'::jsonb AND ${alias}.execution_target='local'`
  :`${alias}.status='waiting' AND ${alias}.result IS NULL${kind==='advice'?'':` AND ${alias}.heartbeat_at IS NULL AND ${alias}.session_id IS NULL`}${kind==='step'?` AND ${alias}.execution_target='local' AND NOT EXISTS(SELECT 1 FROM ai_distill.artifacts queued_artifact WHERE queued_artifact.attempt_id=${alias}.id)`:''}`;
 return `(${state} AND ${alias}.finished_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.execution_dispatches queued_owner WHERE queued_owner.job_id=${alias}.id AND queued_owner.job_kind='${kind}' AND queued_owner.executor_id<>'${owner}'::uuid AND queued_owner.generation=0))`;
}
type PendingScope={kind:'step';id:string;ordinal:number}|{kind:'library';id:string;jobKind:'intake'|'extract'|'redact'}|{kind:'skill'|'advice';id:string};
/** 仅在用户新派发的原业务事务中替代他机未开始意图。失败整体回滚；不转移旧ID、不重放运行/未知调用。 */
export async function supersedeForeignPending(db:Pick<PoolClient,'query'>,scope:PendingScope,target:'local'|'server'='local'){
 if(!localQueueEnabled()||current.getStore()||target!=='local')return;
 const table={step:'step_attempts',library:'library_jobs',skill:'project_skill_attempts',advice:'revision_advice_attempts'}[scope.kind];
 const selector=scope.kind==='step'?'j.workflow_id=$1 AND j.ordinal=$2':scope.kind==='library'?'j.revision_id=$1 AND j.kind=$2':scope.kind==='skill'?'j.project_id=$1':'j.workflow_id=$1';
 const values=scope.kind==='step'?[scope.id,scope.ordinal]:scope.kind==='library'?[scope.id,scope.jobKind]:[scope.id];
 const terminal=scope.kind==='library'?"status='cancelled',error_code='superseded_before_start',error_message='他机未开始待办已由本机明确新派发替代'":"status='skipped',error='他机未开始待办已由本机明确新派发替代'";
 await db.query(`UPDATE ai_distill.${table} AS j SET ${terminal},finished_at=now() WHERE ${selector} AND ${foreignUnstartedSql('j',scope.kind,target)}`,values);
}
export async function registerLocalJob(db:Pick<PoolClient,'query'>,id:string,kind:JobKind,lane:Lane,route:string){
 return registerLocalJobs(db,[{id,kind,lane,route}]);
}
export function localQueueLimits(q:LocalQueue){const limits=readConcurrencySettings(process.env,q.root);return{agent:readActiveConcurrencyLimit(q.root)??limits.agent,api:readActiveConcurrencyLimit(join(q.root,'.execution-api-slots'))??limits.llmApi,internal:readActiveConcurrencyLimit(join(q.root,'.execution-internal-slots'))??limits.llmApi,hook:1,remote:1};}
/** 同一业务事务的新任务先整组原子预留，再登记PG归属；调用方失败时仍按原事务回滚，不拆出部分模型。 */
const registrations=new WeakMap<object,{queue:LocalQueue;ids:Set<string>}>();
/** 仅在同一连接ROLLBACK已确认后调用：再次读取归属，释放确定未提交的容量，不删除意图或重放未知请求。 */
export function forgetLocalRegistrations(db:object){registrations.delete(db);}
export async function releaseRolledBackRegistrations(db:Pick<PoolClient,'query'>){
 const registered=registrations.get(db);if(!registered)return;
 try{
  const rows=(await db.query('SELECT job_id FROM ai_distill.execution_dispatches WHERE job_id=ANY($1::uuid[])',[[...registered.ids]])).rows;
  const committed=new Set(rows.map(row=>row.job_id));
  for(const id of registered.ids)if(!committed.has(id))registered.queue.releaseAdmission(id);
  registrations.delete(db);
 }catch(error){logEvent('queue.admission_rollback_unknown',{level:'error',component:'local_execution_queue',...classifyLogError(error)});}
}
export async function registerLocalJobs(db:Pick<PoolClient,'query'>,entries:QueueIntent[]){
 if(!localQueueEnabled()||!entries.length)return;
 const q=current.getStore()?.queue??localQueue(registrationRoot.getStore());q.reserveIntents(entries,localQueueLimits(q));
 const registered=registrations.get(db)??{queue:q,ids:new Set<string>()};for(const entry of entries)registered.ids.add(entry.id);registrations.set(db,registered);
 for(const {id,kind,lane,route} of entries){
  const row=(await db.query(`INSERT INTO ai_distill.execution_dispatches(job_id,job_kind,executor_id,lane,route) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(job_id) DO UPDATE SET job_id=excluded.job_id RETURNING executor_id`,[id,kind,q.executorId,lane,route])).rows[0];
  if(row.executor_id!==q.executorId){const local=q.get(id);if(local?.state==='pending_registration'){q.cancel(id);q.confirmCancellation(id);}}
 }
}
const cursors=new WeakMap<LocalQueue,Map<string,Pick<QueueJob,'created_at'|'id'>>>();
function reconciliationBatch(q:LocalQueue,key:'registration'|'cancel'|'finished'){
 const state=cursors.get(q)??new Map<string,Pick<QueueJob,'created_at'|'id'>>();cursors.set(q,state);
 const batch=q.reconciliationPage(key,state.get(key)),last=batch.at(-1);
 if(last)state.set(key,{created_at:last.created_at,id:last.id});else state.delete(key);
 return batch;
}
export async function reconcileRegistrations(pool:Pool,q:LocalQueue){
 const pending=reconciliationBatch(q,'registration');if(!pending.length)return;
 const rows=(await pool.query(boundedQuery('SELECT job_id,executor_id,generation FROM ai_distill.execution_dispatches WHERE job_id=ANY($1::uuid[])'),[pending.map(j=>j.id)])).rows;
 const limits=localQueueLimits(q);
 for(const row of rows)if(row.executor_id===q.executorId){const job=q.get(row.job_id);if((row.generation??0)===job?.generation)q.confirm(row.job_id,limits[job!.lane]);}else{q.cancel(row.job_id);q.confirmCancellation(row.job_id);}
}
// 当前pg实现支持逐查询read timeout；类型包未声明该可选属性。Pool.query错误路径会释放失败连接。
function boundedQuery(text:string):QueryConfig&{query_timeout:number}{return{text,query_timeout:15000};}
const tables:Record<JobKind,string>={step:'step_attempts',skill:'project_skill_attempts',library:'library_jobs',hook:'hook_runs',remote:'remote_material_operations',advice:'revision_advice_attempts'};
export async function cloudJobState(pool:Pool,q:LocalQueue,job:QueueJob){
 const row=(await pool.query(boundedQuery(`SELECT j.status FROM ai_distill.${tables[job.kind]} j JOIN ai_distill.execution_dispatches d ON d.job_id=j.id WHERE j.id=$1 AND d.executor_id=$2 AND d.generation=$3`),[job.id,q.executorId,job.generation])).rows[0];return row?.status as string|undefined;
}
export async function cachedExternalCall<T>(key:string,execute:()=>Promise<T>){const c=current.getStore();return c?c.queue.call(c.job.id,`${c.job.generation}:${key}`,execute):execute();}
export class PendingLocalCommit extends Error{constructor(){super('本机结果已保存，等待业务结果提交');}}
export class RecordedStepFailure extends Error{
 constructor(readonly failure:import('./store').StepFailure){super(failure.message);}
}
/** 原业务处理器恢复终态，沿用其版本检查和多模型汇总，跳过输入准备、钩子及模型执行。 */
export function readStepFailure(){const c=current.getStore();return c?c.queue.stepFailure(c.job):null;}
export function resumeStepFailure(){const failure=readStepFailure();if(failure)throw new RecordedStepFailure(failure);}
export function saveStepFailure(failure:import('./store').StepFailure){const c=current.getStore();if(c?.job.kind==='step')c.queue.saveStepFailure(c.job,failure);return failure;}
export function readLibraryFailure(){const c=current.getStore();return c?.job.kind==='library'?c.queue.libraryFailure(c.job):null;}
export function saveLibraryFailure(failure:import('./store').LibraryFailure){const c=current.getStore();if(c?.job.kind==='library')c.queue.saveLibraryFailure(c.job,failure);return failure;}
export function isTransientCommitFailure(error:unknown){
 const primary=error instanceof AggregateError?error.errors[0]:error,code=(primary as {code?:string})?.code,message=primary instanceof Error?primary.message:'';
 return Boolean(code&&(/^(08|57P)/.test(code)||['ECONNRESET','ETIMEDOUT','EPIPE','ECONNREFUSED','40001','40P01','55P03'].includes(code)))||/^(?:Connection terminated(?: unexpectedly| due to connection timeout)?|Query read timeout)$/.test(message);
}
export function deferLocalPublication(error:unknown){
 if(error instanceof PendingLocalCommit||error instanceof InvalidLocalCheckpoint)throw error;
 const c=current.getStore();
 if(c&&c.queue.hasResult(c.job.id)&&!c.queue.hasUnknownCall(c.job.id)&&isTransientCommitFailure(error))throw new PendingLocalCommit();
}
export function localCancellationRequested(){const c=current.getStore();return Boolean(c&&c.queue.get(c.job.id)?.cancel_requested);}

export async function assertLocalQueueEnvironment(pool:Pool,root:string){
 const q=localQueue(root),row=(await pool.query("SELECT to_regclass('ai_distill.execution_dispatches') IS NOT NULL AS available,current_setting('application_name') AS app")).rows[0];
 if(!row?.available)throw new Error('本机独立队列需要047迁移；未回退共享队列');
 if(row.app!==`ai-distill-executor:${q.executorId}`)throw new Error('数据库连接未保留本机执行身份，停止领取以免错误归属');
}

/** 已提交但本机回执未知时只对账，不再次调用执行器。 */
export async function reconcileTerminalOutcome(pool:Pool,q:LocalQueue,job:QueueJob){
 const status=await cloudJobState(pool,q,job);
 const terminal=status==='succeeded'?'committed':status==='failed'?'failed':status==='cancelled'?'cancelled':status==='skipped'?'stale':status==='needs_review'?'needs_review':null;
 if(terminal){q.finish(job.id,job.lease!,terminal);return true;}return false;
}

/** 本机取消的云端同步；网络失败保留本地取消意图，后续仅补交取消。 */
export async function synchronizeCancellation(pool:Pool,q:LocalQueue,id:string){
 const job=q.get(id);if(!job?.cancel_requested)return;
 const db=await pool.connect();let discard:Error|undefined;const query=(text:string,values?:unknown[])=>db.query(boundedQuery(text),values);try{
   await query('BEGIN');await query("SET LOCAL statement_timeout='10s'");await query("SET LOCAL lock_timeout='2s'");const owner=(await query('SELECT executor_id FROM ai_distill.execution_dispatches WHERE job_id=$1',[id])).rows[0];
   if(!owner){await query('ROLLBACK');return;}
   if(owner.executor_id!==q.executorId){await query('ROLLBACK');q.confirmCancellation(id);return;}
   const source=(await query(`SELECT status FROM ai_distill.${tables[job.kind]} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
   if(source&&['succeeded','failed','cancelled','skipped','needs_review'].includes(source.status)){
    await query('COMMIT');q.resolve(id,source.status==='succeeded'?'committed':source.status==='skipped'?'stale':source.status);q.confirmCancellation(id);return;
   }
   if(job.kind==='library')await query("UPDATE ai_distill.library_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=$1 AND status IN ('queued','running')",[id]);
   else if(job.kind==='step'){
    const cancelled=(await query("UPDATE ai_distill.step_attempts SET status='skipped',error='用户取消本机任务',finished_at=now() WHERE id=$1 AND status IN ('waiting','running') RETURNING workflow_id,ordinal",[id])).rows[0];
    if(cancelled)await query("UPDATE ai_distill.steps s SET status='failed',error='本机任务已取消',finished_at=now() WHERE workflow_id=$1 AND ordinal=$2 AND status IN ('waiting','running') AND NOT EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=s.workflow_id AND a.ordinal=s.ordinal AND a.status IN ('waiting','running'))",[cancelled.workflow_id,cancelled.ordinal]);
   }else if(job.kind==='advice'){await query("UPDATE ai_distill.revision_advice_attempts SET status='skipped',error='用户取消返修建议',finished_at=now() WHERE id=$1 AND status IN ('waiting','running')",[id]);
   }else{const table=tables[job.kind];await query(`UPDATE ai_distill.${table} SET status='failed' WHERE id=$1 AND status IN ('waiting','running')`,[id]);}
   await query('COMMIT');q.confirmCancellation(id);
  }catch(error){discard=error instanceof Error?error:new Error('取消同步失败');try{await query('ROLLBACK');}catch(rollbackError){logEvent('queue.rollback_failed',{level:'error',component:'local_execution_queue',...classifyLogError(rollbackError)});}throw error;}finally{db.release(discard);}
}

export async function synchronizeLocalCancellations(pool:Pool,q:LocalQueue){
 const pending=reconciliationBatch(q,'cancel');if(!pending.length)return;
 // 尚未提交/已回滚的登记不逐项开启空事务；保留取消意图，后续轮次再探测。
 const owners=(await pool.query(boundedQuery('SELECT job_id FROM ai_distill.execution_dispatches WHERE job_id=ANY($1::uuid[])'),[pending.map(job=>job.id)])).rows;
 const registered=new Set(owners.map(row=>row.job_id));
 for(const job of pending.filter(job=>registered.has(job.id))){
  try{await synchronizeCancellation(pool,q,job.id);}catch(error){logEvent('queue.cancel_sync_failed',{level:'error',component:'local_execution_queue',...classifyLogError(error)});}
 }
}

/** 仅由已有明确续跑/重试入口调用；新代意图等同事务提交确认后才可领取。 */
export async function rearmLocalJob(db:Pick<PoolClient,'query'>,id:string){
 if(!localQueueEnabled())return;const q=current.getStore()?.queue??localQueue(registrationRoot.getStore());
 const row=(await db.query('UPDATE ai_distill.execution_dispatches SET generation=generation+1 WHERE job_id=$1 AND executor_id=$2 RETURNING generation',[id,q.executorId])).rows[0];
 if(!row)throw new Error('原尝试属于其他电脑或旧队列，不能在本机续跑');
 const job=q.get(id);if(!job)throw new Error('原任务本机记录缺失，不能猜测恢复');q.rearm(id,row.generation,localQueueLimits(q)[job.lane]);
}

/** 对已结束但本地未确认的任务只读对账；不重放未知调用。 */
export async function reconcileFinishedJobs(pool:Pool,q:LocalQueue){
 for(const job of reconciliationBatch(q,'finished')){try{const status=await cloudJobState(pool,q,job);if(status==='succeeded')q.settle(job.id,'committed',job.generation);else if(status==='failed')q.settle(job.id,'failed',job.generation);else if(status==='skipped'||status==='cancelled')q.settle(job.id,job.cancel_requested?'cancelled':'stale',job.generation);}catch(error){logEvent('queue.result_sync_failed',{level:'error',component:'local_execution_queue',...classifyLogError(error)});}}
}
