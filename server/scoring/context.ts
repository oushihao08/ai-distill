import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {authoringQuestion,inputDigest,AnswerInputError} from '../answer-models/input';
import {validateScore,type ScoreContext,type RubricItem} from './validate';
// Inputs come from persisted successful attempts, never from the submitted score report.
export async function readScoreContext(db:PoolClient,workflowId:string,attemptId:string):Promise<ScoreContext>{
 try{
  const w=(await db.query('SELECT w.input_revision FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) FOR UPDATE OF w',[workflowId])).rows[0];
  if(!w)throw new HTTPException(404,{message:'工作流不存在'});
  const answer=(await db.query("SELECT a.input,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=5 WHERE a.id=$1 AND a.workflow_id=$2 AND a.ordinal=5 AND a.status='succeeded' AND a.input_revision=$3 AND s.status='succeeded' AND ((s.result->>'answer_sha256'=a.result->>'answer_sha256' AND s.result->>'input_digest'=a.result->>'input_digest') OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s.result->'models','[]'::jsonb)) model WHERE model->>'attempt_id'=a.id::text AND model->>'answer_sha256'=a.result->>'answer_sha256'))",[attemptId,workflowId,w.input_revision])).rows[0];
  const author=(await db.query("SELECT a.id,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=4 WHERE a.workflow_id=$1 AND a.ordinal=4 AND a.input_revision=$2 AND a.status='succeeded' AND s.status='succeeded' ORDER BY a.attempt DESC LIMIT 1 FOR UPDATE OF s,a",[workflowId,w.input_revision])).rows[0];
  if(!answer||!author)throw new HTTPException(409,{message:'当前题目或作答尚未完成，不能校验评分'});
  const question=authoringQuestion(author.result,w.input_revision);const input=answer.input;const result=answer.result;
  const rubric=author.result.rubric;const rubric_version=author.result.rubric_version;
  if(typeof rubric_version!=='string'||!rubric_version.trim()||!Array.isArray(rubric)||!rubric.length||rubric.some((r:any)=>!r||typeof r.id!=='string'||typeof r.criterion!=='string'||typeof r.max_score!=='number'))throw new HTTPException(409,{message:'题目缺少有效rubric版本或条目'});
  if(!input||!result||!Array.isArray(input.materials)||!Array.isArray(input.attachments)||typeof result.text!=='string')throw new HTTPException(409,{message:'作答留存不完整'});
  const snapshot={question_version:input.question_version,input_revision:input.input_revision,question:input.question,materials:input.materials,attachments:input.attachments};
  const answer_sha256=createHash('sha256').update(result.text).digest('hex');
  if((author.id!==input.question_attempt_id&&!(Array.isArray(author.result.answer_source_attempt_ids)&&author.result.answer_source_attempt_ids.includes(input.question_attempt_id)))||question.question_version!==input.question_version||question.question!==input.question||JSON.stringify(question.attachment_ids)!==JSON.stringify(input.attachments.map((a:any)=>a.id))||inputDigest(snapshot)!==input.input_digest||input.input_revision!==w.input_revision||result.input_digest!==input.input_digest||result.answer_sha256!==answer_sha256)throw new HTTPException(409,{message:'题目、附件或作答版本不一致'});
  const context:ScoreContext={binding:{question_version:question.question_version,input_revision:w.input_revision,input_digest:input.input_digest,rubric_version,rubric_digest:createHash('sha256').update(JSON.stringify(rubric.map((r:RubricItem)=>({id:r.id,criterion:r.criterion,max_score:r.max_score})))).digest('hex'),answer_attempt_id:attemptId,answer_sha256},question:input.question,materials:input.materials,answer:result.text,rubric:rubric.map((r:RubricItem)=>({id:r.id,criterion:r.criterion,max_score:r.max_score}))};
  return context;
 }catch(error){if(error instanceof AnswerInputError)throw new HTTPException(409,{message:error.message});throw error;}
}
export async function validateAnswerScore(pool:Pool,workflowId:string,attemptId:string,report:unknown){
 const db=await pool.connect();
 try{await db.query('BEGIN');const context=await readScoreContext(db,workflowId,attemptId);const validation=validateScore(report,context);await db.query('COMMIT');return {...validation,binding:context.binding};}
 catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

