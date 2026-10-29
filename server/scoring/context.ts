/**
 * 职责：评分上下文读取：校验题目、答案、rubric和题目冻结来源附件的一致性。
 * 关键方法与用途：`readScoreContext()` 组装匿名评分上下文；`validateAnswerScore()` 检查答案和评分绑定。
 * 使用场景：新评分任务不读取项目skill；普通评分不要求思路或标答，显式校准政策要求标答。旧任务仅兼容其冻结项目文件与规则绑定。
 */
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {authoringQuestion,matchesInputDigest,AnswerInputError} from '../answer-models/input';
import {validateScore,extractModelReport,scoreRubricSnapshot,scoreRubricBindingText,type ScoreContext} from './validate';
import {readProjectPrompt,resolveEffectiveProjectSkill,scanProjectPrompt,verifyRuleSnapshot} from '../rule-files';
import {canonicalJson,validateWorkflowConfig,type ScoringPolicy} from '../../shared/workflow-config';
import {dirname} from 'node:path';
import {readQuestionMaterials} from '../question-materials';
// Inputs come from persisted successful attempts, never from the submitted score report.
export async function readScoreContext(db:PoolClient,workflowId:string,attemptId:string,legacyRules=false,legacyProjectPrompt=false):Promise<ScoreContext>{
 try{
  const w=(await db.query("SELECT w.rule_version_id,w.title,w.source_key,p.name AS project_name,p.local_skill_path,p.material_root,p.workspace_path,p.parent_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  if(!w)throw new HTTPException(404,{message:'工作流不存在'});
  const answer=(await db.query("SELECT a.input,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=5 WHERE a.id=$1 AND a.workflow_id=$2 AND a.ordinal=5 AND a.status='succeeded' AND ((s.status='succeeded' AND ((a.id=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=a.workflow_id AND ordinal=5 AND status='succeeded' ORDER BY attempt DESC LIMIT 1)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s.result->'models','[]'::jsonb)) model WHERE model->>'attempt_id'=a.id::text AND model->>'status'='succeeded'))) OR (s.status='failed' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s.result->'models','[]'::jsonb)) model WHERE model->>'attempt_id'=a.id::text AND model->>'status'='succeeded')))",[attemptId,workflowId])).rows[0];
  const author=(await db.query("SELECT a.id,a.input,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s4 ON s4.workflow_id=a.workflow_id AND s4.ordinal=4 AND s4.status='succeeded' WHERE a.workflow_id=$1 AND a.ordinal=4 AND a.status='succeeded' ORDER BY a.attempt DESC LIMIT 1 FOR UPDATE OF s4,a",[workflowId])).rows[0];
  if(!answer||!author)throw new HTTPException(409,{message:'当前题目或作答尚未完成'});
  const question=authoringQuestion(author.result,w);const input=answer.input;const result=answer.result;
  const rubric_version=author.result.rubric_version;
  const scoring_policy=author.result.scoring_policy as ScoringPolicy|undefined;
  let rubric:ScoreContext['rubric'];
  try{
   if(scoring_policy){validateWorkflowConfig(scoring_policy);if(scoring_policy.contract!=='model_report_v1'||canonicalJson(scoring_policy)!==canonicalJson(author.input?.scoring_policy))throw new Error('评分规则冻结不一致');}
   rubric=scoreRubricSnapshot(author.result.rubric,scoring_policy);
  }catch{throw new HTTPException(409,{message:'题目评分规则缺失、无效或冻结不一致'});}
  if(typeof rubric_version!=='string'||!rubric_version.trim())throw new HTTPException(409,{message:'题目缺少有效rubric版本'});
  if(scoring_policy?.reference_answer==='calibration'&&(typeof author.result.reference_answer!=='string'||!author.result.reference_answer.trim()))throw new HTTPException(409,{message:'本次评分使用标答校准，但题目缺少标准答案'});
  const ruleInput=author.input;
  let projectContext:ScoreContext['project_prompt'];
  let projectRules:ScoreContext['project_rules'];
  if(legacyRules){
   if(!ruleInput||ruleInput.rule_version_id!==w.rule_version_id||typeof ruleInput.rule_source_digest!=='string'||typeof ruleInput.rule_snapshot_path!=='string'||!Array.isArray(ruleInput.rule_files)||!ruleInput.rule_files.length)throw new HTTPException(409,{message:'旧评分任务绑定的规则快照不完整'});
   if(ruleInput.rule_files.some((file:{path:string})=>!file.path.startsWith('skill/')))throw new HTTPException(409,{message:'旧题目包含非 skill 项目资料，请重新出题和审查'});
   projectRules={version_id:ruleInput.rule_version_id,source_digest:ruleInput.rule_source_digest,snapshot_path:ruleInput.rule_snapshot_path,files:ruleInput.rule_files};
  }else if(legacyProjectPrompt){
   const skill=await resolveEffectiveProjectSkill(w);
   const snapshot=await scanProjectPrompt(w.workspace_path??dirname(w.material_root??skill.path),skill.path);
   const files=await readProjectPrompt(snapshot);
   projectContext={...snapshot,files:files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes}))};
  }
  if(!input||!result||!Array.isArray(input.materials)||!Array.isArray(input.attachments)||typeof result.text!=='string')throw new HTTPException(409,{message:'作答留存不完整'});
  // 作答提示词参与输入绑定，但不发送给评分模型；旧尝试没有该字段时保留旧摘要。
  const snapshot={question_version:input.question_version,question:input.question,materials:input.materials,attachments:input.attachments,...(typeof input.system_prompt==='string'?{system_prompt:input.system_prompt}:{}),...(input.presentation?{presentation:input.presentation}:{}),...(input.material_origin?{material_origin:input.material_origin}:{})};
  const currentMaterials=input.material_origin?await readQuestionMaterials(db,workflowId):undefined;
  const materialOriginMatches=input.material_origin
   ?canonicalJson(currentMaterials?.origin)===canonicalJson(input.material_origin)
   :true;
  const answer_sha256=createHash('sha256').update(result.text).digest('hex');
  if(author.id!==input.question_attempt_id||JSON.stringify(question.attachment_ids)!==JSON.stringify(input.attachments.map((a:any)=>a.id)))throw new HTTPException(409,{message:'题目或附件ID不一致'});
  const materialMode=currentMaterials?.origin.kind==='library_v1'?currentMaterials.origin.material_mode:'redacted';
  const context:ScoreContext={...(typeof author.result.content_contract==='string'?{content_contract:author.result.content_contract}:{}),project_name:w.project_name,question_id:w.source_key||w.title,material_mode:materialMode,binding:{question_version:question.question_version,input_digest:input.input_digest,rubric_version,rubric_digest:createHash('sha256').update(scoreRubricBindingText(rubric,scoring_policy)).digest('hex'),answer_attempt_id:attemptId,answer_sha256},question:input.question,materials:input.materials,answer:result.text,...(input.presentation?{answer_presentation:input.presentation}:{}),rubric,...(scoring_policy?{scoring_policy}:{}),answer_approach:typeof author.result.answer_approach==='string'?author.result.answer_approach:'',reference_answer:typeof author.result.reference_answer==='string'?author.result.reference_answer:'',...(projectContext?{project_prompt:projectContext}:{}),...(projectRules?{project_rules:projectRules}:{})};
  return context;
 }catch(error){if(error instanceof AnswerInputError)throw new HTTPException(409,{message:error.message});throw error;}
}
export async function validateAnswerScore(pool:Pool,workflowId:string,attemptId:string,report:unknown){
 const db=await pool.connect();
 try{await db.query('BEGIN');const context=await readScoreContext(db,workflowId,attemptId);const validation=context.scoring_policy?.contract==='model_report_v1'?extractModelReport(typeof report==='string'?report:`<model_report>${JSON.stringify(report)}</model_report>`,context.rubric):validateScore(report,context);await db.query('COMMIT');return {...validation,binding:context.binding};}
 catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
