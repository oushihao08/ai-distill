/** 职责：显式恢复保存失败的本机检查点，或在后续尝试失败后选回同来源的历史成功题包；HTTP入口不调用模型、不新建题或attempt。 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {localQueue,localQueueEnabled} from '../execution-queue/runtime';
import {logEvent} from '../logging';
import {renderPublicQuestionPackage,type AuthoringResult} from './executor';

/** 用户明确选择历史成功结果；expectedLatestAttemptId防止覆盖选择期间的新派发。 */
export async function selectHistoricalAuthoringResult(pool:Pool,workflowId:string,attemptId:string,expectedLatestAttemptId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query(`SELECT w.id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id
   WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w`,[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'题目不存在'});
  const latest=(await db.query('SELECT id,status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1 FOR UPDATE',[workflowId])).rows[0];
  if(latest?.id!==expectedLatestAttemptId||!['failed','skipped'].includes(latest.status))throw new HTTPException(409,{message:'当前出题尝试已变化或尚未失败，未选择历史结果'});
  if((await db.query("SELECT 1 FROM ai_distill.step_attempts WHERE workflow_id=$1 AND status IN ('waiting','running') LIMIT 1",[workflowId])).rowCount)throw new HTTPException(409,{message:'题目仍有活动任务，不能选择历史结果'});
  const old=(await db.query("SELECT input,result FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=4 AND status='succeeded'",[attemptId,workflowId])).rows[0];
  if(!old?.result?.question_version||!old.result.rubric_version)throw new HTTPException(409,{message:'指定尝试没有完整的已保存成功结果'});
  const source=(await db.query('SELECT package_id,revision_id,redaction_id,markdown_artifact_id FROM ai_distill.question_library_sources WHERE workflow_id=$1',[workflowId])).rows[0];
  const origin=old.input?.material_origin;
  if(!source||origin?.kind!=='library_v1'||['package_id','revision_id','redaction_id'].some(key=>(origin[key]??null)!==(source[key]??null))||
   !Array.isArray(old.input.materials)||old.input.materials.length!==1||old.input.materials[0].id!==source.markdown_artifact_id)throw new HTTPException(409,{message:'历史结果与当前冻结材料身份不一致'});
  if((await db.query("SELECT 1 FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal BETWEEN 5 AND 8 AND status NOT IN ('waiting','skipped') LIMIT 1",[workflowId])).rowCount)throw new HTTPException(409,{message:'后续步骤已有状态，不能直接选择历史结果'});
  if(!(await db.query("SELECT 1 FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind='authored_question' LIMIT 1",[workflowId,attemptId])).rowCount)throw new HTTPException(409,{message:'历史成功题包产物缺失'});
  const result={...old.result,result_selection:{attempt_id:attemptId,previous_attempt_id:expectedLatestAttemptId,selected_at:new Date().toISOString()}};
  await db.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[workflowId,JSON.stringify(result)]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='已选择历史出题结果',finished_at=now() WHERE project_id=(SELECT project_id FROM ai_distill.workflows WHERE id=$1) AND status IN ('running','succeeded')",[workflowId]);
  await db.query('COMMIT');
  logEvent('attempt.result_selected',{level:'info',component:'authoring',operation:'select_historical_result',workflow_id:workflowId,attempt_id:attemptId,state:'succeeded'});
  return{id:attemptId,status:'succeeded',question_version:old.result.question_version,rubric_version:old.result.rubric_version};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function restoreAuthoringResult(pool:Pool,root:string,workflowId:string,attemptId:string){
 if(!localQueueEnabled())throw new HTTPException(409,{message:'恢复原结果需要本机队列检查点'});
 const q=localQueue(root),job=q.get(attemptId);
 if(!job||job.kind!=='step'||job.route!=='authoring'||job.cancel_requested||!['failed','committed'].includes(job.state))throw new HTTPException(409,{message:'原出题任务尚未停止、已取消或不属于本机'});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const row=(await db.query(`SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id
   JOIN ai_distill.projects p ON p.id=w.project_id WHERE a.id=$1 AND a.workflow_id=$2 AND a.ordinal=4
   AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w,a`,[attemptId,workflowId])).rows[0];
  if(!row)throw new HTTPException(404,{message:'原出题任务不存在'});
  const latest=(await db.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1',[workflowId])).rows[0]?.id;
  if(latest!==attemptId)throw new HTTPException(409,{message:'已有更新的出题任务，不能覆盖'});
  if(row.status==='succeeded'){await db.query('COMMIT');q.resolve(attemptId,'committed');return{id:attemptId,status:'succeeded',reused:true};}
  if(row.status!=='failed'||row.result?.failure_phase!=='result_persistence')throw new HTTPException(409,{message:'仅恢复调用已完成但保存失败的原题包'});
  const result=q.completedCall<AuthoringResult>(attemptId,`${job.generation}:authoring_complete`);
  if(!result)throw new HTTPException(409,{message:'没有已完成的作者结果检查点；未重跑模型'});
  const stored={...result.draft,...(row.input.scoring_policy?{scoring_policy:row.input.scoring_policy}:{}),question_id:result.question_id,question_version:result.question_version,rubric_version:result.rubric_version,codex:{author:result.codex},result_recovery:{prior_failure:row.result,prior_error:row.error}};
  const bytes=Buffer.from(renderPublicQuestionPackage({project_name:row.input.project_name,question:row.input.title,question_id:row.input.question_id,source_files:row.input.source_files??[]},result.draft));
  const path=join(resolve(root),workflowId,attemptId,'authored_question.md');await mkdir(join(resolve(root),workflowId,attemptId),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});
  await db.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1",[attemptId,JSON.stringify(stored),result.codex.session_id]);
  await db.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[workflowId,JSON.stringify(stored)]);
  await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content)
   SELECT $1,$2,$3,'authored_question',$4,$5,$6,$7 WHERE NOT EXISTS(SELECT 1 FROM ai_distill.artifacts WHERE attempt_id=$3 AND kind='authored_question')`,[randomUUID(),workflowId,attemptId,relative(resolve(root),path),createHash('sha256').update(bytes).digest('hex'),bytes.length,bytes.toString('utf8')]);
  await db.query('COMMIT');q.resolve(attemptId,'committed');
  logEvent('attempt.result_restored',{level:'info',component:'authoring',operation:'restore_saved_result',workflow_id:workflowId,attempt_id:attemptId,state:'succeeded'});
  return{id:attemptId,status:'succeeded',question_version:result.question_version,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
