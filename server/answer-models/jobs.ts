/**
 * 职责：模型作答队列：冻结题目与脱敏附件，为模型集合派发任务并按当前版本聚合答案状态。
 * 关键方法与用途：`readAnswerAttachment()` 校验并读取脱敏附件；`enqueueAnswer()` 冻结并创建尝试；`runNextAnswer()` 领取、调用供应商并保存结果。
 * 使用场景：`app.ts` 接收用户派发，`worker.ts` 持续调用消费入口。
 */
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {bindRevisionAttempt,readRevisionSettings} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {HTTPException} from 'hono/http-exception';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {authoringQuestion,buildAnswerInput,inputDigest,AnswerInputError,type AnswerPackage} from './input';
import {QwenError,type QwenAnswer} from './qwen';
import {DomesticError} from './domestic';
import {resolveAnswerConfig,createAnswerClient,type ResolvedAnswerConfig} from './dispatch';
import type {AnswerRequest} from './provider';
import {answerModelSetDigest,readProjectModelSet,type RegisteredAnswerModel} from './model-set';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
const activeWorkflow="SELECT w.project_id FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) FOR UPDATE OF w";
async function currentQuestion(db:PoolClient,id:string){
 try {
  const row=(await db.query("SELECT a.id,a.result FROM ai_distill.step_attempts a JOIN ai_distill.steps s4 ON s4.workflow_id=a.workflow_id AND s4.ordinal=4 AND s4.status='succeeded' WHERE a.workflow_id=$1 AND a.ordinal=4 AND a.status='succeeded' ORDER BY a.attempt DESC LIMIT 1 FOR UPDATE OF s4,a",[id])).rows[0];
  if(!row)throw new AnswerInputError('当前题目尚未出题成功');
  return {...authoringQuestion(row.result),question_attempt_id:row.id};
 }catch(error){throw error;}
}
export async function readAnswerAttachment(_root:string,artifact:{storage_path?:string;sha256:string;content?:string|null}){
 try{
  if(typeof artifact.content!=='string')throw new AnswerInputError('数据库中没有脱敏附件正文，不能作答');
  if(Buffer.byteLength(artifact.content)>24_000_000||createHash('sha256').update(artifact.content).digest('hex')!==artifact.sha256)throw new AnswerInputError('脱敏附件指纹不一致，不能作答');
  return artifact.content;
 }catch(error){if(error instanceof AnswerInputError)throw error;throw new AnswerInputError('脱敏附件无法读取，不能作答');}
}
/**
 * 只为当前成功题面和获准脱敏附件创建作答尝试，并冻结题目、材料及模型集合配置。
 * 按模型分别去重和排队；作答输入不包含 rubric、标答或目标分数。
 */
export async function enqueueAnswer(pool:Pool,id:string,root:string,revisionRoundId?:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query(activeWorkflow,[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const question=await currentQuestion(db,id);
  const artifacts=await db.query("SELECT ar.id,ar.kind,ar.sha256,ar.storage_path,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND s.status='succeeded'",[id,question.attachment_ids]);
  const sources=[];for(const artifact of artifacts.rows)sources.push({...artifact,text:await readAnswerAttachment(root,artifact)});
  const input=buildAnswerInput({...question,answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}},sources);
  const snapshot={...input,question_attempt_id:question.question_attempt_id,input_digest:inputDigest(input)};
  const settings=await readRevisionSettings(db,id,revisionRoundId);
  const overrides=settings?settings.configs?.['5']??{}:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=5',[workflow.project_id])).rows[0]?.config??{};
  const selected=settings?settings.model_set:await readProjectModelSet(db,workflow.project_id);const hasModelSet=selected.length>0;
  const models:RegisteredAnswerModel[]=selected.length?selected:[{model_id:'',name:'',minimum_score:0,config:resolveAnswerConfig(overrides)}];
  const modelSetDigest=answerModelSetDigest(models);
  const modelSet=models.map(({model_id,name,minimum_score,config})=>({model_id,name,minimum_score,config}));
  const queued:{id:string;reused:boolean}[]=[];
  for(const model of models){
   const input={...snapshot,model_id:model.model_id||null,model_name:model.name||null,...(hasModelSet?{model_set_digest:modelSetDigest,model_set:modelSet}:{})};
   // Workflow row lock serializes a whole model-set enqueue. Each model is deduplicated independently.
   const previous=await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input->>'question_attempt_id'=$2 AND input->>'input_digest'=$3 AND input->>'model_id' IS NOT DISTINCT FROM $4 AND config=$5::jsonb AND (($6::boolean AND input->>'model_set_digest'=$7) OR (NOT $6::boolean AND input->>'model_set_digest' IS NULL)) AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,question.question_attempt_id,snapshot.input_digest,model.model_id||null,JSON.stringify(model.config),hasModelSet,modelSetDigest]);
 if(previous.rowCount){queued.push({id:previous.rows[0].id,reused:true});continue;}
   const attempt=crypto.randomUUID();
   await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,5,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=5",[id,attempt,JSON.stringify(input),JSON.stringify(model.config)]);
   await bindRevisionAttempt(db,id,attempt,revisionRoundId);
   queued.push({id:attempt,reused:false});
  }
  const existingQueued=await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND status IN ('waiting','running') AND input->>'model_set_digest' IS DISTINCT FROM $2 AND id<>ALL($3::uuid[]) LIMIT 1",[id,modelSetDigest,queued.map(item=>item.id)]);
  if(existingQueued.rowCount)throw new HTTPException(409,{message:'另一组模型仍在作答，请等待完成后再修改项目模型集合'});
  const allReused=queued.every(item=>item.reused);
  if(allReused){await db.query('COMMIT');for(const [index,item] of queued.entries()){const model=models[index];withLogContext({component:'answer',workflow_id:id,project_id:workflow.project_id,ordinal:5,attempt_id:item.id,operation:'answer_enqueue',provider:model?.config.provider,model:model?.config.model},()=>logEvent('attempt.reused',{level:'info',state:'reused'}));}return hasModelSet?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:true}:{id:queued[0]!.id,reused:true};}
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=5",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>5 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='作答更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>5 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');for(const [index,item] of queued.entries()){const model=models[index];withLogContext({component:'answer',workflow_id:id,project_id:workflow.project_id,ordinal:5,attempt_id:item.id,operation:'answer_enqueue',provider:model?.config.provider,model:model?.config.model},()=>logEvent(item.reused?'attempt.reused':'attempt.enqueued',{level:'info',state:'waiting'}));}return hasModelSet?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:false}:{id:queued[0]!.id,reused:false};
 }catch(error){await db.query('ROLLBACK');if(error instanceof AnswerInputError)throw new HTTPException(409,{message:error.message});if((error instanceof QwenError||error instanceof DomesticError))throw new HTTPException(400,{message:error.message});throw error;}finally{db.release();}
}
async function matchesQuestion(db:PoolClient,job:any){
 try{
  const current=await currentQuestion(db,job.workflow_id);
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
  const latest=await db.query("UPDATE ai_distill.steps SET status=$2,result=$3,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=5 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1)",[job.workflow_id,job.status==='succeeded'?'succeeded':'failed',JSON.stringify(job.result)]);
  return latest.rowCount;
 }
 const rows=await db.query("SELECT id,input,result,status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input->>'model_set_digest'=$2 AND input->>'question_attempt_id'=$3 AND input->>'input_digest'=$4 ORDER BY attempt DESC",[job.workflow_id,job.input.model_set_digest,job.input.question_attempt_id,job.input.input_digest]);
 const latest=new Map<string,any>();
 for(const row of rows.rows){const id=row.input?.model_id;if(typeof id==='string'&&id&&!latest.has(id))latest.set(id,row);}
 const models=job.input.model_set.map((model:any)=>{const row=latest.get(model.model_id);return {model_id:model.model_id,name:model.name,minimum_score:model.minimum_score,attempt_id:row?.id??null,status:row?.status??'waiting',answer_sha256:row?.result?.answer_sha256??null,answer:row?.status==='succeeded'?row.result.text:null};});
 const settled=models.every((model:any)=>['succeeded','failed','skipped'].includes(model.status));
 const active=models.some((model:any)=>model.status==='running');
 const status=settled?(models.every((model:any)=>model.status==='succeeded')?'succeeded':'failed'):active?'running':'waiting';
 const result={model_set_digest:job.input.model_set_digest,models};
 return (await db.query("UPDATE ai_distill.steps SET status=$2,result=$3,error=NULL,finished_at=CASE WHEN $2='succeeded' THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=5 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1)",[job.workflow_id,status,JSON.stringify(result)])).rowCount;
}
/**
 * 领取一个当前版本的单模型作答任务，校验冻结输入后调用对应供应商并保存完整答案及 usage。
 * 发布前再次核对题面、附件、模型集合和活动尝试，防止过期响应覆盖当前步骤状态。
 */
export async function runNextAnswer(pool:Pool,root:string,answer:(input:AnswerRequest<ResolvedAnswerConfig>)=>Promise<QwenAnswer>=createAnswerClient().answer,signal?:AbortSignal){
 const db=await pool.connect();let job:any,staleRows:any[]=[];
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=5 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){
   const updated=await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='作答进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[row.id]);
   await db.query("UPDATE ai_distill.steps SET status='failed',error='作答进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=5 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1)",[row.workflow_id]);
   if(updated.rowCount)staleRows.push(row);
  }
  job=(await db.query("SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=5 AND a.status='waiting' AND (a.revision_round_id IS NULL OR NOT EXISTS(SELECT 1 FROM ai_distill.step_attempts active WHERE active.workflow_id=a.workflow_id AND active.revision_round_id IS NOT NULL AND active.status='running')) ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');for(const row of staleRows)withLogContext({component:'answer',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:5,attempt_id:row.id,operation:'answer'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);
  await db.query("UPDATE ai_distill.steps SET status='running',started_at=now(),error=NULL WHERE workflow_id=$1 AND ordinal=5",[job.workflow_id]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 for(const row of staleRows)withLogContext({component:'answer',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:5,attempt_id:row.id,operation:'answer'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));
 const restoreLogContext=enterLogContext({component:'answer',workflow_id:job.workflow_id,project_id:job.project_id,ordinal:5,attempt_id:job.id,operation:'answer',provider:job.config.provider,model:job.config.model});
 logEvent('attempt.claimed',{level:'info',state:'running'});logEvent('attempt.started',{level:'info',state:'running',material_count:job.input.materials?.length??0});
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 let heartbeatFailed=false,lastHeartbeatAt=new Date().toISOString();
 let heartbeatInFlight=false;
 const heartbeat=setInterval(()=>{if(heartbeatInFlight)return;heartbeatInFlight=true;withLogContext({component:'answer',project_id:job.project_id,workflow_id:job.workflow_id,ordinal:5,attempt_id:job.id},()=>pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]).then(result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});heartbeatFailed=true;}else{if(heartbeatFailed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch(error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});console.error('作答任务心跳写入失败');}heartbeatFailed=true;}).finally(()=>{heartbeatInFlight=false;}));},10000);
 let wrote=false;
 try{
  // Validate the stored snapshot before dispatch, then check current source again at publication.
  const packaged:AnswerPackage={question_version:job.input.question_version,question:job.input.question,materials:job.input.materials,attachments:job.input.attachments};
  if(inputDigest(packaged)!==job.input.input_digest)throw new AnswerInputError();
  const before=await pool.connect();try{await before.query('BEGIN');const w=(await before.query(activeWorkflow,[job.workflow_id])).rows[0];if(!w||!await matchesQuestion(before,job)||!await matchesModelSet(before,job))throw new AnswerInputError('题目或项目模型配置已变化');await before.query('COMMIT');}catch(error){await before.query('ROLLBACK');throw error;}finally{before.release();}
  const result=await runRevisionCall(pool,job.id,'answer',remaining=>answer({config:resolveAnswerConfig(job.config),question:packaged.question,materials:packaged.materials,signal,timeout_ms:Math.min(3600000,remaining??3600000)}));
  const directory=join(resolve(root),job.workflow_id,job.id);await mkdir(directory,{recursive:true});
  const bytes=Buffer.from(result.text);const path=join(directory,'answer.txt');wrote=true;logEvent('file.write.started',{level:'info',file_kind:'model_answer',output_bytes:bytes.length});await writeFile(path,bytes,{mode:0o600});logEvent('file.write.completed',{level:'info',file_kind:'model_answer',output_bytes:bytes.length});
  const answer_sha256=createHash('sha256').update(bytes).digest('hex');
  const publication={...result,provider:job.config.provider??'qwen',mode:job.config.enable_thinking===undefined?'provider_default':job.config.enable_thinking?'thinking_enabled':'thinking_disabled',model_id:job.input.model_id??null,model_name:job.input.model_name??null,answer_sha256,input_digest:job.input.input_digest,question_version:job.input.question_version,question_attempt_id:job.input.question_attempt_id,tools:[],output_mode:'text',execution_steps:null};
  const tx=await pool.connect();
  try{
   await tx.query('BEGIN');
   const w=(await tx.query(activeWorkflow,[job.workflow_id])).rows[0];
   const active=await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id]);
   if(!w||!active.rowCount||!await matchesQuestion(tx,job)||!await matchesModelSet(tx,job))throw new AnswerInputError('题目或项目模型配置已变化，答案未发布');
   await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),job.workflow_id,job.id,'model_answer',relative(resolve(root),path),answer_sha256,bytes.length]);
   await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(publication)]);
   job.status='succeeded';job.result=publication;await refreshAnswerStep(tx,job);
   await tx.query('COMMIT');
   logEvent('attempt.completed',{level:'info',state:'succeeded',output_bytes:bytes.length,token_usage:result.usage});
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  logEvent('attempt.failed',{level:'error',state:'failed',...classifyLogError(error)});
  if(wrote)try{const published=await pool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1',[job.id]);if(!published.rowCount)await rm(join(resolve(root),job.workflow_id,job.id),{recursive:true,force:true});}catch(cleanupError){logEvent('file.cleanup_or_commit_check_failed',{level:'error',file_kind:'model_answer',...classifyLogError(cleanupError)});console.error('无法确认答案发布状态，保留文件等待核对');}
  const message=error instanceof QwenError||error instanceof DomesticError||error instanceof AnswerInputError?error.message:'模型作答失败，请检查服务配置或存储状态';
  const result=error instanceof QwenError||error instanceof DomesticError?{error:{kind:error.kind,retryable:error.retryable,http_status:error.http_status,provider_code:error.provider_code,request_id:error.request_id,reason_code:error.reason_code??null}}:null;
  const tx=await pool.connect();try{
   await tx.query('BEGIN');const w=(await tx.query(activeWorkflow,[job.workflow_id])).rows[0];
   const failed=await tx.query("UPDATE ai_distill.step_attempts SET status='failed',error=$2,result=$3,finished_at=now() WHERE id=$1 AND status='running'",[job.id,message,JSON.stringify(result)]);
   if(failed.rowCount&&w&&await matchesQuestion(tx,job)){job.status='failed';job.result=result;await refreshAnswerStep(tx,job);}
   await tx.query('COMMIT');
  }catch(failure){await tx.query('ROLLBACK');throw failure;}finally{tx.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);restoreLogContext();}
 return true;
}
