/**
 * 职责：达标题目归档事务：重新验证当前达标依据与产物指纹，并仅将归档状态写入数据库。
 * 关键方法与用途：`publishWorkflow()` 在事务中复核当前达标版本和产物指纹，记录数据库归档标记。
 * 使用场景：由 `app.ts` 发布接口调用；重复发布复用已有结果。
 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {acceptanceSourceDigest,readAcceptanceSnapshot,buildAcceptanceInput} from '../decisions/jobs';
import {decideAcceptance} from '../decisions/acceptance';
import {answerModelSetDigest,readProjectModelSet} from '../answer-models/model-set';
import {verifyFrozenProjectPrompt} from '../rule-files';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
interface Artifact {id:string;attempt_id:string;kind:string;storage_path:string;sha256:string;content?:string|null}
async function verifyArtifact(root:string,artifact:Artifact){
 if(typeof artifact.content==='string'){if(hash(artifact.content)!==artifact.sha256)throw new HTTPException(409,{message:'成果内容指纹变化，不能归档'});return;}
 if(!artifact||isAbsolute(artifact.storage_path))throw new HTTPException(409,{message:'成果文件索引无效'});
 try{
  const base=await realpath(resolve(root)),path=await realpath(join(base,artifact.storage_path));
  if(!path.startsWith(`${base}/`))throw new Error('unsafe artifact');
  const info=await stat(path);if(!info.isFile()||info.size>30*1024*1024)throw new Error('invalid artifact');
  const bytes=await readFile(path);if(hash(bytes)!==artifact.sha256)throw new Error('changed artifact');
 }catch{throw new HTTPException(409,{message:'成果文件缺失、越界或指纹变化，不能归档'});}
}

/**
 * 归档前重新验证当前版本已通过出题、作答、评分和达标，并逐一核对产物指纹及附件绑定。
 * 相同达标摘要复用已归档标记；归档信息只写入步骤与尝试记录，不生成额外成果文件。
 */
export async function publishWorkflow(pool:Pool,workflowId:string,root:string){
 const db=await pool.connect();let attemptId:string|undefined;let restoreLogContext=()=>{};
 try{
  await db.query('BEGIN');
  const workflow=(await db.query("SELECT w.project_id,w.title FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  restoreLogContext=enterLogContext({component:'publishing',operation:'publish',workflow_id:workflowId,project_id:workflow.project_id,ordinal:8});
  logEvent('publication.started',{level:'info'});
  const steps=await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 7',[workflowId]);
  if(steps.rows.length!==4||steps.rows.some(row=>row.status!=='succeeded'))throw new HTTPException(409,{message:'当前出题、作答、评分及达标尚未全部成功'});
  const modelSet=await readProjectModelSet(db,workflow.project_id);
  if(!modelSet.length)throw new HTTPException(409,{message:'项目尚未配置作答模型'});
  const config={required_models:modelSet.map(model=>model.model_id),minimum_score_by_model:Object.fromEntries(modelSet.map(model=>[model.model_id,model.minimum_score]))};
  const accepted=(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
  if(accepted?.status!=='succeeded'||accepted.result?.decision!=='accepted')throw new HTTPException(409,{message:'当前版本尚未达标'});
  const snapshot=await readAcceptanceSnapshot(db,workflowId,config,answerModelSetDigest(modelSet));
  const digest=acceptanceSourceDigest(snapshot),q=snapshot.question?.result;
  await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
  if(accepted.input?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(snapshot)).decision!=='accepted')throw new HTTPException(409,{message:'达标依据已变化，请重新执行第七步'});
  if(!q||!q.question?.trim()||!q.question_version||!q.rubric_version||!Array.isArray(q.rubric)||!q.rubric.length)throw new HTTPException(409,{message:'题目包不完整'});
  const models=config.required_models.map(model=>{
   const answer=snapshot.answers.find(item=>item.model===model)!;
   const score=snapshot.scores.find(item=>item.answer_attempt_id===answer.id)!;
   const binding=score.result?.binding;
   if(typeof answer.result?.text!=='string'||hash(answer.result.text)!==answer.result.answer_sha256||binding?.answer_sha256!==answer.result.answer_sha256||binding?.answer_attempt_id!==answer.id||binding?.question_version!==q.question_version||binding?.rubric_version!==q.rubric_version||binding?.input_digest!==answer.result.input_digest||!score.id)throw new HTTPException(409,{message:'答案或评分版本指纹不一致'});
   return {model,answer_attempt_id:answer.id,answer_sha256:answer.result.answer_sha256,score_attempt_id:score.id};
  });
  const attemptIds=[snapshot.question!.id,...models.flatMap(item=>[item.answer_attempt_id,item.score_attempt_id])];
  const artifacts=(await db.query("SELECT id,attempt_id,kind,storage_path,sha256,content FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=ANY($2::uuid[]) AND kind IN ('authored_question','model_answer','score_report')",[workflowId,attemptIds])).rows as Artifact[];
  const required=[{attempt_id:snapshot.question!.id,kind:'authored_question'},...models.flatMap(item=>[{attempt_id:item.answer_attempt_id,kind:'model_answer'},{attempt_id:item.score_attempt_id,kind:'score_report'}])];
  for(const item of required){const matching=artifacts.filter(file=>file.attempt_id===item.attempt_id&&file.kind===item.kind);if(matching.length!==1)throw new HTTPException(409,{message:'当前题目、答案或评分缺少唯一产物'});await verifyArtifact(root,matching[0]!);}
  const frozen=snapshot.question!.input;
  if(!Array.isArray(q.attachment_ids)||!q.attachment_ids.length||!Array.isArray(frozen?.materials))throw new HTTPException(409,{message:'出题附件快照不完整'});
  const attachments=(await db.query("SELECT ar.id,ar.attempt_id,ar.kind,ar.storage_path,ar.sha256,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=ar.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND s.status='succeeded'",[workflowId,q.attachment_ids])).rows as Artifact[];
  for(const id of q.attachment_ids){const matching=attachments.filter(file=>file.id===id);if(matching.length!==1||!frozen.materials.some((item:any)=>item.id===id&&item.sha256===matching[0]!.sha256)||matching[0]!.attempt_id!==frozen.redaction_attempt_id)throw new HTTPException(409,{message:'当前脱敏附件与出题快照不一致'});await verifyArtifact(root,matching[0]!);}
  const previous=(await db.query("SELECT id,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' AND input->>'source_digest'=$2 AND input->>'acceptance_attempt_id'=$3 ORDER BY attempt DESC LIMIT 1",[workflowId,digest,accepted.id])).rows[0];
  if(previous){
   await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
   await db.query('COMMIT');withLogContext({attempt_id:previous.id},()=>logEvent('publication.reused',{level:'info',state:'succeeded'}));return {id:previous.id,reused:true,completed:true};
  }
  attemptId=crypto.randomUUID();
  const result={source_digest:digest,acceptance_attempt_id:accepted.id,question_version:q.question_version,rubric_version:q.rubric_version,archived_at:new Date().toISOString()};
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,finished_at) SELECT $2,$1::uuid,8,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,now() FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=8",[workflowId,attemptId,JSON.stringify({source_digest:digest,acceptance_attempt_id:accepted.id}),JSON.stringify(result)]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=now(),finished_at=now() WHERE workflow_id=$1 AND ordinal=8",[workflowId,JSON.stringify(result)]);
  await db.query("UPDATE ai_distill.workflows SET status='succeeded' WHERE id=$1",[workflowId]);
  await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
  await db.query('COMMIT');withLogContext({attempt_id:attemptId},()=>logEvent('publication.completed',{level:'info',state:'succeeded'}));return {id:attemptId,reused:false,completed:true};
 }catch(error){
  logEvent('publication.failed',{level:'error',state:'failed',...classifyLogError(error)});
  try{await db.query('ROLLBACK');}catch(rollbackError){logEvent('transaction.rollback_failed',{level:'error',transaction_name:'rollback:publishing',...classifyLogError(rollbackError)});console.error('成果发布事务回滚失败，等待核对');}
  throw error;
 }finally{restoreLogContext();db.release();}
}
