import type {Pool,PoolClient} from 'pg';
import {readRevisionSettings} from './revision-binding';
import {HTTPException} from 'hono/http-exception';
import {decideAcceptance,type AcceptanceConfig,type AcceptanceInput,type ModelAssessment} from './acceptance';
import {validateAcceptanceConfig,validateRevisionBudget} from './config';
import {createHash} from 'node:crypto';
import {answerModelSetDigest,readProjectModelSet} from '../answer-models/model-set';
const workflowSql='SELECT w.input_revision,w.project_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w';
export type AcceptanceSnapshot=Parameters<typeof buildAcceptanceInput>[0];
export function acceptanceSourceDigest(snapshot:AcceptanceSnapshot){
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const question=snapshot.question,q=question?.result;
 const models=snapshot.config.required_models.map(model=>{
  const answer=snapshot.answers.find(item=>item.model===model),a=answer?.result;
  const score=answer&&snapshot.scores.find(item=>item.answer_attempt_id===answer.id);
  return {model,answer:answer?{id:answer.id,status:answer.status,text:a?.text,answer_sha256:a?.answer_sha256,input_digest:a?.input_digest,input_revision:a?.input_revision,question_attempt_id:a?.question_attempt_id,question_version:a?.question_version}:null,score:score?{id:score.id,status:score.status,binding:score.result?.binding,report:score.result?.report,validation:score.result?.validation}:null};
 });
 return createHash('sha256').update(JSON.stringify(canonical({revision:snapshot.revision,config:snapshot.config,question:question?{id:question.id,status:question.status,input_revision:question.input_revision,source:question.input,question:q?.question,question_version:q?.question_version,rubric:q?.rubric,rubric_version:q?.rubric_version,attachment_ids:q?.attachment_ids,answer_requirements:q?.answer_requirements,quality_check:q?.quality_check}:null,models}))).digest('hex');
}
export async function readAcceptanceSnapshot(db:PoolClient,workflowId:string,revision:number,config:AcceptanceConfig,modelSetDigest?:string):Promise<AcceptanceSnapshot>{
 const question=await db.query("SELECT id,status,input_revision,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 ORDER BY attempt DESC LIMIT 1",[workflowId,revision]);
 const answers=await db.query("SELECT DISTINCT ON (COALESCE(input->>'model_id',config->>'model')) id,COALESCE(input->>'model_id',config->>'model') AS model,status,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input_revision=$2 AND ($3::text IS NULL OR input->>'model_set_digest'=$3) ORDER BY COALESCE(input->>'model_id',config->>'model'),attempt DESC",[workflowId,revision,modelSetDigest??null]);
 const scores=await db.query("SELECT id,input->'context'->'binding'->>'answer_attempt_id' AS answer_attempt_id,status,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input_revision=$2 ORDER BY attempt DESC",[workflowId,revision]);
 return {revision,config,question:question.rows[0],answers:answers.rows,scores:scores.rows};
}
export function buildAcceptanceInput(snapshot:{revision:number;config:AcceptanceConfig;question?:{id:string;status:string;input_revision:number;input?:any;result?:any};answers:{id:string;model:string;status:string;result?:any}[];scores:{id?:string;answer_attempt_id:string;status:string;result?:any}[]}):AcceptanceInput{
 const qualityAttempt=snapshot.question;
 const current=!!qualityAttempt&&qualityAttempt.input_revision===snapshot.revision&&!!qualityAttempt.result&&typeof qualityAttempt.result==='object';
 const report=qualityAttempt?.result?.quality_check;
 const quality:AcceptanceInput['quality']=!current?{status:'waiting'}:qualityAttempt.status==='succeeded'&&report?.passed===true?{status:'passed'}:qualityAttempt.status==='failed'&&report?.passed===false?{status:'failed',issues:Array.isArray(qualityAttempt.result?.issues)?qualityAttempt.result.issues.filter((item:unknown)=>typeof item==='string'):[]}:{status:'waiting'};
 const models:ModelAssessment[]=snapshot.config.required_models.map(model=>{
  const answer=snapshot.answers.find(item=>item.model===model);
  const score=answer&&snapshot.scores.find(item=>item.answer_attempt_id===answer.id);
  const result=score?.result;
  const binding=result?.binding;
  const report=result?.report;
  const questionResult=qualityAttempt?.result;
  const answerMatches=!!answer&&(answer.result?.question_attempt_id===qualityAttempt?.id||Array.isArray(questionResult?.answer_source_attempt_ids)&&questionResult.answer_source_attempt_ids.includes(answer.result?.question_attempt_id))&&answer.result?.question_version===questionResult?.question_version&&answer.result?.input_revision===snapshot.revision;
  const scoreMatches=answerMatches&&binding?.answer_attempt_id===answer?.id&&binding?.input_revision===snapshot.revision&&binding?.question_version===questionResult?.question_version&&binding?.rubric_version===questionResult?.rubric_version;
  return {model,answer_status:!answer?'waiting':!answerMatches?'failed':answer.status as ModelAssessment['answer_status'],score_status:!score?'waiting':score.status as ModelAssessment['score_status'],score:typeof report?.total==='number'?report.total:undefined,max_score:typeof report?.max_score==='number'?report.max_score:undefined,score_valid:result?.validation?.valid===true,binding_matches:!!scoreMatches,disputes:Array.isArray(report?.disputes)?report.disputes:undefined};
 });
 return {question_current:current,quality,config:snapshot.config,models};
}
export async function runAcceptance(pool:Pool,workflowId:string,revisionRoundId?:string){
 const db:PoolClient=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query(workflowSql,[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const settings=await readRevisionSettings(db,workflowId,workflow.input_revision,revisionRoundId);
  const modelSet:Awaited<ReturnType<typeof readProjectModelSet>>=settings?settings.model_set:await readProjectModelSet(db,workflow.project_id);
  let config:AcceptanceConfig,modelSetDigest:string|undefined;
  const configRaw=settings?settings.configs?.['7']:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  if(modelSet.length){
   config={required_models:modelSet.map(model=>model.model_id),minimum_score_by_model:Object.fromEntries(modelSet.map(model=>[model.model_id,model.minimum_score])),revision_budget:validateRevisionBudget(configRaw?.revision_budget)};
  modelSetDigest=answerModelSetDigest(modelSet);
  }else{
   if(!configRaw)throw new HTTPException(409,{message:'请先配置第七步必需模型和逐模型最低分'});
   config=validateAcceptanceConfig(configRaw);
  }
  const snapshot=await readAcceptanceSnapshot(db,workflowId,workflow.input_revision,config,modelSetDigest);
  const input={...buildAcceptanceInput(snapshot),source_digest:acceptanceSourceDigest(snapshot)};
  const result=decideAcceptance(input);
  const attemptId=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,config,input_revision,finished_at) SELECT $2,$1::uuid,7,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,$5,$6,now() FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=7",[workflowId,attemptId,JSON.stringify(input),JSON.stringify(result),JSON.stringify(config),workflow.input_revision]);
  const stepStatus=result.decision==='accepted'?'succeeded':result.decision==='waiting'?'waiting':'failed';
  await db.query("UPDATE ai_distill.steps SET implemented=true,status=$3,result=$2,error=NULL,started_at=COALESCE(started_at,now()),finished_at=now() WHERE workflow_id=$1 AND ordinal=7",[workflowId,JSON.stringify(result),stepStatus]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='达标判定已更新',finished_at=now() WHERE status='succeeded' AND workflow_revisions->>$1=$2",[workflowId,String(workflow.input_revision)]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=8",[workflowId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
  await db.query('COMMIT');
  return {id:attemptId,completed:true,...result};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
