/**
 * 文件职责：创建、领取、取消和结束独立材料库任务，冻结任务输入/设置并校验租约。
 * 关键入口：`enqueueLibraryJob()` 冻结任务；`assertLibraryExtractionUsable()` 在派发和执行前检查提取完整性；`claimLibraryJob()` 在 worker 持有资源槽后领取；终态更新须匹配 lease_token。
 * 使用场景：材料库 routes 与现有 worker API/Agent/材料消费池；本模块不创建项目步骤或 step_attempt。
 */
import {registerLocalJob,localClaimSql,localQueueEnabled,localCancellationRequested} from '../execution-queue/runtime';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {currentTaskSignal} from '../task-signal';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../../shared/workflow-config';
import type {CreateLibraryJobRequest,LibraryExecutionTarget,LibraryExecutorKind,LibraryJobKind} from '../../shared/material-library';
import {readLibraryProcessingSettings} from './settings';
import {resolveLibraryTemplate} from './templates';
import {readAgentDefaults} from '../agent';
import {AGENT_REDACTION_MAX_MS} from '../../shared/redaction-templates';
import {readProjectMaterialProcessingMode,projectRedactionTemplate} from './processing-policy';

const conflict=(message:string)=>new HTTPException(409,{message});
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const LIBRARY_JOB_LEASE_MS=120_000;
export const LIBRARY_JOB_HEARTBEAT_MS=15_000;

/** 检查文件/正文可处理性；OCR提示保留追溯，不能等同于脱敏丢失实质内容。 */
export function assertLibraryExtractionUsable(documents:Array<{issues:unknown;page_count?:number;pages?:Array<{text:string}>}>){
 if(!documents.length||documents.some(document=>!Array.isArray(document.issues)||
  (document.page_count!==undefined&&(!Number.isInteger(document.page_count)||document.page_count<1))||
  (document.pages!==undefined&&(!document.pages.length||document.pages.every(page=>!page.text.trim()))))){
  throw Object.assign(conflict('提取结果缺少有效文件、页数或正文，请先完成文本识别再执行脱敏'),{reason_code:'library_extraction_not_usable'});
 }
}

export async function hasLibraryQueueWork(pool:Pool,executor:LibraryExecutorKind,target:LibraryExecutionTarget){
 const schema=await pool.query("SELECT to_regclass('ai_distill.library_jobs') IS NOT NULL AS available");
 if(schema.rows[0]?.available!==true)return false;
 const result=await pool.query(`SELECT EXISTS(
  SELECT 1 FROM ai_distill.library_jobs
  WHERE executor_kind=$1 AND execution_target=$2 AND (status='queued' OR (status='running' AND lease_expires_at<now()))
 ) AS pending`,[executor,target]);
 return result.rows[0]?.pending===true;
}

export function validateLibraryJobRequest(value:unknown):CreateLibraryJobRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'材料处理任务参数无效'});
 const body=value as Record<string,unknown>,allowed=['kind','request_key','execution_target','extraction_job_id','previous_job_id','template_id','project_id'];
 if(Object.keys(body).some(key=>!allowed.includes(key))||!['intake','extract','redact'].includes(String(body.kind))||typeof body.request_key!=='string'||!uuidPattern.test(body.request_key)||!['local','server'].includes(String(body.execution_target)))throw new HTTPException(400,{message:'材料处理任务参数无效'});
 if(body.kind==='redact'&&(typeof body.extraction_job_id!=='string'||!uuidPattern.test(body.extraction_job_id)))throw new HTTPException(400,{message:'脱敏任务必须明确指定成功的文本提取任务'});
 if(body.kind!=='redact'&&body.extraction_job_id!==undefined)throw new HTTPException(400,{message:'仅脱敏任务可以指定文本提取任务'});
 if(body.previous_job_id!==undefined&&(typeof body.previous_job_id!=='string'||!uuidPattern.test(body.previous_job_id)))throw new HTTPException(400,{message:'重试来源任务 ID 无效'});
 if(body.template_id!==undefined&&(body.kind!=='redact'||typeof body.template_id!=='string'||! /^[a-z][a-z0-9_-]{0,47}$/.test(body.template_id)))throw new HTTPException(400,{message:'仅脱敏任务可指定有效模板'});
 if(body.project_id!==undefined&&(typeof body.project_id!=='string'||!uuidPattern.test(body.project_id)))throw new HTTPException(400,{message:'材料处理期次标识无效'});
 return{...(typeof body.project_id==='string'?{project_id:body.project_id}:{}),...(typeof body.template_id==='string'?{template_id:body.template_id}:{}),kind:body.kind as LibraryJobKind,request_key:body.request_key,execution_target:body.execution_target as LibraryExecutionTarget,...(typeof body.extraction_job_id==='string'?{extraction_job_id:body.extraction_job_id}:{}),...(typeof body.previous_job_id==='string'?{previous_job_id:body.previous_job_id}:{})};
}

export function chooseLibraryExecutor(kind:LibraryJobKind,files:Array<{format:string;redaction_mode?:'model'|'declared_redacted'}>,settings:{provider?:string}|null,target:LibraryExecutionTarget='local'):LibraryExecutorKind{
 if(kind==='intake')return'internal';
 if(kind==='extract')return files.some(file=>file.format==='pdf'||file.format==='docx')?'api':'internal';
 if(files.length>0&&files.every(file=>file.redaction_mode==='declared_redacted'))return'internal';
 if(settings?.provider==='codex'){
  if(target==='server')throw new HTTPException(409,{message:'Agent 脱敏只能在本机执行'});
  return'agent';
 }
 if(settings?.provider==='api')return'api';
 throw new HTTPException(409,{message:'材料库脱敏模型尚未配置'});
}

type LibraryFileRow={id:string;blob_id:string;original_name:string;position:number;redaction_mode:'model'|'declared_redacted';sha256:string;size_bytes:string|number;content_type:string;storage_target:'local'|'server';storage_path:string};
function fileFormat(name:string){return name.split('.').at(-1)?.toLowerCase()??'';}

/** 创建任务时包锁先于版本锁，与归档/上传保持一致；同 request_key 重放优先返回原冻结任务。 */
export async function enqueueLibraryJob(pool:Pool,packageId:string,revisionId:string,value:unknown,storageRoot?:string){
 const request=validateLibraryJobRequest(value),db=await pool.connect();
 try{
  await db.query('BEGIN');
  const pkg=(await db.query('SELECT id,processing_settings,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[packageId])).rows[0];
  if(!pkg||pkg.deleted_at)throw new HTTPException(404,{message:'材料包不存在'});
  const revision=(await db.query('SELECT id,package_id,state,manifest_sha256,file_count FROM ai_distill.library_revisions WHERE id=$1 AND package_id=$2 FOR UPDATE',[revisionId,packageId])).rows[0];
  if(!revision)throw new HTTPException(404,{message:'材料文件集合不存在'});
  const files=(await db.query(`SELECT f.id,f.blob_id,f.original_name,f.position,f.redaction_mode,b.sha256,b.size_bytes,b.content_type,b.storage_target,b.storage_path
   FROM ai_distill.library_files f JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=$1 ORDER BY f.position`,[revisionId])).rows as LibraryFileRow[];
  if(files.length!==Number(revision.file_count))throw conflict('材料文件集合清单不完整');
  if(files.some(file=>file.storage_target!==request.execution_target))throw conflict('所选执行位置无法读取文件集合中的全部原件');
  const intent={version:1,...(request.project_id?{project_id:request.project_id}:{}),...(request.template_id?{template_id:request.template_id}:{}),kind:request.kind,revision_id:revisionId,execution_target:request.execution_target,...(request.extraction_job_id?{extraction_job_id:request.extraction_job_id}:{}),...(request.previous_job_id?{previous_job_id:request.previous_job_id}:{})};
  const requestDigest=hash(intent);
  const previousRequest=(await db.query('SELECT id,input_snapshot FROM ai_distill.library_jobs WHERE package_id=$1 AND request_key=$2',[packageId,request.request_key])).rows[0];
  if(previousRequest){
   if(previousRequest.input_snapshot?.request_digest!==requestDigest)throw conflict('同一任务请求标识对应不同输入');
   await db.query('COMMIT');return{id:previousRequest.id,reused:true};
  }
  const settings=(await readLibraryProcessingSettings(db,storageRoot)).processing_settings as Record<string,any>;
  const projectMode=request.project_id?await readProjectMaterialProcessingMode(db,request.project_id):undefined;
  const template=request.kind==='redact'?resolveLibraryTemplate(settings,projectMode?projectRedactionTemplate(projectMode,request.template_id):request.template_id):undefined;
  if(projectMode==='aliases'&&template&&template.workflow!=='codex_plan')throw conflict('化名模式需要整包Agent模板，当前模板配置与流程不一致');
  if(projectMode==='mask'&&template&&template.workflow!=='field_mapping')throw conflict('API遮挡模式需要字段映射模板，当前模板配置与流程不一致');
  if(template?.workflow==='codex_plan'){
   settings.redaction={...template.redaction,...await readAgentDefaults(db)};
   settings.execution.task_timeout_ms=Math.min(settings.execution.task_timeout_ms,AGENT_REDACTION_MAX_MS);
  }else if(template){
   settings.redaction={...template.redaction,...(projectMode==='mask'?{provider:'api'}:{})};
   if(projectMode==='mask'&&!settings.redaction.api)throw conflict('请先在材料处理设置中配置API遮挡模型');
  }
  const executor=chooseLibraryExecutor(request.kind,files.map(file=>({format:fileFormat(file.original_name),redaction_mode:template?.workflow==='codex_plan'||projectMode==='mask'?'model':file.redaction_mode})),settings.redaction,request.execution_target);
  if(request.kind==='redact'&&executor==='api'&&!settings.redaction?.api)throw conflict('材料库 API 模型尚未配置');
  if(request.kind==='extract'&&executor==='api'&&!process.env.MINERU_KEY?.trim())throw conflict('文本提取服务尚未配置');
  if(request.previous_job_id){
   const retry=(await db.query("SELECT id FROM ai_distill.library_jobs WHERE id=$1 AND package_id=$2 AND revision_id=$3 AND kind=$4 AND (status IN ('failed','cancelled') OR (kind='redact' AND status='succeeded')) FOR UPDATE",[request.previous_job_id,packageId,revisionId,request.kind])).rows[0];
   if(!retry)throw conflict('重试来源必须是同包、同文件集合、同类型且已失败或取消的任务');
  }
  if(request.kind==='intake'&&revision.state!=='pending')throw conflict('只有待入库核验的文件集合可以入库');
  if(request.kind!=='intake'&&revision.state!=='ready')throw conflict('请先完成材料入库核验');
  let fileSnapshot:Record<string,unknown>[];
  if(request.kind==='redact'){
   const extraction=(await db.query("SELECT id,status,input_digest FROM ai_distill.library_jobs WHERE id=$1 AND package_id=$2 AND revision_id=$3 AND kind='extract'",[request.extraction_job_id,packageId,revisionId])).rows[0];
   if(!extraction||extraction.status!=='succeeded')throw conflict('脱敏必须使用同文件集合中的成功文本提取任务');
   const documents=(await db.query(`SELECT d.id AS document_id,d.file_id,d.document_blob_id,d.source_sha256,d.text_sha256,d.page_count,d.issues,b.sha256 AS document_sha256,
     f.original_name,f.position,f.redaction_mode
    FROM ai_distill.library_documents d JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id JOIN ai_distill.library_files f ON f.id=d.file_id AND f.revision_id=d.revision_id
    WHERE d.extraction_job_id=$1 AND d.revision_id=$2 ORDER BY f.position`,[request.extraction_job_id,revisionId])).rows;
   if(documents.length!==files.length||files.some(file=>!documents.some(doc=>doc.file_id===file.id&&doc.source_sha256===file.sha256)))throw conflict('该提取任务没有覆盖此文件集合的全部原件');
   assertLibraryExtractionUsable(documents);
   fileSnapshot=documents.map(document=>({document_id:document.document_id,file_id:document.file_id,document_blob_id:document.document_blob_id,original_name:document.original_name,position:document.position,redaction_mode:document.redaction_mode,source_sha256:document.source_sha256,document_sha256:document.document_sha256,text_sha256:document.text_sha256,page_count:document.page_count,issues:document.issues}));
  }else{
   fileSnapshot=files.map(file=>({file_id:file.id,blob_id:file.blob_id,original_name:file.original_name,position:file.position,source_sha256:file.sha256,size_bytes:Number(file.size_bytes),content_type:file.content_type,storage_path:file.storage_path,redaction_mode:file.redaction_mode,format:fileFormat(file.original_name)}));
  }
  const inputSnapshot={...intent,...(projectMode?{material_processing_mode:projectMode}:{}),manifest_sha256:revision.manifest_sha256,request_digest:requestDigest,files:fileSnapshot};
  const pdfProvider=process.env.PDF_EXTRACTION_PROVIDER||'mineru-api';
  if(request.kind==='extract'&&executor==='api'&&!['mineru-api','mineru-cli'].includes(pdfProvider))throw conflict('当前文本提取供应商配置无效');
  const inputDigest=hash(inputSnapshot),configSnapshot={version:1,settings,...(template?{redaction_template:template}:{}),...(request.kind==='extract'?{pdf_provider:pdfProvider}:{}),...(request.kind==='redact'?{extraction_job_id:request.extraction_job_id}:{})},configDigest=hash(configSnapshot),id=randomUUID();
  const active=(await db.query("SELECT id FROM ai_distill.library_jobs WHERE revision_id=$1 AND status IN ('queued','running') LIMIT 1",[revisionId])).rows[0];
  if(active)throw conflict('该文件集合已有活动任务，请等待完成或取消后重试');
  const result=await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,previous_job_id,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target)
   VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12) RETURNING id,status,kind,executor_kind,execution_target,created_at`,[id,packageId,revisionId,request.kind,request.request_key,request.previous_job_id??null,inputDigest,JSON.stringify(inputSnapshot),configDigest,JSON.stringify(configSnapshot),executor,request.execution_target]);
  await registerLocalJob(db,id,'library',executor,`library:${request.kind}`);
  await db.query('COMMIT');return{...result.rows[0],reused:false};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'材料任务入队失败且回滚状态不确定');}throw error;}finally{db.release();}
}

export async function readLibraryJob(pool:Pool,id:string){
 const row=(await pool.query(`SELECT id,package_id,revision_id,kind,status,origin,executor_kind,execution_target,progress,result_summary,error_code,error_message,previous_job_id,cancel_requested_at,
  input_snapshot->>'extraction_job_id' AS extraction_job_id,input_snapshot->>'material_processing_mode' AS material_processing_mode,config_snapshot->'redaction_template'->>'id' AS redaction_template_id,created_at,started_at,finished_at
  FROM ai_distill.library_jobs WHERE id=$1`,[id])).rows[0];
 if(!row)throw new HTTPException(404,{message:'材料处理任务不存在'});
 return row;
}

export async function cancelLibraryJob(pool:Pool,id:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const job=(await db.query('SELECT id,status FROM ai_distill.library_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!job)throw new HTTPException(404,{message:'材料处理任务不存在'});
  if(job.status==='queued')await db.query("UPDATE ai_distill.library_jobs SET status='cancelled',finished_at=now(),result_summary=COALESCE(result_summary,'{}'::jsonb)||jsonb_build_object('execution_stop',jsonb_build_object('reason_code','user_cancelled','observed_at',now())) WHERE id=$1 AND status='queued'",[id]);
  else if(job.status==='running')await db.query("UPDATE ai_distill.library_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),result_summary=COALESCE(result_summary,'{}'::jsonb)||jsonb_build_object('execution_stop',jsonb_build_object('reason_code','user_cancelled','observed_at',COALESCE(cancel_requested_at,now()))) WHERE id=$1 AND status='running'",[id]);
  await db.query('COMMIT');return readLibraryJob(pool,id);
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'材料任务取消失败且回滚状态不确定');}throw error;}finally{db.release();}
}

/** 只由已经取得对应 worker 槽位的消费者调用；失租旧任务终结，不重新排回队列。 */
export async function claimLibraryJob(pool:Pool,executor:LibraryExecutorKind,target:LibraryExecutionTarget,onlyJobId?:string){
 const schema=await pool.query("SELECT to_regclass('ai_distill.library_jobs') IS NOT NULL AS available");
 if(schema.rows[0]?.available!==true)return null;
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const values=onlyJobId?[executor,target,onlyJobId]:[executor,target];
  await db.query("UPDATE ai_distill.library_jobs SET status='failed',error_code='worker_interrupted',error_message='执行进程租约过期，可创建新尝试',finished_at=now(),lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE executor_kind=$1 AND execution_target=$2 AND status='running' AND lease_expires_at<now()"+localClaimSql('library_jobs',true)+(onlyJobId?' AND id=$3::uuid':''),values);
  const job=(await db.query(`SELECT j.*,p.name AS package_name FROM ai_distill.library_jobs j JOIN ai_distill.library_packages p ON p.id=j.package_id
   WHERE j.executor_kind=$1 AND j.execution_target=$2 AND ${localQueueEnabled()?"j.status IN ('queued','running')":"j.status='queued'"} ${localClaimSql('j')} AND p.deleted_at IS NULL ${onlyJobId?'AND j.id=$3::uuid':''}
   ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,values)).rows[0];
  if(!job){await db.query('COMMIT');return null;}
  const ceiling=job.config_snapshot?.redaction_template?.workflow==='codex_plan'?AGENT_REDACTION_MAX_MS:1800000;
  const leaseToken=randomUUID(),timeout=Math.max(1,Math.min(ceiling,Number(job.config_snapshot?.settings?.execution?.task_timeout_ms)||1200000));
  const claimed=await db.query(`UPDATE ai_distill.library_jobs SET status='running',lease_token=$2,started_at=now(),deadline_at=CASE WHEN status='running' THEN deadline_at ELSE now()+($3::text||' milliseconds')::interval END,heartbeat_at=now(),lease_expires_at=now()+($4::text||' milliseconds')::interval,error_code=NULL,error_message=NULL
   WHERE id=$1 AND ${localQueueEnabled()?"status IN ('queued','running')":"status='queued'"} RETURNING *`,[job.id,leaseToken,timeout,LIBRARY_JOB_LEASE_MS]);
  if(!claimed.rowCount)throw conflict('材料任务已由其他 worker 领取');
  await db.query('COMMIT');return claimed.rows[0];
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'材料任务领取失败且回滚状态不确定');}throw error;}finally{db.release();}
}

export async function heartbeatLibraryJob(pool:Pool,jobId:string,leaseToken:string,progress?:Record<string,unknown>){
 const result=await pool.query(`UPDATE ai_distill.library_jobs SET heartbeat_at=now(),lease_expires_at=now()+($3::text||' milliseconds')::interval,progress=COALESCE($4::jsonb,progress)
  WHERE id=$1 AND lease_token=$2 AND status='running' AND cancel_requested_at IS NULL AND deadline_at>now() RETURNING id`,[jobId,leaseToken,LIBRARY_JOB_LEASE_MS,progress?JSON.stringify(progress):null]);
 return result.rowCount===1;
}

export async function finishLibraryJob(pool:Pool,jobId:string,leaseToken:string,resultSummary:Record<string,unknown>,publish:(db:import('pg').PoolClient)=>Promise<void>){
 const signal=currentTaskSignal();signal?.throwIfAborted();if(localCancellationRequested())throw new Error('本机任务已取消');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const job=(await db.query("SELECT id,revision_id FROM ai_distill.library_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND cancel_requested_at IS NULL AND lease_expires_at>now() AND deadline_at>now() FOR UPDATE",[jobId,leaseToken])).rows[0];
  if(!job)throw conflict('材料任务已取消、失租或超过执行期限，结果未发布');
  signal?.throwIfAborted();
  await publish(db);
  signal?.throwIfAborted();
  const saved=await db.query("UPDATE ai_distill.library_jobs SET status='succeeded',result_summary=$3::jsonb,finished_at=now(),lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",[jobId,leaseToken,JSON.stringify(resultSummary)]);
  if(saved.rowCount!==1)throw conflict('材料任务提交权已失效，结果未发布');
  signal?.throwIfAborted();
  await db.query('COMMIT');return true;
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'材料任务结果提交失败且回滚状态不确定');}throw error;}finally{db.release();}
}

export async function failLibraryJob(pool:Pool,jobId:string,leaseToken:string,code:string,message:string,status:'failed'|'cancelled'='failed'){
 const stop={reason_code:code,observed_at:new Date().toISOString()};
 const result=await pool.query("UPDATE ai_distill.library_jobs SET status=CASE WHEN $3='cancelled' OR cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,error_code=CASE WHEN $3='cancelled' OR cancel_requested_at IS NOT NULL THEN NULL ELSE $4 END,error_message=$5,result_summary=COALESCE(result_summary,'{}'::jsonb)||jsonb_build_object('execution_stop',$6::jsonb||CASE WHEN cancel_requested_at IS NOT NULL THEN jsonb_build_object('reason_code','user_cancelled','local_reason_code',$4::text) ELSE '{}'::jsonb END),finished_at=now(),lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",[jobId,leaseToken,status,code.slice(0,100),message.slice(0,1000),JSON.stringify(stop)]);
 return result.rowCount===1;
}
