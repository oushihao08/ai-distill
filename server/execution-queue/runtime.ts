/** 执行队列与业务记录的桥接：注册归属、限制指定ID领取、复用外部调用结果。仅local模式启用。 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient,QueryConfig} from 'pg';
import {logEvent,classifyLogError} from '../logging';
import {storageDirectory} from '../paths';
import {LocalQueue,InvalidLocalCheckpoint,assertJobId,type JobKind,type Lane,type QueueJob} from './store';
export function localQueueEnabled(){const mode=process.env.EXECUTION_QUEUE_MODE;if(mode===undefined||mode==='legacy')return false;if(mode==='local')return true;throw new Error('EXECUTION_QUEUE_MODE只支持local或legacy');}
const queues=new Map<string,LocalQueue>();
export function localQueue(root=storageDirectory()){let q=queues.get(root);if(!q){q=new LocalQueue(root);queues.set(root,q);}return q;}
interface Execution {queue:LocalQueue;job:QueueJob}
const current=new AsyncLocalStorage<Execution>();
const registrationRoot=new AsyncLocalStorage<string>();
export function withLocalQueueRoot<T>(root:string,run:()=>T){return registrationRoot.run(root,run);}
export function withLocalExecution<T>(queue:LocalQueue,job:QueueJob,execute:()=>Promise<T>){return current.run({queue,job},execute);}
/** 仅用于领取/失租清理的SQL；UUID经过校验，alias仅允许代码内标识。 */
export function localClaimSql(alias:string,stale=false){if(!localQueueEnabled())return '';if(!/^[a-z_]+$/.test(alias))throw new Error('执行表别名无效');const c=current.getStore();if(stale||!c)return ' AND FALSE ';assertJobId(c.job.id);return ` AND ${alias}.id='${c.job.id}'::uuid `;}
export function localWaitingSql(alias:string){return localQueueEnabled()&&current.getStore()?`${alias}.status IN ('waiting','running')`:`${alias}.status='waiting'`;}
export async function registerLocalJob(db:Pick<PoolClient,'query'>,id:string,kind:JobKind,lane:Lane,route:string){
 if(!localQueueEnabled())return;const q=current.getStore()?.queue??localQueue(registrationRoot.getStore());q.intent(id,kind,lane,route);
 const row=(await db.query(`INSERT INTO ai_distill.execution_dispatches(job_id,job_kind,executor_id,lane,route) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(job_id) DO UPDATE SET job_id=excluded.job_id RETURNING executor_id`,[id,kind,q.executorId,lane,route])).rows[0];
 if(row.executor_id!==q.executorId){const local=q.get(id);if(local?.state==='pending_registration'){q.cancel(id);q.confirmCancellation(id);}}
}
const cursors=new WeakMap<LocalQueue,Map<string,number>>();
function reconciliationBatch(q:LocalQueue,key:string,items:QueueJob[]){
 const state=cursors.get(q)??new Map<string,number>();cursors.set(q,state);
 const start=(state.get(key)??0)%Math.max(1,items.length),batch=[...items.slice(start),...items.slice(0,start)].slice(0,20);
 state.set(key,start+batch.length);return batch;
}
export async function reconcileRegistrations(pool:Pool,q:LocalQueue){
 const pending=reconciliationBatch(q,'registration',q.list().filter(j=>j.state==='pending_registration'));if(!pending.length)return;
 const rows=(await pool.query(boundedQuery('SELECT job_id,executor_id,generation FROM ai_distill.execution_dispatches WHERE job_id=ANY($1::uuid[])'),[pending.map(j=>j.id)])).rows;
 for(const row of rows)if(row.executor_id===q.executorId){if((row.generation??0)===q.get(row.job_id)?.generation)q.confirm(row.job_id);}else{q.cancel(row.job_id);q.confirmCancellation(row.job_id);}
}
// 当前pg实现支持逐查询read timeout；类型包未声明该可选属性。Pool.query错误路径会释放失败连接。
function boundedQuery(text:string):QueryConfig&{query_timeout:number}{return{text,query_timeout:15000};}
const tables:Record<JobKind,string>={step:'step_attempts',skill:'project_skill_attempts',library:'library_jobs',hook:'hook_runs',remote:'remote_material_operations'};
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
   }else{const table=job.kind==='skill'?'project_skill_attempts':job.kind==='hook'?'hook_runs':'remote_material_operations';await query(`UPDATE ai_distill.${table} SET status='failed' WHERE id=$1 AND status IN ('waiting','running')`,[id]);}
   await query('COMMIT');q.confirmCancellation(id);
  }catch(error){discard=error instanceof Error?error:new Error('取消同步失败');try{await query('ROLLBACK');}catch(rollbackError){logEvent('queue.rollback_failed',{level:'error',component:'local_execution_queue',...classifyLogError(rollbackError)});}throw error;}finally{db.release(discard);}
}

export async function synchronizeLocalCancellations(pool:Pool,q:LocalQueue){
 for(const job of reconciliationBatch(q,'cancel',q.list().filter(j=>j.cancel_requested&&!j.cancel_synced))){
  try{await synchronizeCancellation(pool,q,job.id);}catch(error){logEvent('queue.cancel_sync_failed',{level:'error',component:'local_execution_queue',...classifyLogError(error)});}
 }
}

/** 仅由已有明确续跑/重试入口调用；新代意图等同事务提交确认后才可领取。 */
export async function rearmLocalJob(db:Pick<PoolClient,'query'>,id:string){
 if(!localQueueEnabled())return;const q=current.getStore()?.queue??localQueue(registrationRoot.getStore());
 const row=(await db.query('UPDATE ai_distill.execution_dispatches SET generation=generation+1 WHERE job_id=$1 AND executor_id=$2 RETURNING generation',[id,q.executorId])).rows[0];
 if(!row)throw new Error('原尝试属于其他电脑或旧队列，不能在本机续跑');
 if(!q.get(id))throw new Error('原任务本机记录缺失，不能猜测恢复');q.rearm(id,row.generation);
}

/** 对已结束但本地未确认的任务只读对账；不重放未知调用。 */
export async function reconcileFinishedJobs(pool:Pool,q:LocalQueue){
 for(const job of reconciliationBatch(q,'finished',q.list().filter(j=>['needs_review','result_pending_commit'].includes(j.state)))){try{const status=await cloudJobState(pool,q,job);if(status==='succeeded')q.settle(job.id,'committed');else if(status==='failed')q.settle(job.id,'failed');else if(status==='skipped'||status==='cancelled')q.settle(job.id,job.cancel_requested?'cancelled':'stale');}catch(error){logEvent('queue.result_sync_failed',{level:'error',component:'local_execution_queue',...classifyLogError(error)});}}
}
