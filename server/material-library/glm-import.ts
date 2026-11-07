/**
 * 职责：将已完成的 GLM-OCR 页级结构按原件身份导入材料库。
 * 入口：importGlmExtraction，由材料库 HTTP 路由调用；不再次调用模型。
 */
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {command} from '../materials/pdf';
import {GLM_OCR_VERSION} from '../materials/pdf-extraction/glm-ocr';
import {canonicalJson} from '../../shared/workflow-config';
import {ensurePages,hash,storeExtractedDocument} from './execution-shared';
import {assertLibraryExtractionUsable} from './jobs';
import {readLibraryBlob} from './storage';
import {readLibraryOriginalPreview} from './original-preview';
import {logEvent} from '../logging';
import {cleanScanNoisePages,findExtractionResidues} from '../../shared/scan-noise';

const conflict=(message:string)=>new HTTPException(409,{message});

export async function importGlmExtraction(pool:Pool,root:string,revisionId:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new HTTPException(400,{message:'GLM-OCR导入参数无效'});
 const request=body as Record<string,unknown>;
 if(Object.keys(request).some(key=>!['request_key','files'].includes(key))||typeof request.request_key!=='string'||!Array.isArray(request.files)||request.files.length<1||request.files.length>100)throw new HTTPException(400,{message:'GLM-OCR文件集合无效'});
 const requestKey=uuid(request.request_key),inputs=request.files as Record<string,unknown>[],ids=new Set<string>();
 for(const input of inputs){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['file_id','source_sha256','rendered_sha256','pages'].includes(key))||typeof input.file_id!=='string'||typeof input.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.source_sha256)||(input.rendered_sha256!==undefined&&(typeof input.rendered_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.rendered_sha256)))||!Array.isArray(input.pages))throw new HTTPException(400,{message:'GLM-OCR文件结构无效'});
  const id=uuid(input.file_id);if(ids.has(id))throw new HTTPException(400,{message:'GLM-OCR文件标识重复'});ids.add(id);
 }
 const digest=hash(canonicalJson({revision_id:revisionId,files:inputs})),db=await pool.connect();
 let stage='begin';
 try{
  await db.query('BEGIN');
  const identity=(await db.query('SELECT package_id FROM ai_distill.library_revisions WHERE id=$1',[revisionId])).rows[0];
  if(!identity)throw new HTTPException(404,{message:'材料版本不存在'});
  const pkg=(await db.query('SELECT id,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[identity.package_id])).rows[0];
  if(!pkg||pkg.deleted_at)throw conflict('材料包已归档');
  const revision=(await db.query('SELECT state,file_count,manifest_sha256 FROM ai_distill.library_revisions WHERE id=$1 FOR UPDATE',[revisionId])).rows[0];
  const prior=(await db.query('SELECT id,revision_id,input_digest,config_snapshot,result_summary FROM ai_distill.library_jobs WHERE package_id=$1 AND request_key=$2',[pkg.id,requestKey])).rows[0];
  if(prior){
   if(prior.revision_id!==revisionId||prior.input_digest!==digest||prior.config_snapshot?.protocol!=='glm-ocr-structured-import-v1')throw conflict('请求标识已对应其他导入内容');
   await db.query('COMMIT');return{job_id:prior.id,...prior.result_summary,reused:true};
  }
  if(revision.state!=='ready')throw conflict('请先完成材料入库');
  if((await db.query("SELECT id FROM ai_distill.library_jobs WHERE revision_id=$1 AND kind<>'prepare' AND status IN ('queued','running')",[revisionId])).rowCount)throw conflict('该版本已有活动处理任务，请先等待完成');
  const files=(await db.query(`SELECT f.id,f.original_name,b.sha256,b.size_bytes,b.storage_target,b.storage_path FROM ai_distill.library_files f JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=$1 ORDER BY f.position`,[revisionId])).rows;
  if(files.length!==Number(revision.file_count)||files.length!==inputs.length||files.some(file=>!ids.has(file.id)))throw conflict('GLM-OCR导入必须完整覆盖本版本所有文件');
  const prepared=[];
  for(const file of files){
   stage='verify_source';
   const input=inputs.find(item=>item.file_id===file.id)!;
   const isDocx=file.original_name.toLowerCase().endsWith('.docx');
   if(file.storage_target!=='local'||(!isDocx&&!file.original_name.toLowerCase().endsWith('.pdf'))||input.source_sha256!==file.sha256||Number(file.size_bytes)>50*1024*1024)throw conflict('GLM-OCR导入仅支持本机同摘要且不超过50 MiB的PDF/DOCX原件');
   const bytes=await readLibraryBlob(root,file.storage_path,file.sha256);
   if(bytes.byteLength!==Number(file.size_bytes))throw conflict('原件大小与清单不匹配');
   const rendered=isDocx?(await readLibraryOriginalPreview(pool,root,file.id)).bytes:bytes;
   if(isDocx){if(input.rendered_sha256!==createHash('sha256').update(rendered).digest('hex'))throw conflict('DOCX渲染副本摘要不符');}
   else if(input.rendered_sha256!==undefined)throw new HTTPException(400,{message:'PDF原件不应提供渲染副本摘要'});
   stage='pdfinfo';
   const directory=await mkdtemp(join(tmpdir(),'ai-distill-glm-import-'));
   let info:string;
   try{const path=join(directory,'source.pdf');await writeFile(path,rendered,{mode:0o600});info=await command(['pdfinfo',path]);}
   finally{await rm(directory,{recursive:true,force:true});}
   const pageCount=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
   if(pageCount>(isDocx?1000:200)||pageCount!==input.pages.length)throw conflict('GLM-OCR页数与原件或DOCX渲染副本不一致');
   let document;
   try{document=ensurePages(input.pages as Parameters<typeof ensurePages>[0],file.sha256);}catch{throw new HTTPException(400,{message:'GLM-OCR页级结构无法完整转换'});}
   const cleaned=cleanScanNoisePages(document.pages.map(page=>({file_id:file.id,page:page.page,blocks:page.structure!})),{englishOnlyParagraphs:true});
   const residues=findExtractionResidues(cleaned.pages);
   if(residues.length)throw conflict(`GLM-OCR正文仍有格式残留，请复核第${[...new Set(residues.map(item=>item.page))].join('、')}页`);
   assertLibraryExtractionUsable([{issues:[],pages:document.pages}]);
   const issues=document.pages.flatMap(page=>(page.issues??[]).map(kind=>({page:page.page,kind})));
   prepared.push({file,document,issues});
  }
  const jobId=randomUUID(),config={protocol:'glm-ocr-structured-import-v1',provider:'glm-ocr',ocr_version:GLM_OCR_VERSION,model_invoked:true,docx_conversion:'original-docx-pdf-v2'};
  const snapshot={protocol:config.protocol,manifest_sha256:revision.manifest_sha256,files:prepared.map(({file,document})=>({file_id:file.id,source_sha256:file.sha256,rendered_sha256:inputs.find(input=>input.file_id===file.id)?.rendered_sha256??null,page_count:document.pages.length}))};
  const summary={provider:config.provider,imported:true,model_invoked:true,file_count:prepared.length,page_count:prepared.reduce((n,p)=>n+p.document.pages.length,0),segmented_file_count:prepared.filter(p=>p.document.pages.length>100).length,issue_count:prepared.reduce((n,p)=>n+p.issues.length,0)};
  stage='insert_job';
  await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,result_summary,finished_at)
   VALUES($1,$2,$3,'extract','succeeded',$4,$5,$6::jsonb,$7,$8::jsonb,'internal','local',$9::jsonb,now())`,[jobId,pkg.id,revisionId,requestKey,digest,JSON.stringify(snapshot),hash(canonicalJson(config)),JSON.stringify(config),JSON.stringify(summary)]);
  for(const item of prepared){
   stage='store_document';
   const {blob,document}=await storeExtractedDocument(db,item.document);
   stage='insert_document';
   await db.query(`INSERT INTO ai_distill.library_documents(id,revision_id,file_id,extraction_job_id,document_blob_id,source_sha256,text_sha256,page_count,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[randomUUID(),revisionId,item.file.id,jobId,blob.id,item.file.sha256,hash(document.pages.map(page=>page.text).join('\n')),document.pages.length,JSON.stringify(item.issues)]);
  }
  await db.query('COMMIT');return{job_id:jobId,...summary,reused:false};
 }catch(error){logEvent('glm_import.failed',{level:'error',component:'material_library',failure_phase:stage,error_kind:'unknown',error_code:typeof (error as any)?.code==='string'?(error as any).code:'unknown'});try{await db.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'GLM-OCR导入回滚状态未知');}throw error;}finally{db.release();}
}
