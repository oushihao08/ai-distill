/**
 * 职责：独立脱敏队列：冻结入库文本和模型配置，执行脱敏与检查并保存当前版本的清洁附件。
 * 关键方法与用途：`enqueueRedaction()` 冻结原文与模型配置；`runNextRedaction()` 消费任务并保存当前版本清洁附件；摘要函数固定输入。
 * 使用场景：`app.ts` 派发，`worker.ts` 执行；不会改写来源文件。
 */
import {readRevisionSettings,bindRevisionAttempt} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {runAgent} from '../agent';
import {createModelApiClient} from '../llm-api';
import {mergeRedactionDefaults} from './redaction-config';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {watchTaskCancellation} from '../task-signal';
import {validateStepConfig} from '../project-folders';
import {readConfiguredAgentModelCatalog,readProjectAgentDefaults} from '../agent/config';
import {DEFAULT_REDACTION_PROMPT} from '@shared/step-registry';
import {redactExtractedMaterials,type ExtractedMaterial} from './redaction';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function redactionFailureSummary(error:unknown){
 const classified=classifyLogError(error),value=error&&typeof error==='object'?error as {reason_code?:unknown;reason?:unknown;call_id?:unknown;call_ids?:unknown;retryable?:unknown;occurred_at?:unknown;expected_count?:unknown;actual_count?:unknown;expected_page?:unknown;actual_page?:unknown;material_id?:unknown;usage?:unknown;duration_ms?:unknown}:{};
 const candidateReason=value.reason_code??value.reason;
 const reason_code=typeof candidateReason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(candidateReason)?candidateReason:`${classified.error_kind}_failure`;
 const call_id=typeof value.call_id==='string'&&/^[0-9a-f-]{36}$/i.test(value.call_id)?value.call_id:undefined;
 const call_ids=Array.isArray(value.call_ids)?value.call_ids.filter((item):item is string=>typeof item==='string'&&/^[0-9a-f-]{36}$/i.test(item)):undefined;
 const occurred_at=typeof value.occurred_at==='string'&&!Number.isNaN(Date.parse(value.occurred_at))?new Date(value.occurred_at).toISOString():new Date().toISOString();
 const counts:Record<string,unknown>=Object.fromEntries((['expected_count','actual_count','expected_page','actual_page'] as const).flatMap(key=>Number.isSafeInteger(value[key])?[[key,value[key] as number]]:[]));
 if(typeof value.material_id==='string'&&/^[0-9a-f-]{36}$/i.test(value.material_id))counts.material_id=value.material_id;
 const usage=value.usage&&typeof value.usage==='object'&&!Array.isArray(value.usage)?value.usage:undefined;
 const duration_ms=Number.isSafeInteger(value.duration_ms)&&Number(value.duration_ms)>=0?Number(value.duration_ms):undefined;
 return{kind:classified.error_kind,reason_code,...(call_id?{call_id}:{}),...(call_ids?.length?{call_ids}:{}),...counts,...(usage?{usage}:{}),...(duration_ms!==undefined?{duration_ms}:{}),retryable:typeof value.retryable==='boolean'?value.retryable:classified.retryable??false,occurred_at};
}
type RedactionSource={material_id:string;original_name?:string;source_sha256:string;artifact_id:string;artifact_sha256:string};
const digestMaterials=(materials:RedactionSource[])=>materials.map(item=>({material_id:item.material_id,source_sha256:item.source_sha256,artifact_id:item.artifact_id,artifact_sha256:item.artifact_sha256}));
export const redactionInputDigest=(materials:RedactionSource[])=>hash(JSON.stringify({materials:digestMaterials(materials)}));
function matchingRedactionDigest(materials:RedactionSource[],digest:unknown,legacyRevision?:unknown):'current'|'legacy'|null{
 if(typeof digest!=='string')return null;
 if(redactionInputDigest(materials)===digest)return'current';
 if(Number.isSafeInteger(legacyRevision)){
  const legacy=hash(JSON.stringify({input_revision:legacyRevision,materials:digestMaterials(materials)}));
  if(legacy===digest)return'legacy';
 }
 return null;
}
const defaultConfig={provider:'api',prompt:DEFAULT_REDACTION_PROMPT};

async function currentSources(db:Pool|PoolClient,id:string){
 const rows=await db.query("SELECT DISTINCT ON(m.id) m.id AS material_id,m.original_name,m.sha256 AS source_sha256,ar.id AS artifact_id,ar.sha256 AS artifact_sha256 FROM ai_distill.materials m JOIN ai_distill.artifacts ar ON ar.workflow_id=m.workflow_id AND ar.material_id=m.id AND ar.kind='private_extracted_pages' JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id AND a.status='succeeded' WHERE m.workflow_id=$1 AND m.deleted_at IS NULL ORDER BY m.id,a.finished_at DESC NULLS LAST,ar.created_at DESC,ar.id DESC",[id]);
 const materialCount=Number((await db.query("SELECT count(*)::int AS count FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL",[id])).rows[0]?.count??0);
 if(!materialCount||rows.rows.length!==materialCount)throw new HTTPException(409,{message:'材料原文尚未全部入库，请先完成提取'});
 const manifest=(await db.query('SELECT source_manifest FROM ai_distill.workflows WHERE id=$1',[id])).rows[0]?.source_manifest;
 const order=new Map<string,number>((Array.isArray(manifest)?manifest:[]).flatMap((item:any,index:number)=>typeof item?.name==='string'?[[item.name,index] as [string,number]]:[]));
 return rows.rows.sort((a:any,b:any)=>(order.get(a.original_name)??Number.MAX_SAFE_INTEGER)-(order.get(b.original_name)??Number.MAX_SAFE_INTEGER)||String(a.material_id).localeCompare(String(b.material_id))) as RedactionSource[];
}
/**
 * 仅在当前材料入库及文本提取已完成、脱敏步骤启用时创建任务，并冻结材料指纹与所选执行方式配置。
 * 相同版本、输入摘要和配置复用已有尝试；创建新输入后使依赖旧脱敏结果的下游状态失效。
 */
export async function enqueueRedaction(pool:Pool,id:string,roundId?:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query("SELECT w.project_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const gate=(await db.query('SELECT ordinal,status,enabled FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal IN (1,2,9) ORDER BY display_position FOR UPDATE',[id])).rows;
  if(gate.length!==3||!gate.find(row=>row.ordinal===9)?.enabled)throw new HTTPException(409,{message:'此项目未启用脱敏步骤'});
  if(gate.find(row=>row.ordinal===1)?.status!=='succeeded'||!['succeeded','skipped'].includes(gate.find(row=>row.ordinal===2)?.status))throw new HTTPException(409,{message:'原始文本尚未完成入库'});
  const sources=await currentSources(db,id);
  const settings=await readRevisionSettings(db,id,roundId);
  const frozen=settings?.configs?.['9'];
  const raw=settings?{...defaultConfig,...(frozen??{})}:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=9',[workflow.project_id])).rows[0]?.config??defaultConfig;
  const merged=mergeRedactionDefaults(raw,raw?.provider==='codex'||!raw?.provider&&typeof raw?.model==='string'?await readProjectAgentDefaults(db,workflow.project_id):{model:'',reasoning_effort:''});
  const config={...validateStepConfig(9,merged,merged.provider==='codex'?await readConfiguredAgentModelCatalog(db):undefined),text_layout:'attachment-page-boundaries'};
  const input={materials:sources};
  const digest=redactionInputDigest(input.materials);
  // A settings change invalidates the current step, even when an older attempt used identical settings.
  const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 AND input->>'digest'=$2 AND config=$3::jsonb AND status IN ('waiting','running','succeeded') AND (status<>'succeeded' OR $4::boolean) ORDER BY attempt DESC LIMIT 1",[id,digest,JSON.stringify(config),gate.find(row=>row.ordinal===9)?.status==='succeeded'])).rows[0];
  if(previous){await db.query('COMMIT');withLogContext({component:'redaction',workflow_id:id,project_id:workflow.project_id,ordinal:9,attempt_id:previous.id,operation:'redaction_enqueue'},()=>logEvent('attempt.reused',{level:'info',state:'waiting'}));return{id:previous.id,reused:true};}
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,9,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=9",[id,attempt,JSON.stringify({...input,digest}),JSON.stringify(config)]);
  await bindRevisionAttempt(db,id,attempt,roundId);
  await db.query("UPDATE ai_distill.steps SET status='waiting',implemented=true,result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=9",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal IN (4,5,6,7,8,10)",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='脱敏输入或设置变化，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal IN (4,5,6,7,8,10) AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');withLogContext({component:'redaction',workflow_id:id,project_id:workflow.project_id,ordinal:9,attempt_id:attempt,operation:'redaction_enqueue'},()=>logEvent('attempt.enqueued',{level:'info',state:'waiting',material_count:sources.length}));return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function readSource(pool:Pool,item:any,workflowId:string):Promise<ExtractedMaterial>{
 const row=(await pool.query("SELECT ar.content,ar.storage_path,ar.sha256,m.sha256 AS source_sha256 FROM ai_distill.artifacts ar JOIN ai_distill.materials m ON m.id=ar.material_id JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id WHERE ar.id=$1 AND ar.workflow_id=$2 AND ar.material_id=$3 AND ar.kind='private_extracted_pages' AND m.deleted_at IS NULL",[item.artifact_id,workflowId,item.material_id])).rows[0];
 if(!row||row.source_sha256!==item.source_sha256||row.sha256!==item.artifact_sha256)throw new Error('raw source changed');
 if(typeof row.content!=='string')throw new Error('raw database text missing');
 const content=row.content;
 if(hash(content)!==row.sha256)throw new Error('raw source hash mismatch');
 const parsed=JSON.parse(content);
 if(parsed.source_sha256!==item.source_sha256||!Array.isArray(parsed.pages)||!parsed.pages.length||parsed.pages.some((page:any,index:number)=>page.page!==index+1||typeof page.text!=='string'))throw new Error('raw source format invalid');
 return{material_id:item.material_id,source_sha256:item.source_sha256,pages:parsed.pages};
}

/**
 * 领取脱敏任务，调用所选 API 或 Agent 生成脱敏正文和页索引。
 * 写入产物前重新检查活动尝试和材料摘要，附件变化或取消后的结果不会发布。
 */
export async function runNextRedaction(pool:Pool,root:string,signal?:AbortSignal,execute:typeof runAgent=runAgent,backend?:'api'|'codex'){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any,staleRows:any[]=[];
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=9 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){const updated=await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='脱敏进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[row.id]);await db.query("UPDATE ai_distill.steps SET status='failed',error='脱敏进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=9 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1)",[row.workflow_id]);if(updated.rowCount)staleRows.push(row);}
  job=(await db.query("SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 AND s.enabled WHERE a.ordinal=9 AND a.status='waiting' AND w.deleted_at IS NULL AND ($1::boolean IS NULL OR (COALESCE(a.config->>'provider','codex')='codex')=$1) ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1",[backend===undefined?null:backend==='codex'])).rows[0];
  if(!job){await db.query('COMMIT');for(const row of staleRows)withLogContext({component:'redaction',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:9,attempt_id:row.id,operation:'redaction'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);
  await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=9",[job.workflow_id]);
  await db.query('COMMIT');
  withLogContext({component:'redaction',workflow_id:job.workflow_id,project_id:job.project_id,ordinal:9,attempt_id:job.id,operation:'redaction'},()=>{logEvent('attempt.claimed',{level:'info',state:'running'});logEvent('attempt.started',{level:'info',state:'running'});});
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 for(const row of staleRows)withLogContext({component:'redaction',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:9,attempt_id:row.id,operation:'redaction'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));
 const restoreLogContext=enterLogContext({component:'redaction',workflow_id:job.workflow_id,project_id:job.project_id,ordinal:9,attempt_id:job.id,operation:'redaction'});
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 const taskContext={component:'redaction',workflow_id:job.workflow_id,project_id:job.project_id,ordinal:9,attempt_id:job.id,operation:'redaction'} as const;
 let heartbeatFailed=false,lastHeartbeatAt=new Date().toISOString();
 const heartbeat=setInterval(()=>{withLogContext(taskContext,()=>pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]).then(result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});heartbeatFailed=true;}else{if(heartbeatFailed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch(error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});console.error('脱敏任务心跳写入失败');}heartbeatFailed=true;}));},10000);
 const directory=join(resolve(root),job.workflow_id,job.id);let wrote=false,digestMode:'current'|'legacy'|null=null;
 try{
  const {digest,...input}=job.input;
  digestMode=matchingRedactionDigest(input.materials,digest,input.input_revision);
  if(!input||!digestMode||(digestMode==='legacy'&&job.input_revision!==input.input_revision))throw new Error('stale snapshot');
  const sources=await currentSources(pool,job.workflow_id);
  if(matchingRedactionDigest(sources,digest,input.input_revision)!==digestMode)throw new Error('stale source');

  const materials:ExtractedMaterial[]=[];
  for(const item of input.materials)materials.push(await readSource(pool,item,job.workflow_id));
  // text_layout 是任务产物格式标记，不是用户可编辑的模型设置。
  const executionConfig={...job.config};delete executionConfig.text_layout;
  const config=validateStepConfig(9,executionConfig,job.config?.provider==='codex'?await readConfiguredAgentModelCatalog(pool):undefined);
  if(!('prompt' in config)||typeof config.prompt!=='string')throw new Error('脱敏设置缺少提示词');
  const provider=config.provider==='api'?config.api.provider:'codex',model=config.provider==='api'?config.api.model:config.model;
  const output=await withLogContext({...taskContext,model,provider},()=>{
   logEvent('attempt.input_validated',{level:'info',material_count:materials.length,page_count:materials.reduce((sum,item)=>sum+item.pages.length,0)});
   return redactExtractedMaterials({directory:join(directory,'private'),materials,config,signal,
    execute:options=>runRevisionCall(pool,job.id,'redaction',(remaining,call_id)=>execute({...options,call_id,timeout_ms:Math.min(options.timeout_ms??1800000,remaining??1800000)})),
    executeApi:(request,callKey)=>runRevisionCall(pool,job.id,callKey,async(remaining,call_id)=>{
     try{return{...await createModelApiClient().complete({...request,call_id,timeout_ms:Math.min(request.timeout_ms??1800000,remaining??1800000)}),call_id};}
     catch(error){if(error instanceof Error)Object.assign(error,{call_id});throw error;}
    }),
   });
  });
  if(signal?.aborted)throw new Error('cancelled');
  const markdownPath=join(directory,'materials.md'),indexPath=join(directory,'pages.json');
  await mkdir(directory,{recursive:true,mode:0o700});
  logEvent('file.write.started',{level:'info',file_kind:'redacted_outputs',output_bytes:Buffer.byteLength(output.markdown)+Buffer.byteLength(output.index)});
  await writeFile(markdownPath,output.markdown,{mode:0o600,flag:'wx'});
  await writeFile(indexPath,output.index,{mode:0o600,flag:'wx'});
  logEvent('file.write.completed',{level:'info',file_kind:'redacted_outputs',output_bytes:Buffer.byteLength(output.markdown)+Buffer.byteLength(output.index)});
  wrote=true;
  const files=[
   {kind:'redacted_markdown',storage_path:relative(resolve(root),markdownPath),content:output.markdown},
   {kind:'redacted_index',storage_path:relative(resolve(root),indexPath),content:output.index},
  ].map(file=>({...file,sha256:hash(file.content),size_bytes:Buffer.byteLength(file.content)}));
  const result={material_count:materials.length,page_count:materials.reduce((sum,item)=>sum+item.pages.length,0),redacted_sha256:files[0]!.sha256,index_sha256:files[1]!.sha256,prompt_sha256:hash(config.prompt),session_id:output.session_id,usage:output.usage,duration_ms:output.duration_ms,provider,model,...(output.completion_id?{completion_id:output.completion_id}:{}),...(output.call_ids.length?{call_ids:output.call_ids}:{})};
  const tx=await pool.connect();
  try{
   await tx.query('BEGIN');
   const current=await tx.query("SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[job.workflow_id]);
   const active=await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id]);
   const sourcesNow=await currentSources(tx,job.workflow_id);
   if(!current.rowCount||!active.rowCount||matchingRedactionDigest(sourcesNow,digest,input.input_revision)!==digestMode)throw new Error('任务附件已失效，结果未发布');
   for(const file of files)await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),job.workflow_id,job.id,file.kind,file.storage_path,file.sha256,file.size_bytes,file.content]);
   await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(result),output.session_id]);
   await tx.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=9",[job.workflow_id,JSON.stringify(result)]);
   await tx.query("UPDATE ai_distill.materials SET processing_status='redacted' WHERE workflow_id=$1 AND deleted_at IS NULL",[job.workflow_id]);
   await tx.query('COMMIT');
   withLogContext({...taskContext,provider,model},()=>logEvent('state_update.committed',{level:'info',state:'succeeded',material_count:materials.length,page_count:result.page_count,output_bytes:files.reduce((sum,file)=>sum+file.size_bytes,0)}));
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  withLogContext(taskContext,()=>logEvent('attempt.failed',{level:'error',state:'failed',...classifyLogError(error)}));
  if(wrote)try{const status=await pool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[job.id]);if(status.rows[0]?.status!=='succeeded')await rm(directory,{recursive:true,force:true});}catch(cleanupError){withLogContext(taskContext,()=>logEvent('file.cleanup_or_commit_check_failed',{level:'error',file_kind:'redacted_outputs',...classifyLogError(cleanupError)}));console.error('无法确认脱敏结果发布状态，保留文件等待核对');}
  const failed=await pool.connect(),summary=redactionFailureSummary(error),safeError='脱敏执行失败或结果校验未通过，可检查配置后重试';
  try{await failed.query('BEGIN');const current=await failed.query("SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[job.workflow_id]);const updated=await failed.query("UPDATE ai_distill.step_attempts SET status='failed',result=COALESCE(result,'{}'::jsonb)||jsonb_build_object('error',$3::jsonb),error=$2,finished_at=now() WHERE id=$1 AND status='running'",[job.id,safeError,JSON.stringify(summary)]);if(updated.rowCount)await failed.query("UPDATE ai_distill.steps SET status='failed',result=COALESCE(result,'{}'::jsonb)||jsonb_build_object('error',$3::jsonb),error=$2,finished_at=now() WHERE workflow_id=$1 AND ordinal=9 AND status='running'",[job.workflow_id,safeError,JSON.stringify(summary)]);await failed.query('COMMIT');withLogContext(taskContext,()=>logEvent(updated.rowCount?'state_update.committed':'state_update.unchanged',{level:updated.rowCount?'info':'warn',state:updated.rowCount?'failed':'unchanged'}));}catch(failure){withLogContext(taskContext,()=>logEvent('state_update.failed',{level:'error',...classifyLogError(failure)}));await failed.query('ROLLBACK');throw failure;}finally{failed.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);restoreLogContext();}
 return true;
}
