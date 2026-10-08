import type {Pool} from 'pg';
import {readProjectModelSet} from '../answer-models/model-set';
import {HTTPException} from 'hono/http-exception';
import {classifyRevisionSource,freezeRevisionBudget} from './revision-source';
import {decideRevision} from './revision';

// All mutation paths lock the workflow first, matching existing stage queues.
export async function startRevision(pool:Pool,workflowId:string,sourceAttemptId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT w.input_revision,w.project_id,w.rule_version_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  await db.query("UPDATE ai_distill.revision_chains SET status='stale',reason='input_revision_changed',updated_at=now() WHERE workflow_id=$1 AND input_revision<>$2 AND status IN ('waiting','running','blocked')",[workflowId,workflow.input_revision]);
  const source=(await db.query('SELECT * FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND input_revision=$3',[sourceAttemptId,workflowId,workflow.input_revision])).rows[0];
  if(!source)throw new HTTPException(409,{message:'返修来源不属于当前材料版本'});
  const previous=(await db.query('SELECT * FROM ai_distill.revision_chains WHERE workflow_id=$1 AND source_attempt_id=$2',[workflowId,sourceAttemptId])).rows[0];
  if(previous){await db.query('COMMIT');return {...previous,reused:true};}
  const active=(await db.query("SELECT id FROM ai_distill.revision_chains WHERE workflow_id=$1 AND status IN ('waiting','running','blocked')",[workflowId])).rows[0];
  if(active)throw new HTTPException(409,{message:'此题已有未结束返修链，请使用现有链恢复'});
  // Latest source is required: historic failures must not revise a newer result.
  const latest=(await db.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=$2 AND input_revision=$3 ORDER BY attempt DESC LIMIT 1',[workflowId,source.ordinal,workflow.input_revision])).rows[0];
  if(latest?.id!==source.id)throw new HTTPException(409,{message:'返修来源已被新的步骤结果替代'});
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND input_revision=$2 AND status IN ('waiting','running') LIMIT 1",[workflowId,workflow.input_revision])).rowCount)throw new HTTPException(409,{message:'当前题目仍有活动任务，不能启动返修'});
  const classified=classifyRevisionSource(source);
  if(!classified)throw new HTTPException(409,{message:'来源没有可处理的失败或返修判定'});
  const raw=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  const settings=(await db.query('SELECT ordinal,config FROM ai_distill.project_step_configs WHERE project_id=$1 ORDER BY ordinal',[workflow.project_id])).rows;
  const configSnapshot={rule_version_id:workflow.rule_version_id??null,configs:Object.fromEntries(settings.map(row=>[String(row.ordinal),row.config])),model_set:await readProjectModelSet(db,workflow.project_id)};
  const budget=freezeRevisionBudget(raw?.revision_budget),decision=decideRevision(classified.kind,budget);
  const status=decision.action==='isolate'?'isolated':decision.action==='wait'?'blocked':'waiting';
  const question=(await db.query("SELECT result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[workflowId,workflow.input_revision])).rows[0]?.result;
  const chainId=crypto.randomUUID(),roundId=crypto.randomUUID();
  const chain=(await db.query('INSERT INTO ai_distill.revision_chains(id,workflow_id,input_revision,source_attempt_id,status,budget,content_revisions,technical_retries,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[chainId,workflowId,workflow.input_revision,source.id,status,JSON.stringify(budget),decision.content_revisions,decision.technical_retries,decision.reason])).rows[0];
  await db.query('INSERT INTO ai_distill.revision_rounds(id,chain_id,round,source_attempt_id,issue_kind,evidence,decision,status,before_versions,before_scores) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)',[roundId,chainId,source.id,classified.kind,JSON.stringify(classified.evidence),JSON.stringify(decision),status,JSON.stringify({input_revision:workflow.input_revision,question_version:question?.question_version??null,rubric_version:question?.rubric_version??null}),JSON.stringify(source.result?.model_scores??{})]);
  await db.query('UPDATE ai_distill.revision_chains SET config_snapshot=$2 WHERE id=$1',[chainId,JSON.stringify(configSnapshot)]);
  await db.query('UPDATE ai_distill.revision_rounds SET stage=$2 WHERE id=$1',[roundId,decision.return_step??source.ordinal]);
  await db.query('COMMIT');
  return {...chain,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function resumeRevision(pool:Pool,workflowId:string,chainId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const w=(await db.query('SELECT w.input_revision FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
  const chain=(await db.query('SELECT * FROM ai_distill.revision_chains WHERE id=$1 AND workflow_id=$2 FOR UPDATE',[chainId,workflowId])).rows[0];
  if(!w||!chain)throw new HTTPException(404,{message:'返修链不存在'});
  if(w.input_revision!==chain.input_revision)throw new HTTPException(409,{message:'材料版本已变化，请使用当前失败来源重新启动'});
  if(chain.status!=='blocked')throw new HTTPException(409,{message:'只能恢复等待处理的返修链'});
  const round=(await db.query('SELECT * FROM ai_distill.revision_rounds WHERE chain_id=$1 ORDER BY round DESC LIMIT 1 FOR UPDATE',[chainId])).rows[0];
  if(!round)throw new HTTPException(409,{message:'缺少返修轮次'});
  if(chain.reason==='batch_cancelled'||chain.reason==='project_cancelled'){
   const cancelled=(await db.query("SELECT * FROM ai_distill.step_attempts WHERE revision_round_id=$1 AND status='skipped' AND error IN ('自动批次已取消','项目执行已取消') ORDER BY attempt DESC LIMIT 1",[round.id])).rows[0];
   if(cancelled){
    const decision=decideRevision('service_transient',{...chain.budget,content_revisions:chain.content_revisions,technical_retries:chain.technical_retries,calls:chain.calls_reserved,spent_duration_ms:Number(chain.spent_duration_ms)});
    if(decision.action!=='retry')throw new HTTPException(409,{message:'取消后的恢复预算不足，请保留隔离记录'});
    await db.query("UPDATE ai_distill.revision_rounds SET status='failed',finished_at=now() WHERE id=$1",[round.id]);
    await db.query("INSERT INTO ai_distill.revision_rounds(id,chain_id,round,parent_round_id,source_attempt_id,issue_kind,evidence,decision,status,stage,before_versions,before_scores) VALUES($1,$2,$3,$4,$5,'service_transient',$6,$7,'waiting',$8,$9,$10)",[crypto.randomUUID(),chainId,round.round+1,round.id,cancelled.id,JSON.stringify({error:chain.reason}),JSON.stringify(decision),cancelled.ordinal,JSON.stringify(round.before_versions??{}),JSON.stringify(round.before_scores??{})]);
    await db.query('UPDATE ai_distill.revision_chains SET technical_retries=$2 WHERE id=$1',[chainId,decision.technical_retries]);
   }else await db.query("UPDATE ai_distill.revision_rounds SET status='waiting' WHERE id=$1",[round.id]);
   await db.query("UPDATE ai_distill.revision_chains SET status='waiting',reason=NULL,updated_at=now() WHERE id=$1",[chainId]);
   await db.query('COMMIT');return {id:chainId,status:'waiting'};
  }
  if(round.issue_kind==='authentication'||round.issue_kind==='quota'){
   const decision=decideRevision('service_transient',{...chain.budget,content_revisions:chain.content_revisions,technical_retries:chain.technical_retries,calls:chain.calls_reserved,spent_duration_ms:Number(chain.spent_duration_ms)});
   if(decision.action!=='retry')throw new HTTPException(409,{message:'返修预算不足，不能恢复调用'});
   await db.query('UPDATE ai_distill.revision_rounds SET decision=$2,status=\'waiting\' WHERE id=$1',[round.id,JSON.stringify(decision)]);
   await db.query('UPDATE ai_distill.revision_chains SET technical_retries=$2 WHERE id=$1',[chainId,decision.technical_retries]);
  }else await db.query("UPDATE ai_distill.revision_rounds SET status='waiting' WHERE id=$1",[round.id]);
  await db.query("UPDATE ai_distill.revision_chains SET status='waiting',reason=NULL,updated_at=now() WHERE id=$1",[chainId]);
  await db.query('COMMIT');return {id:chainId,status:'waiting'};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
