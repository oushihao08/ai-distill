/**
 * 文件职责：在已由 worker 槽位保护的执行通道中运行材料库入库、提取和脱敏任务。
 * 关键入口：`runNextLibraryJob()` 领取一个匹配 executor/target 的 job；提取与结构处理复用 materials 模块，脱敏复用现有字段映射算法。
 * 边界：发布库级 blob/文档/脱敏结果，入库封存 revision，任务状态由 jobs.ts 管理；外部调用以 library_job_id 关联，不创建 step_attempt。
 */
import {createHash} from 'node:crypto';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import type {LibraryExecutionTarget,LibraryExecutorKind} from '../../shared/material-library';
import {canonicalJson} from '../../shared/workflow-config';
import {documentBlocksToText,type Page} from '../materials/pdf';
import {extractLocalDocument,ProjectDocumentExtractor} from '../materials/document';
import {MineruCliPdfExtractor} from '../materials/pdf-extraction/mineru-cli';
import {MineruApiDocxExtractor,MineruApiFirstPdfExtractor,MineruApiPdfExtractor} from '../materials/pdf-extraction/mineru-api';
import {redactExtractedMaterials,renderRedactedMaterials,type ExtractedMaterial,type RedactedMaterial} from '../materials/redaction';
import {validateRedactionConfig,type RedactionConfig} from '../materials/redaction-config';
import {resolveRedactionExecution} from '../materials/redaction-execution';
import {runAgent} from '../agent';
import {createModelApiClient} from '../llm-api';
import {runExternalCall} from '../external-call';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {validateFile} from '../validation';
import {assertLibraryExtractionUsable,finishLibraryJob,failLibraryJob,heartbeatLibraryJob,claimLibraryJob} from './jobs';
import {readLibraryBlob} from './storage';

const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonicalJson(value)).digest('hex');
const jobDirectory=(root:string,id:string)=>join(resolve(root),'material-library','jobs',id);

async function insertTextBlob(db:PoolClient,content:string,contentType:string){
 const sha256=hash(content),size=Buffer.byteLength(content);
 const inserted=await db.query(`INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,text_content)
  VALUES($1,$2,$3,$4,'database_text',$5) ON CONFLICT(sha256,content_type) WHERE storage_kind='database_text' DO NOTHING RETURNING id`,[crypto.randomUUID(),sha256,size,contentType,content]);
 if(inserted.rows[0]?.id)return{id:inserted.rows[0].id,sha256,size_bytes:size};
 const existing=(await db.query("SELECT id,text_content,size_bytes FROM ai_distill.library_blobs WHERE sha256=$1 AND content_type=$2 AND storage_kind='database_text'",[sha256,contentType])).rows[0];
 if(!existing||existing.text_content!==content||Number(existing.size_bytes)!==size)throw new Error('材料文本对象摘要冲突');
 return{id:existing.id,sha256,size_bytes:size};
}

function ensurePages(pages:Page[],sourceSha:string){
 if(!Array.isArray(pages)||!pages.length||pages.some((page,index)=>!page||page.page!==index+1||typeof page.text!=='string'||!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text||!['text','ocr'].includes(page.method)))throw new Error('提取结果结构无效');
 return{version:1,source_sha256:sourceSha,pages};
}

async function sourceBytes(root:string,item:any){
 const bytes=await readLibraryBlob(root,item.storage_path,item.source_sha256);
 if(bytes.byteLength!==Number(item.size_bytes))throw new Error('材料原件大小与清单不匹配');
 const fileBuffer=new ArrayBuffer(bytes.byteLength);new Uint8Array(fileBuffer).set(bytes);
 const file=new File([fileBuffer],item.original_name);validateFile(file,bytes);
 return bytes;
}

async function executeIntake(pool:Pool,root:string,job:any,signal:AbortSignal){
 const files=job.input_snapshot.files as any[];
 let total=0;
 for(const [index,item] of files.entries()){
  if(signal.aborted)throw new Error('材料任务已取消');
  const bytes=await sourceBytes(root,item);total+=bytes.byteLength;
  const current=(await pool.query(`SELECT f.id,b.sha256,b.size_bytes,b.storage_path FROM ai_distill.library_files f JOIN ai_distill.library_blobs b ON b.id=f.blob_id
   WHERE f.id=$1 AND f.revision_id=$2`,[item.file_id,job.revision_id])).rows[0];
  if(!current||current.sha256!==item.source_sha256||Number(current.size_bytes)!==bytes.byteLength||current.storage_path!==item.storage_path)throw new Error('入库来源清单已变化');
  await heartbeatLibraryJob(pool,job.id,job.lease_token,{phase:'intake',completed_files:index+1,total_files:files.length,verified_bytes:total});
 }
 await finishLibraryJob(pool,job.id,job.lease_token,{file_count:files.length,total_bytes:total,manifest_sha256:job.input_snapshot.manifest_sha256},async db=>{
  const sealed=await db.query("UPDATE ai_distill.library_revisions SET state='ready',sealed_at=now() WHERE id=$1 AND package_id=$2 AND state='pending' AND manifest_sha256=$3 AND file_count=$4 RETURNING id",[job.revision_id,job.package_id,job.input_snapshot.manifest_sha256,files.length]);
  if(sealed.rowCount!==1)throw new Error('文件集合无法封存');
 });
}

async function documentExtractor(root:string,jobId:string,provider:unknown){
 if(!process.env.MINERU_KEY?.trim())throw new HTTPException(503,{message:'文本提取服务未配置'});
 if(provider!=='mineru-api'&&provider!=='mineru-cli')throw new HTTPException(409,{message:'提取任务缺少冻结供应商，请创建新的提取任务'});
 const cli=new MineruCliPdfExtractor(process.env);
 const pdf=provider==='mineru-cli'?cli:new MineruApiFirstPdfExtractor(new MineruApiPdfExtractor(process.env),cli);
 const extractor=new ProjectDocumentExtractor(pdf,new MineruApiDocxExtractor(process.env));
 const directory=join(jobDirectory(root,jobId),'source');
 await mkdir(directory,{recursive:true,mode:0o700});
 return{directory,extractor};
}

async function executeExtraction(pool:Pool,root:string,job:any,signal:AbortSignal){
 const files=job.input_snapshot.files as any[],results:{item:any;document:ReturnType<typeof ensurePages>;issues:Record<string,unknown>[];textSha:string;content:string}[]=[];
 const apiFiles=files.filter(item=>['pdf','docx'].includes(item.format));
 const extraction=apiFiles.length?await documentExtractor(root,job.id,job.config_snapshot.pdf_provider):null;
 for(const [index,item] of files.entries()){
  if(signal.aborted)throw new Error('材料任务已取消');
  const bytes=await sourceBytes(root,item);let document:ReturnType<typeof ensurePages>;
  if(item.format==='txt'||item.format==='md')document=ensurePages(extractLocalDocument(bytes,item.format).pages,item.source_sha256);
  else{
   if(!extraction)throw new Error('PDF/DOCX提取器未初始化');
   const path=join(extraction.directory,`${item.file_id}.${item.format}`),fileBuffer=new ArrayBuffer(bytes.byteLength);new Uint8Array(fileBuffer).set(bytes);
   await writeFile(path,Buffer.from(bytes),{mode:0o600,flag:'wx'});
   const extracted=await runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,library_file_id:item.file_id,operation:'library_document_extract'},async()=>extraction.extractor.extract(path,signal));
   if(extracted.sha256!==item.source_sha256||extracted.format!==item.format)throw new Error('文本提取结果与原件摘要不匹配');
   document=ensurePages(extracted.pages,item.source_sha256);
  }
  const content=JSON.stringify(document),text= document.pages.map(page=>page.text).join('\n'),issues=document.pages.flatMap(page=>[
   ...(page.issues??[]).map(kind=>({page:page.page,kind})),
   ...(!page.text.trim()?[{page:page.page,kind:'empty_page'}]:[]),
   ...(/无法辨认|�/.test(page.text)?[{page:page.page,kind:'unreadable'}]:[]),
  ]);
  results.push({item,document,issues,textSha:hash(text),content});
  await heartbeatLibraryJob(pool,job.id,job.lease_token,{phase:'extract',completed_files:index+1,total_files:files.length,issue_count:results.reduce((sum,result)=>sum+result.issues.length,0)});
 }
 const summaries=await finishLibraryJob(pool,job.id,job.lease_token,{file_count:results.length,page_count:results.reduce((sum,result)=>sum+result.document.pages.length,0),issue_count:results.reduce((sum,result)=>sum+result.issues.length,0)},async db=>{
  for(const result of results){
   const blob=await insertTextBlob(db,result.content,'application/vnd.ai-distill.extracted-document+json');
   await db.query(`INSERT INTO ai_distill.library_documents(id,revision_id,file_id,extraction_job_id,document_blob_id,source_sha256,text_sha256,page_count,issues)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[crypto.randomUUID(),job.revision_id,result.item.file_id,job.id,blob.id,result.item.source_sha256,result.textSha,result.document.pages.length,JSON.stringify(result.issues)]);
  }
 });
 if(summaries)await rm(jobDirectory(root,job.id),{recursive:true,force:true});
}

async function readExtractedDocuments(pool:Pool,job:any){
 const rows=(await pool.query(`SELECT d.file_id,d.document_blob_id,d.source_sha256,d.text_sha256,d.issues,b.sha256 AS blob_sha256,b.text_content,
  f.original_name,f.position,f.redaction_mode,lf.sha256 AS current_source_sha
  FROM ai_distill.library_documents d JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id JOIN ai_distill.library_files f ON f.id=d.file_id AND f.revision_id=d.revision_id
  JOIN ai_distill.library_blobs lf ON lf.id=f.blob_id WHERE d.extraction_job_id=$1 ORDER BY f.position`,[job.input_snapshot.extraction_job_id])).rows;
 const files=job.input_snapshot.files as any[];
 if(rows.length!==files.length)throw new Error('提取文档集合不完整');
 return rows.map(row=>{
  if(row.current_source_sha!==row.source_sha256||hash(row.text_content)!==row.blob_sha256||row.blob_sha256!==files.find(item=>item.file_id===row.file_id)?.document_sha256)throw new Error('提取文档摘要校验失败');
  const parsed=JSON.parse(row.text_content);
  if(parsed.version!==1||parsed.source_sha256!==row.source_sha256||!Array.isArray(parsed.pages))throw new Error('提取文档格式无效');
  const pages=ensurePages(parsed.pages,row.source_sha256).pages;
  if(hash(pages.map((page:Page)=>page.text).join('\n'))!==row.text_sha256)throw new Error('提取正文摘要校验失败');
  return{file_id:row.file_id,original_name:row.original_name,position:row.position,redaction_mode:row.redaction_mode,source_sha256:row.source_sha256,pages,issues:row.issues as Record<string,unknown>[]};
 });
}

async function executeRedaction(pool:Pool,root:string,job:any,signal:AbortSignal){
 const documents=await readExtractedDocuments(pool,job),settings=job.config_snapshot.settings;
 // 旧队列可能早于派发前检查；在任何收费调用之前按相同门槛再次核对。
 assertLibraryExtractionUsable(documents);
 const pending=documents.filter(document=>document.redaction_mode!=='declared_redacted'),declared=documents.filter(document=>document.redaction_mode==='declared_redacted');
 const modelMaterials:ExtractedMaterial[]=pending.map(document=>({material_id:document.file_id,source_sha256:document.source_sha256,pages:document.pages}));
 let config:RedactionConfig|null=null,modelOutput:any=null;
 if(pending.length){
  config=validateRedactionConfig(settings.redaction);
  const dir=join(jobDirectory(root,job.id),'private');
  modelOutput=await redactExtractedMaterials({directory:dir,checkpointDirectory:dir,materials:modelMaterials,config,signal,execution:resolveRedactionExecution({task_timeout_ms:settings.execution.task_timeout_ms,request_timeout_ms:settings.execution.request_timeout_ms}),
   execute:options=>runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,operation:'library_redaction_agent'},call_id=>runAgent({...options,call_id})),
   executeApi:(request,operation)=>runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,operation},async call_id=>{
    try{return{...await createModelApiClient().complete({...request,call_id}),call_id};}catch(error){if(error instanceof Error)Object.assign(error,{call_id});throw error;}
   }),
  });
 }
 const redactedByFile=new Map<string,RedactedMaterial>((modelOutput?.materials??[]).map((item:RedactedMaterial)=>[item.material_id,item]));
 const composed:RedactedMaterial[]=documents.map(document=>{
  if(document.redaction_mode==='declared_redacted')return{material_id:document.file_id,pages:document.pages.map(page=>({page:page.page,text:page.text,structure:page.structure,issues:page.issues}))};
  const material=redactedByFile.get(document.file_id);if(!material)throw new Error('脱敏结果缺少材料附件');return material;
 });
 const rendered=renderRedactedMaterials(composed),markdownSha=hash(rendered.markdown),indexSha=hash(rendered.index),sourceDigest=job.input_digest;
 const validationReport={usable_for_question:true,file_count:documents.length,page_count:documents.reduce((sum,document)=>sum+document.pages.length,0),extraction_issue_count:documents.reduce((sum,document)=>sum+document.issues.length,0),extraction_issues:documents.filter(document=>document.issues.length).map(document=>({file_id:document.file_id,issues:document.issues})),content_validation_scope:'extracted_source_to_redacted_body',declared_redacted_count:declared.length,protocol:'attachment-field-redaction-v32',field_mapping_validation:'passed',markdown_sha256:markdownSha,index_sha256:indexSha};
 const outputDigest=hash({protocol:'library-redaction-output-v1',package_id:job.package_id,revision_id:job.revision_id,extraction_job_id:job.input_snapshot.extraction_job_id,markdown_sha256:markdownSha,index_sha256:indexSha});
 const summary=await finishLibraryJob(pool,job.id,job.lease_token,{file_count:documents.length,page_count:validationReport.page_count,usable_for_question:validationReport.usable_for_question,output_digest:outputDigest,model_provider:config?.provider??'declared',model:config?.provider==='api'?config.api.model:config?.model??'none',usage:modelOutput?.usage??null,duration_ms:modelOutput?.duration_ms??0},async db=>{
  const markdown=await insertTextBlob(db,rendered.markdown,'text/markdown; charset=utf-8'),index=await insertTextBlob(db,rendered.index,'application/vnd.ai-distill.redacted-index+json');
  await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[crypto.randomUUID(),job.package_id,job.revision_id,job.input_snapshot.extraction_job_id,job.id,markdown.id,index.id,sourceDigest,outputDigest,JSON.stringify(validationReport)]);
 });
 if(summary)await rm(jobDirectory(root,job.id),{recursive:true,force:true});
}

async function runClaimedJob(pool:Pool,root:string,job:any,signal:AbortSignal){
 const context={component:'material_library',operation:`library_${job.kind}`,library_package_id:job.package_id,library_revision_id:job.revision_id,library_job_id:job.id};
 const restore=enterLogContext(context);const local=new AbortController(),abort=()=>local.abort(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 let heartbeatRunning=false;
 const heartbeat=setInterval(()=>{if(heartbeatRunning)return;heartbeatRunning=true;void heartbeatLibraryJob(pool,job.id,job.lease_token).then(active=>{if(!active)local.abort(Object.assign(new Error('材料任务租约、取消或期限校验失败'),{reason_code:'library_job_inactive'}));}).catch(error=>{logEvent('heartbeat.write_failed',{level:'error',...classifyLogError(error)});local.abort(error);}).finally(()=>{heartbeatRunning=false;});},15000);
 try{
  logEvent('library_job.started',{level:'info',state:'running',provider:job.executor_kind==='api'?job.config_snapshot.settings?.redaction?.api?.provider:job.executor_kind==='agent'?'codex':undefined,material_count:job.input_snapshot.files?.length??0});
  if(job.kind==='intake')await executeIntake(pool,root,job,local.signal);
  else if(job.kind==='extract')await executeExtraction(pool,root,job,local.signal);
  else await executeRedaction(pool,root,job,local.signal);
  logEvent('library_job.completed',{level:'info',state:'succeeded'});
 }catch(error){
  const cancelled=local.signal.aborted||signal.aborted,classified=classifyLogError(error),code=cancelled?'cancelled':(error&&typeof error==='object'&&'reason_code'in error&&typeof error.reason_code==='string'?error.reason_code:classified.reason_code??classified.error_kind??'library_job_failed');
  const message=cancelled?'材料任务已取消或 worker 已停止':code==='library_extraction_not_usable'?'提取结果缺少有效文件、页数或正文，请先完成文本识别':code==='configuration'?'材料处理配置无效':code==='worker_interrupted'?'材料处理进程中断，可创建新尝试':'材料任务执行失败，请检查处理记录和服务配置';
  await failLibraryJob(pool,job.id,job.lease_token,code,message,cancelled?'cancelled':'failed');
  logEvent(cancelled?'library_job.cancelled':'library_job.failed',{level:cancelled?'info':'error',state:cancelled?'cancelled':'failed',error_kind:classified.error_kind,reason_code:code,retryable:classified.retryable});
  if(cancelled)console.info('材料库任务已取消或 worker 已停止');else console.error('材料库任务失败；未输出原文、提示词或凭证');
 }finally{clearInterval(heartbeat);signal.removeEventListener('abort',abort);restore();}
}

/** runWorkerPool 的并发循环先取得槽位，再调用本函数领取任务。 */
export async function runNextLibraryJob(pool:Pool,root:string,executor:LibraryExecutorKind,target:LibraryExecutionTarget,signal:AbortSignal){
 if(signal.aborted)return false;
 const job=await claimLibraryJob(pool,executor,target);
 if(!job)return false;
 await withLogContext({component:'material_library',library_package_id:job.package_id,library_revision_id:job.revision_id,library_job_id:job.id,operation:`library_${job.kind}`},()=>runClaimedJob(pool,root,job,signal));
 return true;
}
