/**
 * 文件职责：在已由 worker 槽位保护的执行通道中运行材料库入库、提取和脱敏任务。
 * 关键入口：`runNextLibraryJob()` 领取匹配任务；默认Agent按语义计划整包脱敏，旧字段映射仅用于历史冻结任务收尾。
 * 边界：发布库级 blob/文档/脱敏结果，入库封存 revision，任务状态由 jobs.ts 管理；外部调用以 library_job_id 关联，不创建 step_attempt。
 */
import {deferLocalPublication,readLibraryFailure,saveLibraryFailure} from '../execution-queue/runtime';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import type {LibraryExecutionTarget,LibraryExecutorKind} from '../../shared/material-library';
import {type DocumentExtractor,extractLocalDocument,ProjectDocumentExtractor} from '../materials/document';
import {MineruCliPdfExtractor} from '../materials/pdf-extraction/mineru-cli';
import {MineruApiDocxExtractor,MineruApiFirstPdfExtractor,MineruApiPdfExtractor} from '../materials/pdf-extraction/mineru-api';
import {runExternalCall} from '../external-call';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {validateFile} from '../validation';
import {finishLibraryJob,failLibraryJob,heartbeatLibraryJob,claimLibraryJob} from './jobs';
import {readLibraryBlob,insertLibraryTextBlob} from './storage';
import {hash,jobDirectory,ensurePages} from './execution-shared';
import {executeRedaction} from './redaction-runner';
import {withTaskSignal} from '../task-signal';
import {cleanupExtractionArtifacts,readExtractionCheckpoint,writeExtractionCheckpoint} from './extraction-checkpoint';
import {AGENT_REDACTION_MAX_MS} from '../../shared/redaction-templates';


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

export async function executeExtraction(pool:Pool,root:string,job:any,signal:AbortSignal,extractorOverride?:DocumentExtractor){
 const files=job.input_snapshot.files as any[],results:{item:any;document:ReturnType<typeof ensurePages>;issues:Record<string,unknown>[];textSha:string;content:string}[]=[];
 let extraction:{directory:string;extractor:DocumentExtractor}|null=null;
 for(const [index,item] of files.entries()){
  if(signal.aborted)throw new Error('材料任务已取消');
  const bytes=await sourceBytes(root,item);const cached=await readExtractionCheckpoint(root,job,item);let document=cached?.document,actualProvider=cached?.provider??'local';
  if(!document&&(item.format==='txt'||item.format==='md'))document=ensurePages(extractLocalDocument(bytes,item.format).pages,item.source_sha256);
  else if(!document){
   if(!extraction){
    if(extractorOverride){const directory=join(jobDirectory(root,job.id),'source');await mkdir(directory,{recursive:true,mode:0o700});extraction={directory,extractor:extractorOverride};}
    else extraction=await documentExtractor(root,job.id,job.config_snapshot.pdf_provider);
   }
   const path=join(extraction.directory,`${item.file_id}.${item.format}`),fileBuffer=new ArrayBuffer(bytes.byteLength);new Uint8Array(fileBuffer).set(bytes);
   try{await writeFile(path,Buffer.from(bytes),{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||hash(await readFile(path))!==item.source_sha256)throw error;}
   const extractor=extraction.extractor;
   const extracted=await runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,library_file_id:item.file_id,operation:'library_document_extract'},async()=>extractor.extract(path,signal));
   if(extracted.sha256!==item.source_sha256||extracted.format!==item.format)throw new Error('文本提取结果与原件摘要不匹配');
   document=ensurePages(extracted.pages,item.source_sha256);actualProvider=extracted.provider;
  }
  if(signal.aborted)throw signal.reason;
  await writeExtractionCheckpoint(root,job,item,document,actualProvider);
  const content=JSON.stringify(document),text= document.pages.map(page=>page.text).join('\n'),issues=document.pages.flatMap(page=>[
   ...(page.issues??[]).map(kind=>({page:page.page,kind})),
   ...(!page.text.trim()?[{page:page.page,kind:'empty_page'}]:[]),
   ...(/无法辨认|�/.test(page.text)?[{page:page.page,kind:'unreadable'}]:[]),
  ]);
  results.push({item,document,issues,textSha:hash(text),content});
  if(!await heartbeatLibraryJob(pool,job.id,job.lease_token,{phase:'extract',completed_files:index+1,total_files:files.length,issue_count:results.reduce((sum,result)=>sum+result.issues.length,0)}))throw stopReason(await libraryStopReason(pool,job)??'lease_lost');
 }
 const summaries=await finishLibraryJob(pool,job.id,job.lease_token,{file_count:results.length,page_count:results.reduce((sum,result)=>sum+result.document.pages.length,0),issue_count:results.reduce((sum,result)=>sum+result.issues.length,0)},async db=>{
  for(const result of results){
   const blob=await insertLibraryTextBlob(db,result.content,'application/vnd.ai-distill.extracted-document+json');
   await db.query(`INSERT INTO ai_distill.library_documents(id,revision_id,file_id,extraction_job_id,document_blob_id,source_sha256,text_sha256,page_count,issues)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[crypto.randomUUID(),job.revision_id,result.item.file_id,job.id,blob.id,result.item.source_sha256,result.textSha,result.document.pages.length,JSON.stringify(result.issues)]);
  }
 });
 if(summaries)await cleanupExtractionArtifacts(root,job.id);
}


/** 仅使用受控原因；数据库仍是用户取消与租约所有权的权威来源。 */
function stopReason(reason_code:string){return Object.assign(new Error(reason_code),{reason_code});}
async function libraryStopReason(pool:Pool,job:any):Promise<string|undefined>{
 const row=(await pool.query('SELECT status,cancel_requested_at,lease_token,lease_expires_at,deadline_at FROM ai_distill.library_jobs WHERE id=$1',[job.id])).rows[0];
 if(row?.status==='succeeded')return 'already_succeeded';
 if(!row||row.lease_token!==job.lease_token||row.status!=='running')return 'lease_lost';
 if(row.cancel_requested_at)return 'user_cancelled';
 if(new Date(row.deadline_at).getTime()<=Date.now())return 'deadline_exceeded';
 if(new Date(row.lease_expires_at).getTime()<=Date.now())return 'lease_lost';
 return undefined;
}

export async function runClaimedJob(pool:Pool,root:string,job:any,signal:AbortSignal,heartbeatMs=15000){
 const context={component:'material_library',operation:`library_${job.kind}`,library_package_id:job.package_id,library_revision_id:job.revision_id,library_job_id:job.id};
 const restore=enterLogContext(context);const local=new AbortController(),abort=()=>local.abort(stopReason('worker_shutdown'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const agentPlan=job.config_snapshot?.redaction_template?.workflow==='codex_plan';
 const deadline=Math.min(new Date(job.deadline_at).getTime(),Date.now()+(agentPlan?AGENT_REDACTION_MAX_MS:1800000));
 const deadlineTimer=setTimeout(()=>local.abort(stopReason(agentPlan?'agent_redaction_timeout':'deadline_exceeded')),Math.max(0,deadline-Date.now()));
 if(deadline<=Date.now())local.abort(stopReason(agentPlan?'agent_redaction_timeout':'deadline_exceeded'));
 let heartbeatRunning=false,settled=false;
 const heartbeat=setInterval(()=>{
  if(heartbeatRunning||settled)return;
  heartbeatRunning=true;
  void heartbeatLibraryJob(pool,job.id,job.lease_token).then(async active=>{
   if(!active&&!settled){
    const state=await libraryStopReason(pool,job);
    if(!settled)local.abort(stopReason(state??'lease_lost'));
   }
  }).catch(error=>{
   if(settled)return;
   logEvent('heartbeat.write_failed',{level:'error',...classifyLogError(error)});
   local.abort(stopReason('heartbeat_unavailable'));
  }).finally(()=>{heartbeatRunning=false;});
 },heartbeatMs);
 try{
  logEvent('library_job.started',{level:'info',state:'running',provider:job.executor_kind==='api'?job.config_snapshot.settings?.redaction?.api?.provider:job.executor_kind==='agent'?'codex':undefined,material_count:job.input_snapshot.files?.length??0});
  if(local.signal.aborted)throw local.signal.reason;
  await withTaskSignal(local.signal,async()=>{
   if(job.kind==='intake')await executeIntake(pool,root,job,local.signal);
   else if(job.kind==='extract')await executeExtraction(pool,root,job,local.signal);
   else await executeRedaction(pool,root,job,local.signal);
  });
  logEvent('library_job.completed',{level:'info',state:'succeeded'});
 }catch(error){
  deferLocalPublication(error);
  const classified=classifyLogError(error);
  const reason=local.signal.aborted?local.signal.reason:error;
  const hasReasonCode=reason&&typeof reason==='object'&&typeof reason.reason_code==='string';
  let code=hasReasonCode?reason.reason_code:classified.reason_code??classified.error_kind??'library_job_failed';
  if(!local.signal.aborted&&!hasReasonCode){
   try{code=await libraryStopReason(pool,job)??code;}catch(readError){logEvent('library_job.stop_state_unavailable',{level:'error',...classifyLogError(readError)});}
  }
  if(code==='already_succeeded'){logEvent('library_job.completion_confirmed',{level:'info',state:'succeeded'});return;}
  if(!/^[a-z][a-z0-9_]{0,79}$/.test(code))code='library_job_failed';
  const cancelled=code==='user_cancelled'||code==='worker_shutdown';
  const message=code==='agent_redaction_timeout'?'Agent脱敏达到执行预算（最多10分钟），已停止并保留私有进度':cancelled?'材料任务已取消或 worker 已停止':code==='deadline_exceeded'?'材料任务达到本次执行期限':code==='heartbeat_unavailable'?'材料任务心跳不可用，已停止发布':'材料任务执行失败，请检查处理记录和服务配置';
  const failure=saveLibraryFailure({lease_token:job.lease_token,code,message,status:cancelled?'cancelled':'failed'});
  const saved=await failLibraryJob(pool,job.id,failure.lease_token,failure.code,failure.message,failure.status);
  if(!saved){logEvent('library_job.terminal_not_written',{level:'error',reason_code:code,state:'unknown'});return;}
  logEvent(cancelled?'library_job.cancelled':'library_job.failed',{level:cancelled?'info':'error',state:cancelled?'cancelled':'failed',error_kind:classified.error_kind,reason_code:code,retryable:classified.retryable});
  if(cancelled)console.info('材料库任务已取消或 worker 已停止');else console.error('材料库任务失败；未输出原文、提示词或凭证');
 }finally{settled=true;clearInterval(heartbeat);clearTimeout(deadlineTimer);signal.removeEventListener('abort',abort);restore();}
}

/** runWorkerPool 的并发循环先取得槽位，再调用本函数领取任务。 */
export async function runNextLibraryJob(pool:Pool,root:string,executor:LibraryExecutorKind,target:LibraryExecutionTarget,signal:AbortSignal,onlyJobId?:string){
 if(signal.aborted)return false;
 const failure=readLibraryFailure();
 if(failure){
  // 只按原租约结算已知终态；不重新领取、不延长预算、不再读取原件或调用处理器。
  if(!onlyJobId)throw new Error('材料失败恢复缺少明确任务ID');
  await failLibraryJob(pool,onlyJobId,failure.lease_token,failure.code,failure.message,failure.status);
  return true;
 }
 const job=await claimLibraryJob(pool,executor,target,onlyJobId);
 if(!job)return false;
 await withLogContext({component:'material_library',library_package_id:job.package_id,library_revision_id:job.revision_id,library_job_id:job.id,operation:`library_${job.kind}`},()=>runClaimedJob(pool,root,job,signal));
 return true;
}
