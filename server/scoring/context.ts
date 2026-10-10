/**
 * 职责：评分上下文读取：校验题目、答案、rubric和数据库脱敏附件的一致性。
 * 关键方法与用途：`readScoreContext()` 组装匿名评分上下文；`validateAnswerScore()` 检查答案和评分绑定。
 * 使用场景：新评分任务不读取项目 skill；仅旧任务绑定校验兼容项目文件与规则快照。
 */
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {authoringQuestion,inputDigest,AnswerInputError} from '../answer-models/input';
import {validateScore,type ScoreContext,type RubricItem} from './validate';
import {readProjectPrompt,scanProjectPrompt,verifyRuleSnapshot} from '../rule-files';
import {dirname} from 'node:path';
// Inputs come from persisted successful attempts, never from the submitted score report.
export async function readScoreContext(db:PoolClient,workflowId:string,attemptId:string,legacyRules=false,legacyProjectPrompt=false):Promise<ScoreContext>{
 try{
  const w=(await db.query("SELECT w.rule_version_id,w.title,w.source_key,p.name AS project_name,p.local_skill_path,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  if(!w)throw new HTTPException(404,{message:'工作流不存在'});
  const answer=(await db.query("SELECT a.input,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=5 WHERE a.id=$1 AND a.workflow_id=$2 AND a.ordinal=5 AND a.status='succeeded' AND s.status='succeeded' AND ((s.result->>'answer_sha256'=a.result->>'answer_sha256' AND s.result->>'input_digest'=a.result->>'input_digest') OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s.result->'models','[]'::jsonb)) model WHERE model->>'attempt_id'=a.id::text AND model->>'answer_sha256'=a.result->>'answer_sha256'))",[attemptId,workflowId])).rows[0];
  const author=(await db.query("SELECT a.id,a.input,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s4 ON s4.workflow_id=a.workflow_id AND s4.ordinal=4 AND s4.status='succeeded' WHERE a.workflow_id=$1 AND a.ordinal=4 AND a.status='succeeded' ORDER BY a.attempt DESC LIMIT 1 FOR UPDATE OF s4,a",[workflowId])).rows[0];
  if(!answer||!author)throw new HTTPException(409,{message:'当前题目或作答尚未完成'});
  const question=authoringQuestion(author.result);const input=answer.input;const result=answer.result;
  const rubric=author.result.rubric;const rubric_version=author.result.rubric_version;
  if(typeof rubric_version!=='string'||!rubric_version.trim()||!Array.isArray(rubric)||!rubric.length||rubric.some((r:any)=>!r||typeof r.id!=='string'||typeof r.criterion!=='string'||typeof r.max_score!=='number'))throw new HTTPException(409,{message:'题目缺少有效rubric版本或条目'});
  if(typeof author.result.answer_approach!=='string'||!author.result.answer_approach.trim()||typeof author.result.reference_answer!=='string'||!author.result.reference_answer.trim())throw new HTTPException(409,{message:'题目缺少作答思路或标准答案，请重新出题'});
  const ruleInput=author.input;
  let projectContext:ScoreContext['project_prompt'];
  let projectRules:ScoreContext['project_rules'];
  if(legacyRules){
   if(!ruleInput||ruleInput.rule_version_id!==w.rule_version_id||typeof ruleInput.rule_source_digest!=='string'||typeof ruleInput.rule_snapshot_path!=='string'||!Array.isArray(ruleInput.rule_files)||!ruleInput.rule_files.length)throw new HTTPException(409,{message:'旧评分任务绑定的规则快照不完整'});
   if(ruleInput.rule_files.some((file:{path:string})=>!file.path.startsWith('skill/')))throw new HTTPException(409,{message:'旧题目包含非 skill 项目资料，请重新出题和审查'});
   await verifyRuleSnapshot(ruleInput.rule_snapshot_path,ruleInput.rule_files);
   projectRules={version_id:ruleInput.rule_version_id,source_digest:ruleInput.rule_source_digest,snapshot_path:ruleInput.rule_snapshot_path,files:ruleInput.rule_files};
  }else if(legacyProjectPrompt){
   if(typeof w.local_skill_path!=='string'||!w.local_skill_path)throw new HTTPException(409,{message:'项目没有配置本地 skill'});
   const snapshot=await scanProjectPrompt(dirname(w.material_root??w.local_skill_path),w.local_skill_path);
   const files=await readProjectPrompt(snapshot);
   projectContext={...snapshot,files:files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes}))};
  }
  if(!input||!result||!Array.isArray(input.materials)||!Array.isArray(input.attachments)||typeof result.text!=='string')throw new HTTPException(409,{message:'作答留存不完整'});
  const snapshot={question_version:input.question_version,question:input.question,materials:input.materials,attachments:input.attachments};
  const answer_sha256=createHash('sha256').update(result.text).digest('hex');
  if((author.id!==input.question_attempt_id&&!(Array.isArray(author.result.answer_source_attempt_ids)&&author.result.answer_source_attempt_ids.includes(input.question_attempt_id)))||question.question_version!==input.question_version||question.question!==input.question||JSON.stringify(question.attachment_ids)!==JSON.stringify(input.attachments.map((a:any)=>a.id))||inputDigest(snapshot)!==input.input_digest||result.input_digest!==input.input_digest||result.answer_sha256!==answer_sha256)throw new HTTPException(409,{message:'题目、附件或作答版本不一致'});
  const context:ScoreContext={project_name:w.project_name,question_id:w.source_key||w.title,binding:{question_version:question.question_version,input_digest:input.input_digest,rubric_version,rubric_digest:createHash('sha256').update(JSON.stringify(rubric.map((r:RubricItem)=>({id:r.id,criterion:r.criterion,max_score:r.max_score})))).digest('hex'),answer_attempt_id:attemptId,answer_sha256},question:input.question,materials:input.materials,answer:result.text,rubric:rubric.map((r:RubricItem)=>({id:r.id,criterion:r.criterion,max_score:r.max_score})),answer_approach:author.result.answer_approach,reference_answer:author.result.reference_answer,...(projectContext?{project_prompt:projectContext}:{}),...(projectRules?{project_rules:projectRules}:{})};
  return context;
 }catch(error){if(error instanceof AnswerInputError)throw new HTTPException(409,{message:error.message});throw error;}
}
export async function validateAnswerScore(pool:Pool,workflowId:string,attemptId:string,report:unknown){
 const db=await pool.connect();
 try{await db.query('BEGIN');const context=await readScoreContext(db,workflowId,attemptId);const validation=validateScore(report,context);await db.query('COMMIT');return {...validation,binding:context.binding};}
 catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
