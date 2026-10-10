/**
 * 职责：返修链入口：基于阶段尝试启动或恢复链，冻结步骤配置与模型集合。
 * 关键方法与用途：`startRevision()` 从问题来源创建并冻结返修链；`resumeRevision()` 校验来源与当前状态后恢复链。
 * 使用场景：由 `app.ts` 的返修 API 调用，接续执行交给 `revision-runner.ts`。
 */
import type {Pool} from 'pg';
import {mergeRedactionDefaults} from '../materials/redaction-config';
import {readProjectModelSet} from '../answer-models/model-set';
import {HTTPException} from 'hono/http-exception';
import {buildFailedEvaluationHistory,classifyRevisionSource,freezeRevisionBudget} from './revision-source';
import {decideRevision} from './revision';
import {mergeCodexDefaults,readProjectAgentDefaults} from '../agent/config';
import {DEFAULT_REDACTION_PROMPT} from '@shared/step-registry';
import {DEFAULT_STEP_PROMPTS} from '@shared/step-prompts';
import {classifyLogError,logEvent,withLogContext} from '../logging';

// All mutation paths lock the workflow first, matching existing stage queues.
export async function startRevision(pool:Pool,workflowId:string,sourceAttemptId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query("SELECT w.project_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const logContext={component:'revision',operation:'revision_start',workflow_id:workflowId,project_id:workflow.project_id};
  withLogContext(logContext,()=>logEvent('revision.start.started',{level:'info'}));
  const source=(await db.query("SELECT * FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2",[sourceAttemptId,workflowId])).rows[0];
  if(!source)throw new HTTPException(409,{message:'返修来源不属于此题目'});
  const currentStep=(await db.query('SELECT status,finished_at FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=$2',[workflowId,source.ordinal])).rows[0];
  if(!currentStep||!currentStep.finished_at||['waiting','running','skipped'].includes(currentStep.status))throw new HTTPException(409,{message:'来源对应的步骤已失效，请先重新执行'});
  const previous=(await db.query('SELECT * FROM ai_distill.revision_chains WHERE workflow_id=$1 AND source_attempt_id=$2',[workflowId,sourceAttemptId])).rows[0];
  if(previous){await db.query('COMMIT');withLogContext(logContext,()=>logEvent('revision.start.reused',{level:'info',state:'reused'}));return {...previous,reused:true};}
  const active=(await db.query("SELECT id FROM ai_distill.revision_chains WHERE workflow_id=$1 AND status IN ('waiting','running','blocked')",[workflowId])).rows[0];
  if(active)throw new HTTPException(409,{message:'此题已有未结束返修链，请使用现有链恢复'});
  // Latest source is required: historic failures must not revise a newer result.
  const latest=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=$2 ORDER BY attempt DESC LIMIT 1",[workflowId,source.ordinal])).rows[0];
  if(latest?.id!==source.id)throw new HTTPException(409,{message:'返修来源已被新的步骤结果替代'});
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND status IN ('waiting','running') LIMIT 1",[workflowId])).rowCount)throw new HTTPException(409,{message:'当前题目仍有活动任务，不能启动返修'});
  const classified=classifyRevisionSource(source);
  if(!classified)throw new HTTPException(409,{message:'来源没有可处理的失败或返修判定'});
  let evidence=classified.evidence;
  if(source.ordinal===7){
   const failed=(await db.query("SELECT id,attempt,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 AND status='succeeded' AND result->>'decision'='repair' ORDER BY attempt DESC LIMIT 3",[workflowId])).rows;
   const history=buildFailedEvaluationHistory(failed.length?failed:[source]);
   evidence={...evidence,evaluation_records:history};
  }
  const raw=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  const settings=(await db.query('SELECT ordinal,config FROM ai_distill.project_step_configs WHERE project_id=$1 ORDER BY ordinal',[workflow.project_id])).rows;
  const configs=Object.fromEntries(settings.map(row=>[String(row.ordinal),row.config])) as Record<string,Record<string,unknown>>;
  const codexDefaults=await readProjectAgentDefaults(db,workflow.project_id);
  for(const ordinal of ['4','6','9']){
   if(ordinal==='9'){
    const raw=mergeRedactionDefaults(configs[ordinal],codexDefaults);
    // Missing API defaults stay missing in this frozen chain; unrelated scoring repairs can proceed.
    configs[ordinal]=raw.provider==='api'?{...raw,api:'api' in raw?raw.api:null}:raw;
   }else configs[ordinal]=mergeCodexDefaults({provider:'codex',...(configs[ordinal]??{})},codexDefaults);
  }
  const configSnapshot={configs,model_set:await readProjectModelSet(db,workflow.project_id)};
  const budget=freezeRevisionBudget(raw?.revision_budget),decision=decideRevision(classified.kind,budget);
  const status=decision.action==='isolate'?'isolated':decision.action==='wait'?'blocked':'waiting';
  const question=(await db.query("SELECT result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0]?.result;
  const chainId=crypto.randomUUID(),roundId=crypto.randomUUID();
  const chain=(await db.query("INSERT INTO ai_distill.revision_chains(id,workflow_id,source_attempt_id,status,budget,content_revisions,technical_retries,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[chainId,workflowId,source.id,status,JSON.stringify(budget),decision.content_revisions,decision.technical_retries,decision.reason])).rows[0];
  await db.query('INSERT INTO ai_distill.revision_rounds(id,chain_id,round,source_attempt_id,issue_kind,evidence,decision,status,before_versions,before_scores,workflow_id) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)',[roundId,chainId,source.id,classified.kind,JSON.stringify(evidence),JSON.stringify(decision),status,JSON.stringify({question_version:question?.question_version??null,rubric_version:question?.rubric_version??null}),JSON.stringify(source.result?.model_scores??{}),workflowId]);
  await db.query('UPDATE ai_distill.revision_chains SET config_snapshot=$2 WHERE id=$1',[chainId,JSON.stringify(configSnapshot)]);
  await db.query('UPDATE ai_distill.revision_rounds SET stage=$2 WHERE id=$1',[roundId,decision.return_step??source.ordinal]);
  await db.query('COMMIT');
  withLogContext({...logContext,operation_id:chainId},()=>logEvent('revision.start.completed',{level:'info',state:status,ordinal:decision.return_step??source.ordinal}));
  return {...chain,reused:false};
 }catch(error){withLogContext({component:'revision',operation:'revision_start',workflow_id:workflowId},()=>logEvent('revision.start.failed',{level:'error',state:'failed',...classifyLogError(error)}));await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function resumeRevision(pool:Pool,workflowId:string,chainId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const w=(await db.query("SELECT w.project_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  const chain=(await db.query('SELECT * FROM ai_distill.revision_chains WHERE id=$1 AND workflow_id=$2 FOR UPDATE',[chainId,workflowId])).rows[0];
  if(!w||!chain)throw new HTTPException(404,{message:'返修链不存在'});
  const logContext={component:'revision',operation:'revision_resume',operation_id:chainId,workflow_id:workflowId,project_id:w.project_id};
  withLogContext(logContext,()=>logEvent('revision.resume.started',{level:'info'}));

  if(chain.status!=='blocked')throw new HTTPException(409,{message:'只能恢复等待处理的返修链'});
  const round=(await db.query('SELECT * FROM ai_distill.revision_rounds WHERE chain_id=$1 ORDER BY round DESC LIMIT 1 FOR UPDATE',[chainId])).rows[0];
  if(!round)throw new HTTPException(409,{message:'缺少返修轮次'});
  if(round.issue_kind==='authentication'||round.issue_kind==='quota'){
   const decision=decideRevision('service_transient',{...chain.budget,content_revisions:chain.content_revisions,technical_retries:chain.technical_retries,calls:chain.calls_reserved,spent_duration_ms:Number(chain.spent_duration_ms)});
   if(decision.action!=='retry')throw new HTTPException(409,{message:'返修预算不足，不能恢复调用'});
   await db.query('UPDATE ai_distill.revision_rounds SET decision=$2,status=\'waiting\' WHERE id=$1',[round.id,JSON.stringify(decision)]);
   await db.query('UPDATE ai_distill.revision_chains SET technical_retries=$2 WHERE id=$1',[chainId,decision.technical_retries]);
  }else await db.query("UPDATE ai_distill.revision_rounds SET status='waiting' WHERE id=$1",[round.id]);
  await db.query("UPDATE ai_distill.revision_chains SET status='waiting',reason=NULL,updated_at=now() WHERE id=$1",[chainId]);
  await db.query('COMMIT');withLogContext(logContext,()=>logEvent('revision.resume.completed',{level:'info',state:'waiting'}));return {id:chainId,status:'waiting'};
 }catch(error){withLogContext({component:'revision',operation:'revision_resume',operation_id:chainId,workflow_id:workflowId},()=>logEvent('revision.resume.failed',{level:'error',state:'failed',...classifyLogError(error)}));await db.query('ROLLBACK');throw error;}finally{db.release();}
}
