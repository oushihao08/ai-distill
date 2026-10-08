import {runRevisionCall} from '../decisions/revision-calls';
import {ProjectDocumentExtractor,DocumentProviderError,type DocumentExtractor} from './document';
import {watchTaskCancellation,withTaskSignal} from '../automation/task-signal';
import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { createVisionClient } from './vision';
import { clearExtractionCheckpoints, processMaterials, type InputMaterial, type ExtractionCache } from './process';
import { loadExtractionConfig } from './config';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export async function enqueueExtraction(pool: Pool, id: string) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  const workflow = await client.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=project_id AND p.deleted_at IS NULL) FOR UPDATE',[id]);
  if (!workflow.rowCount) throw new HTTPException(404,{message:'工作流不存在'});
  const revision = workflow.rows[0].input_revision;
  const steps = await client.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal FOR UPDATE',[id]);
  if (!steps.rowCount) throw new HTTPException(404,{message:'工作流不存在'});
  const materialCheck=await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE lower(original_name) LIKE '%.pdf')::int AS pdfs FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2",[id,revision]);
  if(!materialCheck.rows[0]?.total) throw new HTTPException(409,{message:'材料尚未入库'});
  if(!materialCheck.rows[0]?.pdfs){await client.query("UPDATE ai_distill.steps SET status='skipped',enabled=false,result=$2::jsonb,finished_at=now() WHERE workflow_id=$1 AND ordinal=2",[id,JSON.stringify({reason:'没有PDF，无需单独OCR'})]);await client.query("UPDATE ai_distill.steps SET status='succeeded',finished_at=now() WHERE workflow_id=$1 AND ordinal=1",[id]);await client.query('COMMIT');return{id:'',reused:true,completed:true,status:'skipped'};}
  if(!['succeeded','waiting','running','failed'].includes(steps.rows[0].status)) throw new HTTPException(409,{message:'材料入库尚未完成'});
  const previous = await client.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND input_revision=$2 AND ordinal=2 AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,revision]);
  if(previous.rowCount){await client.query('COMMIT');return {id:previous.rows[0].id,reused:true};}
  const extraction=loadExtractionConfig();
  const attempt = crypto.randomUUID();
  await client.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision) SELECT $2,$1::uuid,2,COALESCE(max(attempt),0)+1,'waiting',jsonb_build_object('workflow_id',$1::text,'input_revision',$4::int),$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=2",[id,attempt,JSON.stringify({model:'glm-ocr',base_url:process.env.ZHIPU_BASE_URL??'https://open.bigmodel.cn/api/paas/v4',ocr_version:'glm-ocr-layout-v1',processor:'pdf-text-ingestion-v1',extraction}),revision]);
  await client.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=2",[id]);
  await client.query('COMMIT'); return {id:attempt,reused:false};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function runNextExtraction(pool: Pool, root: string, processor = processMaterials, workflowId?: string) {
 const client=await pool.connect();let job;
 try{
  await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  // Recover interrupted attempts without claiming that partial work succeeded.
  const stale=await client.query("SELECT a.id,a.workflow_id,a.input_revision,w.input_revision AS current_revision FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=2 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED");
  for(const attempt of stale.rows){
   await client.query("UPDATE ai_distill.step_attempts SET status='failed',error='执行进程中断，可重试',finished_at=now() WHERE id=$1",[attempt.id]);
   if(attempt.input_revision===attempt.current_revision){await client.query("UPDATE ai_distill.steps SET status='failed',error='执行进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=2 AND status='running'",[attempt.workflow_id]);await client.query("UPDATE ai_distill.steps SET status='failed',error='PDF文本提取中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=1",[attempt.workflow_id]);}
  }
  const selected=await client.query("SELECT a.* FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=2 AND a.status='waiting' AND ai_distill.dispatch_allowed(w.id,'materials') AND ($1::uuid IS NULL OR a.workflow_id=$1::uuid) ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1",[workflowId??null]);
  job=selected.rows[0];if(!job){await client.query('COMMIT');return false;}
  await client.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);
  await client.query("UPDATE ai_distill.steps SET status='running',started_at=now() WHERE workflow_id=$1 AND ordinal=2",[job.workflow_id]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const cancellation=watchTaskCancellation(pool,job.id);
 const heartbeat=setInterval(()=>{pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>console.error('处理任务心跳写入失败'));},10000);
 let publication;
 try{
  const materials=await pool.query("SELECT id,storage_path,sha256 FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2 AND lower(original_name) LIKE '%.pdf' ORDER BY created_at,id",[job.workflow_id,job.input_revision]);
  const cacheRows=await pool.query("SELECT DISTINCT ON (m.sha256) m.sha256 AS source_sha256,ar.storage_path,ar.sha256,a.id AS attempt_id,m.id AS material_id FROM ai_distill.artifacts ar JOIN ai_distill.materials m ON m.id=ar.material_id JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id WHERE m.workflow_id=$1 AND lower(m.original_name) LIKE '%.pdf' AND ar.kind='private_extracted_pages' AND a.ordinal=2 AND (a.config->>'ocr_version')=($2::jsonb->>'ocr_version') AND (a.config->>'model')=($2::jsonb->>'model') AND (a.config->>'base_url')=($2::jsonb->>'base_url') AND (a.config#>>'{extraction,extractionPrompt}')=($2::jsonb#>>'{extraction,extractionPrompt}') AND COALESCE(a.config#>>'{extraction,ocrReasoningEffort}',a.config#>>'{extraction,reasoningEffort}') IS NOT DISTINCT FROM COALESCE($2::jsonb#>>'{extraction,ocrReasoningEffort}',$2::jsonb#>>'{extraction,reasoningEffort}') ORDER BY m.sha256,ar.created_at DESC,ar.id DESC",[job.workflow_id,JSON.stringify(job.config)]);
  const caches = new Map<string,ExtractionCache>(cacheRows.rows.map(row=>[row.source_sha256,row]));
  const repairIds=job.input?.material_repair?.material_ids as string[]|undefined;
  const inputs:InputMaterial[] = materials.rows.map(material=>({...material,extraction_cache:repairIds?.includes(material.id)?undefined:caches.get(material.sha256)}));
  const config=job.config.extraction;
  const vision=createVisionClient({...process.env,ZHIPU_MODEL:job.config.model,ZHIPU_BASE_URL:job.config.base_url??process.env.ZHIPU_BASE_URL},fetch,config);
  const original=new ProjectDocumentExtractor({...process.env,ZHIPU_BASE_URL:job.config.base_url??process.env.ZHIPU_BASE_URL});
  const extractor:DocumentExtractor={extract:async(path,signal)=>{
   const material=inputs.find(item=>join(resolve(root),item.storage_path)===path);
   if(repairIds&&(!material||!repairIds.includes(material.id)))throw new Error('原件健康缓存缺失，需核对后恢复');
   return await runRevisionCall(pool,job.id,`material:${material?.id??path}`,async remaining=>{
    const bounded=remaining===undefined?signal:AbortSignal.any([AbortSignal.timeout(remaining),...(signal?[signal]:[])]);
    const result=await original.extract(path,bounded);return{...result,duration_ms:0};
   });
  }};
  publication=await withTaskSignal(cancellation.signal,()=>processor(root,job.workflow_id,job.id,inputs,vision,extractor,config));
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const current=await db.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=project_id AND p.deleted_at IS NULL) FOR UPDATE',[job.workflow_id]);
   if(current.rows[0]?.input_revision!==job.input_revision)throw new Error('任务材料版本已失效，结果未发布');
   const active=await db.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id]);
   if(!active.rowCount)throw new Error('任务已失效，结果未发布');
  for(const artifact of publication.artifacts)await db.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,material_id,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[crypto.randomUUID(),job.workflow_id,job.id,artifact.kind,artifact.storage_path,artifact.sha256,artifact.size_bytes,artifact.material_id??null,artifact.content??null]);
   const status=publication.blocked?'failed':'succeeded', error=publication.blocked?'识别或脱敏检查存在待核项，暂不可用于出题':null;
   await db.query('UPDATE ai_distill.step_attempts SET status=$2,result=$3,error=$4,finished_at=now() WHERE id=$1',[job.id,status,JSON.stringify(publication.result),error]);
   await db.query('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4,finished_at=now() WHERE workflow_id=$1 AND ordinal=2',[job.workflow_id,status,JSON.stringify(publication.result),error]);
   await db.query('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4,finished_at=now() WHERE workflow_id=$1 AND ordinal=1',[job.workflow_id,status,JSON.stringify(publication.result),error]);
   for(const m of publication.result.materials)await db.query('UPDATE ai_distill.materials SET content_type=$2,processing_status=$3 WHERE id=$1',[m.material_id,m.content_type,status==='succeeded'?'text_extracted':'received']);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  try{await clearExtractionCheckpoints(root,job.workflow_id,inputs,vision,config);}catch{console.error('已发布提取结果，但无法清理私有逐页缓存。');}
 }catch(error){
  if (publication) {
   try {
    // A lost COMMIT response may still have published artifacts. Check before deleting.
    const published=await pool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1',[job.id]);
    if (!published.rowCount) await rm(join(resolve(root),job.workflow_id,job.id),{recursive:true,force:true});
   } catch { console.error('无法确认产物是否已发布，保留文件等待核对。'); }
  }
  const message=error instanceof Error&&/^(PDF|GLM-OCR|加密|未配置|识别|脱敏|原件|任务)/.test(error.message)?error.message:'材料处理失败，请检查运行依赖和识别配置';
  const db=await pool.connect();try{await db.query('BEGIN');const current=await db.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=project_id AND p.deleted_at IS NULL) FOR UPDATE',[job.workflow_id]);const failed=await db.query("UPDATE ai_distill.step_attempts SET status='failed',error=$2,result=$3,finished_at=now() WHERE id=$1 AND status='running'",[job.id,message,error instanceof DocumentProviderError?JSON.stringify({error:{kind:error.kind,retryable:error.retryable,http_status:error.http_status}}):null]);if(failed.rowCount&&current.rows[0]?.input_revision===job.input_revision){await db.query("UPDATE ai_distill.steps SET status='failed',error=$2,finished_at=now() WHERE workflow_id=$1 AND ordinal=2 AND status='running'",[job.workflow_id,message]);await db.query("UPDATE ai_distill.steps SET status='failed',error=$2,finished_at=now() WHERE workflow_id=$1 AND ordinal=1",[job.workflow_id,message]);}await db.query('COMMIT');}catch(failure){await db.query('ROLLBACK');throw failure;}finally{db.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);}
 return true;
}
