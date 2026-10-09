import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {bindRevisionAttempt,readRevisionSettings} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {HTTPException} from 'hono/http-exception';
import {readFile,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {authoringQuestion,buildAnswerInput,inputDigest,AnswerInputError,type AnswerPackage} from './input';
import {QwenError,type QwenAnswer} from './qwen';
import {DomesticError} from './domestic';
import {resolveAnswerConfig,createAnswerClient,type ResolvedAnswerConfig} from './dispatch';
import type {AnswerRequest} from './provider';
import {answerModelSetDigest,readProjectModelSet,type RegisteredAnswerModel} from './model-set';
const activeWorkflow='SELECT w.input_revision,w.project_id FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) FOR UPDATE OF w';
async function currentQuestion(db:PoolClient,id:string,revision:number){
 try {
  const row=(await db.query("SELECT a.id,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=4 WHERE a.workflow_id=$1 AND a.ordinal=4 AND a.input_revision=$2 AND a.status='succeeded' AND s.status='succeeded' ORDER BY a.attempt DESC LIMIT 1 FOR UPDATE OF s,a",[id,revision])).rows[0];
  if(!row)throw new AnswerInputError('出题与质检尚未完成');
  return {...authoringQuestion(row.result,revision),question_attempt_id:row.id};
 }catch(error){throw error;}
}
export async function readAnswerAttachment(root:string,artifact:{storage_path:string;sha256:string;content?:string|null}){
 try{
  if(typeof artifact.content==='string'){
   if(Buffer.byteLength(artifact.content)>24_000_000||createHash('sha256').update(artifact.content).digest('hex')!==artifact.sha256)throw new AnswerInputError('脱敏附件指纹不一致，不能作答');
   return artifact.content;
  }
  const base=await realpath(resolve(root));const path=await realpath(resolve(base,artifact.storage_path));const rel=relative(base,path);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new AnswerInputError();
  const bytes=await readFile(path);
  if(bytes.length>24_000_000||createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw new AnswerInputError('脱敏附件指纹不一致，不能作答');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 }catch(error){if(error instanceof AnswerInputError)throw error;throw new AnswerInputError('脱敏附件无法读取，不能作答');}
}
export async function enqueueAnswer(pool:Pool,id:string,root:string,revisionRoundId?:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query(activeWorkflow,[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const question=await currentQuestion(db,id,workflow.input_revision);
  const artifacts=await db.query("SELECT ar.id,ar.kind,ar.sha256,ar.storage_path,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND a.input_revision=$3 AND s.status='succeeded'",[id,question.attachment_ids,workflow.input_revision]);
  const sources=[];for(const artifact of artifacts.rows)sources.push({...artifact,text:await readAnswerAttachment(root,artifact)});
  const input=buildAnswerInput({...question,quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}},workflow.input_revision,sources);
  const snapshot={...input,question_attempt_id:question.question_attempt_id,input_digest:inputDigest(input)};
  const settings=await readRevisionSettings(db,id,workflow.input_revision,revisionRoundId);
  const overrides=settings?settings.configs?.['5']??{}:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=5',[workflow.project_id])).rows[0]?.config??{};
  const selected=settings?settings.model_set:await readProjectModelSet(db,workflow.project_id);const hasModelSet=selected.length>0;
  const models:RegisteredAnswerModel[]=selected.length?selected:[{model_id:'',name:'',minimum_score:0,config:resolveAnswerConfig(overrides)}];
  const modelSetDigest=answerModelSetDigest(models);
  const modelSet=models.map(({model_id,name,minimum_score,config})=>({model_id,name,minimum_score,config}));
  const queued:{id:string;reused:boolean}[]=[];
  for(const model of models){
   const input={...snapshot,model_id:model.model_id||null,model_name:model.name||null,...(hasModelSet?{model_set_digest:modelSetDigest,model_set:modelSet}:{})};
   // Workflow row lock serializes a whole model-set enqueue. Each model is deduplicated independently.
   const previous=await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input_revision=$2 AND input->>'question_attempt_id'=$3 AND input->>'input_digest'=$4 AND input->>'model_id' IS NOT DISTINCT FROM $5 AND config=$6::jsonb AND (($7::boolean AND input->>'model_set_digest'=$8) OR (NOT $7::boolean AND input->>'model_set_digest' IS NULL)) AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,workflow.input_revision,question.question_attempt_id,snapshot.input_digest,model.model_id||null,JSON.stringify(model.config),hasModelSet,modelSetDigest]);
   if(previous.rowCount){queued.push({id:previous.rows[0].id,reused:true});continue;}
   const attempt=crypto.randomUUID();
   await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision) SELECT $2,$1::uuid,5,COALESCE(max(attempt),0)+1,'waiting',$3,$4,$5 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=5",[id,attempt,JSON.stringify(input),JSON.stringify(model.config),workflow.input_revision]);
   await bindRevisionAttempt(db,id,workflow.input_revision,attempt,revisionRoundId);
   queued.push({id:attempt,reused:false});
  }
  const existingQueued=await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input_revision=$2 AND status IN ('waiting','running') AND input->>'model_set_digest' IS DISTINCT FROM $3 AND id<>ALL($4::uuid[]) LIMIT 1",[id,workflow.input_revision,modelSetDigest,queued.map(item=>item.id)]);
  if(existingQueued.rowCount)throw new HTTPException(409,{message:'另一组模型仍在作答，请等待完成后再修改项目模型集合'});
  const allReused=queued.every(item=>item.reused);
  if(allReused){await db.query('COMMIT');return hasModelSet?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:true}:{id:queued[0]!.id,reused:true};}
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=5",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>5 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='作答更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>5 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');return hasModelSet?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:false}:{id:queued[0]!.id,reused:false};
 }catch(error){await db.query('ROLLBACK');if(error instanceof AnswerInputError)throw new HTTPException(409,{message:error.message});if((error instanceof QwenError||error instanceof DomesticError))throw new HTTPException(400,{message:error.message});throw error;}finally{db.release();}
}
async function matchesQuestion(db:PoolClient,job:any){
 try{
  const current=await currentQuestion(db,job.workflow_id,job.input_revision);
  return current.question_attempt_id===job.input.question_attempt_id&&current.question_version===job.input.question_version&&current.question===job.input.question&&JSON.stringify(current.attachment_ids)===JSON.stringify(job.input.attachments.map((a:any)=>a.id));
 }catch(error){if(error instanceof AnswerInputError)return false;throw error;}
}
async function matchesModelSet(db:PoolClient,job:any){
 if(!Array.isArray(job.input.model_set)||!job.input.model_set.length)return true;
 const current=await readProjectModelSet(db,job.project_id);
 const digest=answerModelSetDigest(current);
 return digest===job.input.model_set_digest;
}
async function refreshAnswerStep(db:PoolClient,job:any){
 if(!Array.isArray(job.input.model_set)||!job.input.model_set.length){
  const latest=await db.query("UPDATE ai_distill.steps SET status=$3,result=$4,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=5 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1 AND input_revision=$2)",[job.workflow_id,job.input_revision,job.status==='succeeded'?'succeeded':'failed',JSON.stringify(job.result)]);
  return latest.rowCount;
 }
 const rows=await db.query("SELECT id,input,result,status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input_revision=$2 AND input->>'model_set_digest'=$3 ORDER BY attempt DESC",[job.workflow_id,job.input_revision,job.input.model_set_digest]);
 const latest=new Map<string,any>();
 for(const row of rows.rows){const id=row.input?.model_id;if(typeof id==='string'&&id&&!latest.has(id))latest.set(id,row);}
 const models=job.input.model_set.map((model:any)=>{const row=latest.get(model.model_id);return {model_id:model.model_id,name:model.name,minimum_score:model.minimum_score,attempt_id:row?.id??null,status:row?.status??'waiting',answer_sha256:row?.result?.answer_sha256??null,answer:row?.status==='succeeded'?row.result.text:null};});
 const settled=models.every((model:any)=>['succeeded','failed','skipped'].includes(model.status));
 const active=models.some((model:any)=>model.status==='running');
 const status=settled?'succeeded':active?'running':'waiting';
 const result={model_set_digest:job.input.model_set_digest,models};
 return (await db.query('UPDATE ai_distill.steps SET status=$3,result=$4,error=NULL,finished_at=CASE WHEN $3=\'succeeded\' THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=5 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1 AND input_revision=$2)',[job.workflow_id,job.input_revision,status,JSON.stringify(result)])).rowCount;
}
export async function runNextAnswer(pool:Pool,root:string,answer:(input:AnswerRequest<ResolvedAnswerConfig>)=>Promise<QwenAnswer>=createAnswerClient().answer,signal?:AbortSignal){
 const db=await pool.connect();let job:any;
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.input_revision FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=5 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){
   await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='作答进程中断，可重试',finished_at=now() WHERE id=$1",[row.id]);
   await db.query("UPDATE ai_distill.steps SET status='failed',error='作答进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=5 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.input_revision=$2)",[row.workflow_id,row.input_revision]);
  }
  job=(await db.query("SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=5 AND a.status='waiting' AND (a.revision_round_id IS NULL OR NOT EXISTS(SELECT 1 FROM ai_distill.step_attempts active WHERE active.workflow_id=a.workflow_id AND active.revision_round_id IS NOT NULL AND active.status='running')) ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);
  await db.query("UPDATE ai_distill.steps SET status='running',started_at=now(),error=NULL WHERE workflow_id=$1 AND ordinal=5",[job.workflow_id]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 const heartbeat=setInterval(()=>{pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>console.error('作答任务心跳写入失败'));},10000);
 let wrote=false;
 try{
  // Validate the stored snapshot before dispatch, then check current source again at publication.
  const packaged:AnswerPackage={question_version:job.input.question_version,input_revision:job.input.input_revision,question:job.input.question,materials:job.input.materials,attachments:job.input.attachments};
  if(inputDigest(packaged)!==job.input.input_digest||packaged.input_revision!==job.input_revision)throw new AnswerInputError();
  const before=await pool.connect();try{await before.query('BEGIN');const w=(await before.query(activeWorkflow,[job.workflow_id])).rows[0];if(w?.input_revision!==job.input_revision||!await matchesQuestion(before,job)||!await matchesModelSet(before,job))throw new AnswerInputError('题目或项目模型配置已变化');await before.query('COMMIT');}catch(error){await before.query('ROLLBACK');throw error;}finally{before.release();}
  const result=await runRevisionCall(pool,job.id,'answer',remaining=>answer({config:resolveAnswerConfig(job.config),question:packaged.question,materials:packaged.materials,signal,timeout_ms:Math.min(120000,remaining??120000)}));
  const directory=join(resolve(root),job.workflow_id,job.id);await mkdir(directory,{recursive:true});
  const bytes=Buffer.from(result.text);const path=join(directory,'answer.txt');wrote=true;await writeFile(path,bytes);
  const answer_sha256=createHash('sha256').update(bytes).digest('hex');
  const publication={...result,provider:job.config.provider??'qwen',mode:job.config.enable_thinking===undefined?'provider_default':job.config.enable_thinking?'thinking_enabled':'thinking_disabled',model_id:job.input.model_id??null,model_name:job.input.model_name??null,answer_sha256,input_digest:job.input.input_digest,question_version:job.input.question_version,question_attempt_id:job.input.question_attempt_id,input_revision:job.input_revision,tools:[],output_mode:'text',execution_steps:null};
  const tx=await pool.connect();
  try{
   await tx.query('BEGIN');
   const w=(await tx.query(activeWorkflow,[job.workflow_id])).rows[0];
   const active=await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id]);
   if(w?.input_revision!==job.input_revision||!active.rowCount||!await matchesQuestion(tx,job)||!await matchesModelSet(tx,job))throw new AnswerInputError('题目或项目模型配置已变化，答案未发布');
   await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),job.workflow_id,job.id,'model_answer',relative(resolve(root),path),answer_sha256,bytes.length]);
   await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(publication)]);
   job.status='succeeded';job.result=publication;await refreshAnswerStep(tx,job);
   await tx.query('COMMIT');
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  if(wrote)try{const published=await pool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1',[job.id]);if(!published.rowCount)await rm(join(resolve(root),job.workflow_id,job.id),{recursive:true,force:true});}catch{console.error('无法确认答案发布状态，保留文件等待核对');}
  const message=error instanceof QwenError||error instanceof DomesticError||error instanceof AnswerInputError?error.message:'模型作答失败，请检查服务配置或存储状态';
  const result=error instanceof QwenError||error instanceof DomesticError?{error:{kind:error.kind,retryable:error.retryable,http_status:error.http_status,provider_code:error.provider_code,request_id:error.request_id}}:null;
  const tx=await pool.connect();try{
   await tx.query('BEGIN');const w=(await tx.query(activeWorkflow,[job.workflow_id])).rows[0];
   const failed=await tx.query("UPDATE ai_distill.step_attempts SET status='failed',error=$2,result=$3,finished_at=now() WHERE id=$1 AND status='running'",[job.id,message,JSON.stringify(result)]);
   if(failed.rowCount&&w?.input_revision===job.input_revision&&await matchesQuestion(tx,job)){job.status='failed';job.result=result;await refreshAnswerStep(tx,job);}
   await tx.query('COMMIT');
  }catch(failure){await tx.query('ROLLBACK');throw failure;}finally{tx.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);}
 return true;
}
