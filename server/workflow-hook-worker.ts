/**
 * 职责：本地异步钩子消费者，独立保存附加结果，不写主步骤或模型成绩。
 * 入口：runNextHook() 供 local/all worker 轮询；API worker 不领取本地脚本。
 * 行为：失效输入取消，失联幂等动作可恢复，非幂等未知副作用转待核；未迁移时保持旧队列可用。
 */
import {localClaimSql,localWaitingSql,deferLocalPublication,cachedExternalCall} from './execution-queue/runtime';
import type {Pool} from 'pg';
import {runHookScript} from './workflow-hooks';
import {classifyLogError,logEvent,withLogContext} from './logging';
const tableCache=new WeakMap<Pool,{available:boolean;expires:number}>();
/** 不只检查主尝试成功；上游重出、重新作答及同模型的新尝试都会使旧附加任务失效。 */
export function activeHookParentSql(resume=false){return `EXISTS(
 SELECT 1 FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id
 JOIN ai_distill.projects p ON p.id=w.project_id JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=a.ordinal
 WHERE a.id=h.attempt_id AND a.workflow_id=h.workflow_id AND w.deleted_at IS NULL AND p.deleted_at IS NULL
 AND a.ordinal=CASE h.stage WHEN 'authoring' THEN 4 WHEN 'answer' THEN 5 WHEN 'scoring' THEN 6 END
 AND ${resume?"a.status='failed'":"a.status IN ('running','succeeded') AND (h.position<>'after' OR a.status='succeeded')"} AND s.status IN ('running','succeeded','failed')
 AND NOT EXISTS(SELECT 1 FROM ai_distill.step_attempts newer WHERE newer.workflow_id=a.workflow_id AND newer.ordinal=a.ordinal AND newer.attempt>a.attempt
  AND (a.ordinal=4 OR (a.ordinal=5 AND newer.input->>'model_id' IS NOT DISTINCT FROM a.input->>'model_id') OR (a.ordinal=6 AND newer.input#>>'{context,binding,answer_attempt_id}' IS NOT DISTINCT FROM a.input#>>'{context,binding,answer_attempt_id}')))
 AND (a.ordinal=4 OR EXISTS(
  SELECT 1 FROM ai_distill.step_attempts q JOIN ai_distill.steps qs ON qs.workflow_id=q.workflow_id AND qs.ordinal=4 AND qs.status='succeeded'
  WHERE q.workflow_id=a.workflow_id AND q.ordinal=4 AND q.status='succeeded' AND q.id=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=a.workflow_id AND ordinal=4 ORDER BY attempt DESC LIMIT 1)
  AND ((a.ordinal=5 AND a.input->>'question_attempt_id'=q.id::text) OR (a.ordinal=6 AND a.input#>>'{context,binding,question_version}'=q.result->>'question_version'
   AND EXISTS(SELECT 1 FROM ai_distill.step_attempts ans WHERE ans.id::text=a.input#>>'{context,binding,answer_attempt_id}' AND ans.workflow_id=a.workflow_id AND ans.ordinal=5 AND ans.status='succeeded' AND ans.input->>'question_attempt_id'=q.id::text
    AND NOT EXISTS(SELECT 1 FROM ai_distill.step_attempts newer_answer WHERE newer_answer.workflow_id=ans.workflow_id AND newer_answer.ordinal=5 AND newer_answer.attempt>ans.attempt AND newer_answer.input->>'model_id' IS NOT DISTINCT FROM ans.input->>'model_id')))))
 ))`;}
async function available(pool:Pool){
 const cached=tableCache.get(pool);if(cached&&cached.expires>Date.now())return cached.available;
 const exists=(await pool.query("SELECT to_regclass('ai_distill.hook_runs') IS NOT NULL AS available")).rows[0]?.available===true;
 tableCache.set(pool,{available:exists,expires:Date.now()+30000});return exists;
}
export async function runNextHook(pool:Pool,signal?:AbortSignal,mode:'api'|'local'|'all'='all',execute:typeof runHookScript=runHookScript):Promise<boolean>{
 if(mode==='api'||signal?.aborted)return false;
 if(!await available(pool))return false;
 const active=activeHookParentSql(),db=await pool.connect();let job:any,changed=false;
 try{
  await db.query('BEGIN');
  const cancelled=await db.query(`UPDATE ai_distill.hook_runs h SET status='cancelled',error='主任务或输入已失效',finished_at=now() WHERE h.mode='async' AND h.status IN ('waiting','running') AND NOT ${active} ${localClaimSql('h')}`);
  const recovered=await db.query(`UPDATE ai_distill.hook_runs h SET status=CASE WHEN idempotent THEN 'waiting' ELSE 'needs_review' END,error=CASE WHEN idempotent THEN '幂等钩子中断，等待恢复' ELSE '钩子副作用状态未知，等待人工核实' END,finished_at=CASE WHEN idempotent THEN NULL ELSE now() END WHERE h.mode='async' AND h.status='running' AND COALESCE(h.heartbeat_at,h.started_at)<now()-interval '5 minutes' AND ${active} ${localClaimSql('h',true)}`);
  changed=!!cancelled.rowCount||!!recovered.rowCount;
  job=(await db.query(`SELECT h.* FROM ai_distill.hook_runs h WHERE h.mode='async' AND ${localWaitingSql('h')} AND ${active} ${localClaimSql('h')} ORDER BY h.created_at,h.id FOR UPDATE OF h SKIP LOCKED LIMIT 1`)).rows[0];
  if(job)await db.query("UPDATE ai_distill.hook_runs SET status='running',started_at=now(),heartbeat_at=now(),error=NULL WHERE id=$1 AND status IN ('waiting','running') RETURNING id",[job.id]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 if(!job)return changed;
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let checking=false;
 const heartbeat=setInterval(()=>{
  if(checking)return;checking=true;
  pool.query(`UPDATE ai_distill.hook_runs h SET heartbeat_at=now() WHERE h.id=$1 AND h.status='running' AND ${active} RETURNING id`,[job.id]).then(result=>{if(!result.rowCount)controller.abort();}).catch(error=>{controller.abort();withLogContext({component:'workflow_hooks',attempt_id:job.attempt_id,workflow_id:job.workflow_id},()=>logEvent('hook.heartbeat_failed',{level:'error',...classifyLogError(error)}));}).finally(()=>{checking=false;});
 },3000);
 try{
  const result=await cachedExternalCall('async_hook',()=>execute(job.snapshot.hook,job.snapshot.payload,{signal:controller.signal}));
  if(controller.signal.aborted)throw new Error('hook cancelled');
  await pool.query(`UPDATE ai_distill.hook_runs h SET status=$2,result=$3,error=NULL,finished_at=now() WHERE h.id=$1 AND h.status='running' AND ${active} RETURNING id`,[job.id,'succeeded',JSON.stringify(result)]);
 }catch(error){
  deferLocalPublication(error);
  // 服务退出不等于业务取消；保留可恢复动作，未知副作用仍需人工核实。
  const status=signal?.aborted?(job.idempotent?'waiting':'needs_review'):controller.signal.aborted?'cancelled':job.idempotent?'failed':'needs_review';
  await pool.query("UPDATE ai_distill.hook_runs h SET status=$2,result=$3,error='项目钩子执行失败或中断',finished_at=now() WHERE h.id=$1 AND h.status='running' RETURNING id",[job.id,status,null]);
  withLogContext({component:'workflow_hooks',attempt_id:job.attempt_id,workflow_id:job.workflow_id},()=>logEvent('hook.failed',{level:'error',reason_code:status}));
 }finally{clearInterval(heartbeat);signal?.removeEventListener('abort',abort);}
 return true;
}
