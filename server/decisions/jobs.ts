/**
 * 职责：达标事务服务：读取当前题目和模型评分快照，计算依据指纹并保存第七阶段决策。
 * 关键方法与用途：`readAcceptanceSnapshot()` 读取当前版本证据；`buildAcceptanceInput()` 组装纯决策输入；`runAcceptance()` 锁定并保存第七阶段结果；指纹函数固定来源。
 * 使用场景：由 `app.ts` 手动派发或 `revision-runner.ts` 接续调用。
 */
import type {Pool,PoolClient} from 'pg';
import {readRevisionSettings} from './revision-binding';
import {HTTPException} from 'hono/http-exception';
import {decideAcceptance,type AcceptanceConfig,type AcceptanceInput,type ModelAssessment} from './acceptance';
import {validateAcceptanceConfig,validateRevisionBudget} from './config';
import {createHash} from 'node:crypto';
import {answerModelSetDigest,readProjectModelSet} from '../answer-models/model-set';
import {classifyLogError,enterLogContext,logEvent} from '../logging';
const workflowSql="SELECT w.project_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w";
export type AcceptanceSnapshot=Parameters<typeof buildAcceptanceInput>[0];
export function acceptanceSourceDigest(snapshot:AcceptanceSnapshot){
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const question=snapshot.question,q=question?.result;
 const models=snapshot.config.required_models.map(model=>{
  const answer=snapshot.answers.find(item=>item.model===model),a=answer?.result;
  const score=answer&&snapshot.scores.find(item=>item.answer_attempt_id===answer.id);
  return {model,answer:answer?{id:answer.id,status:answer.status,text:a?.text,answer_sha256:a?.answer_sha256,input_digest:a?.input_digest,question_attempt_id:a?.question_attempt_id,question_version:a?.question_version}:null,score:score?{id:score.id,status:score.status,binding:score.result?.binding,report:score.result?.report,validation:score.result?.validation}:null};
 });
 // 判定口径变化后旧达标摘要失效，发布时必须按百分制重新判定。
 return createHash('sha256').update(JSON.stringify(canonical({acceptance_policy:'percentage_strict_below',config:snapshot.config,question:question?{id:question.id,status:question.status,source:question.input,question:q?.question,question_version:q?.question_version,rubric:q?.rubric,rubric_version:q?.rubric_version,attachment_ids:q?.attachment_ids,answer_requirements:q?.answer_requirements}:null,models}))).digest('hex');
}
export async function readAcceptanceSnapshot(db:PoolClient,workflowId:string,config:AcceptanceConfig,modelSetDigest?:string):Promise<AcceptanceSnapshot>{
 const question=await db.query("SELECT a.id,a.status,a.input,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s4 ON s4.workflow_id=a.workflow_id AND s4.ordinal=4 WHERE a.workflow_id=$1 AND a.ordinal=4 ORDER BY a.attempt DESC LIMIT 1",[workflowId]);
 const answers=await db.query("SELECT DISTINCT ON (COALESCE(input->>'model_id',config->>'model')) id,COALESCE(input->>'model_id',config->>'model') AS model,status,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND ($2::text IS NULL OR input->>'model_set_digest'=$2) ORDER BY COALESCE(input->>'model_id',config->>'model'),attempt DESC",[workflowId,modelSetDigest??null]);
 const scores=await db.query("SELECT id,input->'context'->'binding'->>'answer_attempt_id' AS answer_attempt_id,input->'context'->'binding' AS input_binding,status,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 ORDER BY attempt DESC",[workflowId]);
 return {config,question:question.rows[0],answers:answers.rows,scores:scores.rows};
}
export function buildAcceptanceInput(snapshot:{config:AcceptanceConfig;question?:{id:string;status:string;input?:any;result?:any};answers:{id:string;model:string;status:string;result?:any}[];scores:{id?:string;answer_attempt_id:string;input_binding?:any;status:string;result?:any}[]}):AcceptanceInput{
 const questionAttempt=snapshot.question;
 const current=questionAttempt?.status==='succeeded'&&!!questionAttempt.result&&typeof questionAttempt.result==='object';
 const models:ModelAssessment[]=snapshot.config.required_models.map(model=>{
  const answer=snapshot.answers.find(item=>item.model===model);
  const score=answer&&snapshot.scores.find(item=>item.answer_attempt_id===answer.id);
  const result=score?.result;
  const report=result?.report;
  const questionResult=questionAttempt?.result;
  const answerMatches=!!answer&&(answer.result?.question_attempt_id===questionAttempt?.id||Array.isArray(questionResult?.answer_source_attempt_ids)&&questionResult.answer_source_attempt_ids.includes(answer.result?.question_attempt_id))&&answer.result?.question_version===questionResult?.question_version;
  const binding=result?.binding??score?.input_binding;
  const rubricDigest=createHash('sha256').update(JSON.stringify((questionResult?.rubric??[]).map((item:any)=>({id:item.id,criterion:item.criterion,max_score:item.max_score})))).digest('hex');
  const scoreMatches=!!answerMatches&&!!score&&binding?.answer_attempt_id===answer.id&&binding?.question_version===questionResult?.question_version&&binding?.rubric_version===questionResult?.rubric_version&&binding?.input_digest===answer.result?.input_digest&&binding?.answer_sha256===answer.result?.answer_sha256&&binding?.rubric_digest===rubricDigest&&answer.result?.answer_sha256===createHash('sha256').update(answer.result?.text??'').digest('hex');
  return {model,answer_status:!answer?'waiting':!answerMatches?'failed':answer.status as ModelAssessment['answer_status'],score_status:score?.status as ModelAssessment['score_status'],score_valid:scoreMatches&&result?.validation?.valid===true,score:typeof report?.total==='number'?report.total:undefined,max_score:typeof report?.max_score==='number'?report.max_score:undefined};
 });
 return {question_current:current,config:snapshot.config,models};
}
/** Freeze per-model attempt references with each acceptance result for later evidence-backed revision. */
export function buildEvaluationRecordRefs(snapshot:AcceptanceSnapshot,modelScores:Record<string,any>){
 const questionAttempt=snapshot.question,question=questionAttempt?.result;
 return snapshot.config.required_models.map(model=>{
  const answer=snapshot.answers.find(item=>item.model===model);
  const score=answer&&snapshot.scores.find(item=>item.answer_attempt_id===answer.id);
  const result=modelScores[model];
  return {
   model_id:model,
   status:result?.status??'pending',
   ...(answer?{answer_attempt_id:answer.id}:{}),
   ...(score?.id?{score_attempt_id:score.id}:{}),
   ...(questionAttempt?.id?{question_attempt_id:questionAttempt.id}:{}),
   ...(typeof question?.question_version==='string'?{question_version:question.question_version}:{}),
   ...(typeof question?.rubric_version==='string'?{rubric_version:question.rubric_version}:{}),
   ...(typeof answer?.result?.answer_sha256==='string'?{answer_sha256:answer.result.answer_sha256}:{}),
   ...(typeof score?.result?.raw_text==='string'?{score_sha256:createHash('sha256').update(score.result.raw_text).digest('hex')}:{}),
  };
 });
}
/**
 * 读取当前题面、模型集合、答案与评分分数，按逐模型门槛计算达标、等待或返修结果并持久化。
 * 输入摘要绑定本次决策依据；返修链调用时使用该轮冻结配置，普通派发使用当前项目配置。
 */
export async function runAcceptance(pool:Pool,workflowId:string,revisionRoundId?:string){
 const db:PoolClient=await pool.connect();let restoreLogContext=()=>{};
 try{
  await db.query('BEGIN');
  const workflow=(await db.query(workflowSql,[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  restoreLogContext=enterLogContext({component:'acceptance',workflow_id:workflowId,project_id:workflow.project_id,ordinal:7,operation:'acceptance'});
  const settings=await readRevisionSettings(db,workflowId,revisionRoundId);
  const modelSet:Awaited<ReturnType<typeof readProjectModelSet>>=settings?settings.model_set:await readProjectModelSet(db,workflow.project_id);
  let config:AcceptanceConfig,modelSetDigest:string|undefined;
  const configRaw=settings?settings.configs?.['7']:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  if(modelSet.length){
   config={required_models:modelSet.map(model=>model.model_id),minimum_score_by_model:Object.fromEntries(modelSet.map(model=>[model.model_id,model.minimum_score])),revision_budget:validateRevisionBudget(configRaw?.revision_budget)};
  modelSetDigest=answerModelSetDigest(modelSet);
  }else{
   if(!configRaw?.required_models||!configRaw?.minimum_score_by_model)throw new HTTPException(409,{message:'请先在项目作答模型中选择模型并设置各自的百分制分数上限'});
   config=validateAcceptanceConfig(configRaw);
  }
  const snapshot=await readAcceptanceSnapshot(db,workflowId,config,modelSetDigest);
  const input={...buildAcceptanceInput(snapshot),source_digest:acceptanceSourceDigest(snapshot)};
  const decision=decideAcceptance(input);
  const result={...decision,evaluation_records:buildEvaluationRecordRefs(snapshot,decision.model_scores??{})};
  const attemptId=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,config,finished_at) SELECT $2,$1::uuid,7,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,$5,now() FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=7",[workflowId,attemptId,JSON.stringify(input),JSON.stringify(result),JSON.stringify(config)]);
  // A repair decision is a successful completion of this step; the business outcome lives in result.decision.
  const stepStatus=result.decision==='waiting'?'waiting':'succeeded';
  await db.query("UPDATE ai_distill.steps SET implemented=true,status=$3,result=$2,error=NULL,started_at=COALESCE(started_at,now()),finished_at=now() WHERE workflow_id=$1 AND ordinal=7",[workflowId,JSON.stringify(result),stepStatus]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='达标判定已更新',finished_at=now() WHERE status IN ('running','succeeded') AND project_id=(SELECT project_id FROM ai_distill.workflows WHERE id=$1)",[workflowId]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=8",[workflowId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
  await db.query('COMMIT');
  logEvent('acceptance.completed',{level:result.decision==='accepted'?'info':'warn',state:result.decision,attempt_id:attemptId});
  return {id:attemptId,completed:true,...result};
 }catch(error){logEvent('acceptance.failed',{level:'error',...classifyLogError(error)});await db.query('ROLLBACK');throw error;}finally{restoreLogContext();db.release();}
}
