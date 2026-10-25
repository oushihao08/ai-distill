/**
 * 职责：任务状态读取与有限等待：请求等待结束不取消后台执行，终态完成与成功分开表达。
 * 关键方法与用途：`waitDuration()` 限制 HTTP 等待时长；`waitForAttempt()` 只读观察；`cancelWaitingScore()` 取消未领取评分；`cancelStoppedExecutorAttempt()` 只在用户确认原机停止后显式终止未知旧尝试。
 * 使用场景：由 `app.ts` 的等待接口调用，区分终态完成与业务成功。
 */
import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import {logEvent} from './logging';

/** 显式取消未被领取的评分，不迁移执行归属；与评分worker共用workflow/attempt行锁。 */
async function cancelAttempt(pool:Pool,id:string,workflowId:string,executorId:string,stopped?:{heartbeat:string|null}){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='2s'");
  await db.query("SET LOCAL statement_timeout='10s'");
  const workflow=(await db.query('SELECT w.id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const row=(await db.query('SELECT a.id,a.ordinal,a.status,a.started_at,a.heartbeat_at,a.result IS NULL AS no_result,d.executor_id FROM ai_distill.step_attempts a LEFT JOIN ai_distill.execution_dispatches d ON d.job_id=a.id WHERE a.id=$1 AND a.workflow_id=$2 FOR UPDATE OF a',[id,workflowId])).rows[0];
  if(!row)throw new HTTPException(404,{message:'执行任务不存在'});
  if(!stopped){
   if(row.ordinal!==6||row.status!=='waiting'||row.heartbeat_at!==null||!row.no_result)throw new HTTPException(409,{message:'只允许取消未领取、无心跳及结果的waiting评分；运行或结果未知的调用须由原机核实'});
  }else{
   const timestamp=(value:string|Date|null)=>value===null?null:new Date(value).getTime();
   if(![5,6].includes(row.ordinal)||!['waiting','running'].includes(row.status)||!row.no_result)throw new HTTPException(409,{message:'仅支持未结算且无结果的作答/评分尝试'});
   if(timestamp(row.heartbeat_at)!==timestamp(stopped.heartbeat)||!Number.isFinite(timestamp(row.heartbeat_at??row.started_at))||Date.now()-Number(timestamp(row.heartbeat_at??row.started_at))<300000)throw new HTTPException(409,{message:'原任务心跳已变化或尚未陈旧，拒绝停止执行端结算'});
  }
  if(row.executor_id!==executorId)throw new HTTPException(409,{message:'执行归属已变化，未取消'});
  const latest=(await db.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=$2 ORDER BY attempt DESC LIMIT 1',[workflowId,row.ordinal])).rows[0];
  if(latest?.id!==id)throw new HTTPException(409,{message:'该评分已不是当前最新尝试'});
  const steps=await db.query('SELECT ordinal,status,result->>\'decision\' AS decision FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal IN ($2,7) FOR UPDATE',[workflowId,row.ordinal]);
  if(steps.rows.some(step=>step.ordinal===7&&step.status==='succeeded'&&step.decision==='accepted')||!steps.rows.some(step=>step.ordinal===row.ordinal&&(stopped?['waiting','running'].includes(step.status):step.status==='waiting')))throw new HTTPException(409,{message:'当前题目已达标或步骤已变化，未取消'});
  if((await db.query("SELECT 1 FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal IN (4,5,6) AND status IN ('waiting','running') AND id<>$2 LIMIT 1",[workflowId,id])).rowCount)throw new HTTPException(409,{message:'题目另有活动尝试，未取消'});
  if((await db.query('SELECT 1 FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1',[id])).rowCount)throw new HTTPException(409,{message:'原尝试已有产物，须先核实原结果'});
  const updated=stopped
   ?await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='用户确认原执行端停止；显式终止尝试，原外部调用结果未知',finished_at=now() WHERE id=$1 AND status=$2 AND date_trunc('milliseconds',heartbeat_at) IS NOT DISTINCT FROM $3::timestamptz AND result IS NULL RETURNING id",[id,row.status,stopped.heartbeat])
   :await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='显式取消未领取评分',finished_at=now() WHERE id=$1 AND status='waiting' AND heartbeat_at IS NULL AND result IS NULL RETURNING id",[id]);
  if(updated.rowCount!==1)throw new HTTPException(409,{message:'评分领取状态并发变化，未取消'});
  if(stopped){
   const changed=await db.query("UPDATE ai_distill.steps SET status='waiting',error='原执行端停止，原调用结果待核实',finished_at=NULL WHERE workflow_id=$1 AND ordinal=$2 AND status IN ('waiting','running') RETURNING ordinal",[workflowId,row.ordinal]);
   if(changed.rowCount!==1)throw new HTTPException(409,{message:'当前步骤并发变化，事务已回滚'});
  }
  await db.query('COMMIT');
  logEvent('attempt.cancelled',{level:'info',component:'workflow',operation:stopped?'cancel_stopped_executor':'cancel_waiting_score',workflow_id:workflowId,attempt_id:id,ordinal:row.ordinal,state:'skipped'});
  return{id,workflow_id:workflowId,ordinal:row.ordinal,status:'skipped',...(stopped?{prior_outcome:'unknown',executor_stopped_confirmed:true}:{cancelled_before_start:true})};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export const cancelWaitingScore=(pool:Pool,id:string,workflowId:string,executorId:string)=>cancelAttempt(pool,id,workflowId,executorId);
/** 仅供用户已确认原机停止并接受结果未知时显式取消；保留旧归属/结果，不派发替代模型调用。 */
export const cancelStoppedExecutorAttempt=(pool:Pool,id:string,workflowId:string,executorId:string,heartbeat:string|null)=>cancelAttempt(pool,id,workflowId,executorId,{heartbeat});

export function waitDuration(value: string | undefined) {
 if (value === undefined) return 0;
 if (!/^\d{1,5}$/.test(value) || Number(value)>30000) throw new HTTPException(400,{message:'wait_ms须为0至30000的整数'});
 return Number(value);
}

export async function waitForAttempt(pool: Pool, id: string, waitMs: number, signal: AbortSignal, view:'full'|'status'='full') {
 const deadline=performance.now()+waitMs;
 try {
  while (true) {
   if (signal.aborted) throw new HTTPException(408,{message:'等待请求已中断，后台任务继续执行'});
   // Waiting clients only need metadata; avoid fetching/serializing large JSONB results.
   const row=(await pool.query(`SELECT a.id,a.workflow_id,a.ordinal,a.status,${view==='full'?'a.result,':''}a.error,a.started_at,a.heartbeat_at,a.finished_at
    FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id
    WHERE a.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL`,[id])).rows[0];
   if (signal.aborted) throw new HTTPException(408,{message:'等待请求已中断，后台任务继续执行'});
   if (!row) throw new HTTPException(404,{message:'执行任务不存在'});
   const completed=['succeeded','failed','skipped'].includes(row.status);
   if (completed || performance.now()>=deadline) return {...row,completed};
   await new Promise<void>(resolve=>{
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,Math.min(1000,Math.max(0,deadline-performance.now())));
    signal.addEventListener('abort',finish,{once:true});
    if(signal.aborted)finish();
   });
  }
 } catch(error) { throw error; }
}
