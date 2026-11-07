/** 职责：上传仅保存独立提取任务和私有暂存文件；全部提取完成后在原发布事务创建正式包/版本/原件。
 * 入口：enqueueAtomicLibraryImport由HTTP调用，publishAtomicLibraryImport由extract发布回调调用。
 * 失败不创建正式材料行；暂存任务与原request_key保留用于对账，不自动重提取或迁移历史数据。
 */
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join,relative} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {MAX_FILE,MAX_FOLDER_BATCH,validateFile,uuid} from '../validation';
import {registerLocalJob,forgetLocalRegistrations,releaseRolledBackRegistrations} from '../execution-queue/runtime';
import {hash,jobDirectory} from './execution-shared';
import {validateLibraryPackageInput,buildLibraryManifest,type LibraryFileInput} from './service';
import {readLibraryProcessingSettings} from './settings';
import {chooseLibraryExecutor,libraryExternalExtractionTimeoutMs} from './jobs';
import {installLibraryBlob,lockLibraryBlobWrites,normalizeLibraryFilename,readLibraryBlob} from './storage';
import {MINERU_OCR_VERSION} from '../materials/pdf-extraction/mineru-cli';
import {mineruToken} from '../materials/pdf-extraction/mineru-credentials';

export async function enqueueAtomicLibraryImport(pool:Pool,root:string,requestKey:string,value:unknown,uploads:LibraryFileInput[],target?:{package_id:string;lock_version:number},requestedPdfProvider?:string){
 uuid(requestKey);if(target)uuid(target.package_id);
 const schema=(await pool.query("SELECT to_regprocedure('ai_distill.guard_atomic_library_job()') IS NOT NULL AS available")).rows[0];
 if(!schema?.available)throw new HTTPException(503,{message:'原子提取入库尚未部署：需先审核并应用054迁移及更新API/worker'});
 const input=validateLibraryPackageInput(value);
 if(!uploads.length||uploads.length>100)throw new HTTPException(400,{message:'请选择1至100份材料'});
 let total=0;
 const files=uploads.map((file,index)=>{
  const name=normalizeLibraryFilename(file.original_name),format=name.split('.').at(-1)?.toLowerCase()??'';
  const bytes=new Uint8Array(file.bytes);total+=bytes.length;
  if(bytes.length>MAX_FILE||total>MAX_FOLDER_BATCH)throw new HTTPException(413,{message:'材料包大小超过限制'});
  validateFile(new File([Buffer.from(bytes)],name),bytes);
  const redaction_mode=file.redaction_mode??'model';
  if(!['pdf','docx','txt','md','png','jpg','jpeg'].includes(format)||!['model','declared_redacted'].includes(redaction_mode)||(redaction_mode==='declared_redacted'&&format!=='docx'))throw new HTTPException(400,{message:'材料格式或脱敏声明无效'});
  const content_type=format==='pdf'?'application/pdf':format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':format==='png'?'image/png':format==='jpg'||format==='jpeg'?'image/jpeg':format==='md'?'text/markdown':'text/plain';
  return{file_id:randomUUID(),original_name:name,position:index+1,source_sha256:hash(bytes),size_bytes:bytes.length,redaction_mode,format,content_type,bytes};
 });
 if(new Set(files.map(f=>f.original_name)).size!==files.length)throw new HTTPException(400,{message:'材料文件名不能重复'});
 if(requestedPdfProvider!==undefined&&!['mineru-api','mineru-cli'].includes(requestedPdfProvider))throw new HTTPException(400,{message:'PDF OCR provider 仅支持MinerU'});
 const pdfProvider=requestedPdfProvider??process.env.PDF_EXTRACTION_PROVIDER??'mineru-api';
 if(!['mineru-api','mineru-cli'].includes(pdfProvider))throw new HTTPException(503,{message:'当前文本提取仅支持MinerU'});
 const executionTarget=process.env.ATOMIC_IMPORT_EXECUTION_TARGET??'local';
 if(executionTarget!=='local'&&executionTarget!=='server')throw new HTTPException(503,{message:'ATOMIC_IMPORT_EXECUTION_TARGET 仅支持 local 或 server'});
 const manifest=buildLibraryManifest(files.map(f=>({...f,sha256:f.source_sha256}))),requestDigest=hash({input:target?null:input,target:target??null,manifest:manifest.sha256,pdf_provider:pdfProvider,...(executionTarget==='server'?{execution_target:'server'}:{})});
 const id=randomUUID(),directory=join(jobDirectory(root,id),'import-source'),db=await pool.connect();let commitAttempted=false;
 try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`atomic-library-import:${requestKey}`]);
  const prior=(await db.query("SELECT id,status,package_id,revision_id,input_snapshot->>'request_digest' AS request_digest FROM ai_distill.library_jobs WHERE request_key=$1 AND input_snapshot ? 'atomic_import'",[requestKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)throw new HTTPException(409,{message:'相同导入请求标识对应不同文件或参数'});await db.query('COMMIT');return{id:prior.id,status:prior.status,package_id:prior.package_id,revision_id:prior.revision_id,reused:true};}
  if(target){const pkg=(await db.query('SELECT lock_version FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NULL',[target.package_id])).rows[0];if(Number(pkg?.lock_version)!==target.lock_version)throw new HTTPException(409,{message:'材料包不存在或版本已变化'});}
  const settings=(await readLibraryProcessingSettings(db,root)).processing_settings as any;
  const executor=chooseLibraryExecutor('extract',files.map(f=>({format:f.format as any,redaction_mode:f.redaction_mode})),settings.redaction,'local');
  const hasPdf=files.some(file=>file.format==='pdf'),requiresMineruNative=files.some(file=>['docx','png','jpg','jpeg'].includes(file.format));
  const pdfProviderReady=!hasPdf||Boolean(mineruToken());
  const providerReady=pdfProviderReady&&(!requiresMineruNative||Boolean(mineruToken()));
  if(executor==='api'&&!providerReady)throw new HTTPException(503,{message:'文本提取服务尚未正确配置'});
  if(executor==='api'){
   const count=files.filter(file=>['pdf','docx','png','jpg','jpeg'].includes(file.format)).length;
   settings.execution={...settings.execution,task_timeout_ms:Math.max(Number(settings.execution?.task_timeout_ms)||1200000,libraryExternalExtractionTimeoutMs(count))};
  }
  await mkdir(directory,{recursive:true,mode:0o700});
  const staged=[];
  for(const file of files){const {bytes,...metadata}=file,path=join(directory,file.file_id);await writeFile(path,bytes,{flag:'wx',mode:0o600});staged.push({...metadata,storage_path:relative(root,path)});}
  const snapshot={version:1,request_digest:requestDigest,manifest_sha256:manifest.sha256,files:staged,atomic_import:{package_id:target?.package_id??randomUUID(),revision_id:randomUUID(),package_input:input,expected_version:target?.lock_version??null}};
  const config={version:1,settings,pdf_provider:pdfProvider,pdf_ocr_version:MINERU_OCR_VERSION,...(files.some(file=>['png','jpg','jpeg'].includes(file.format))?{image_ocr_version:MINERU_OCR_VERSION}:{})};
  await db.query(`INSERT INTO ai_distill.library_jobs(id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target)
   VALUES($1,'extract','queued',$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)`,[id,requestKey,hash(snapshot),JSON.stringify(snapshot),hash(config),JSON.stringify(config),executor,executionTarget]);
  await registerLocalJob(db,id,'library',executor,'library:extract');commitAttempted=true;
  await db.query('COMMIT');forgetLocalRegistrations(db);return{id,status:'queued',package_id:null,revision_id:null,reused:false};
 }catch(error){
  await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);
  // COMMIT回执未知不能删除可能仍被任务使用的文件；按原request_key对账。
  if(!commitAttempted)await rm(jobDirectory(root,id),{recursive:true,force:true});
  throw error;
 }finally{db.release();}
}

/** 调用方已锁定running job并持有原发布事务；此函数不COMMIT，任意失败随正文和任务成功标记一起回滚。 */
export async function publishAtomicLibraryImport(db:PoolClient,root:string,job:any){
 const stage=job.input_snapshot.atomic_import;if(!stage)return;
 const packageId=stage.package_id,revisionId=stage.revision_id,files=job.input_snapshot.files as any[];
 let parent:string|null=null;
 if(stage.expected_version!==null){
  const pkg=(await db.query('SELECT current_revision_id,lock_version FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[packageId])).rows[0];
  if(Number(pkg?.lock_version)!==stage.expected_version)throw new HTTPException(409,{message:'提取期间材料包版本已改变，本次未入库'});parent=pkg.current_revision_id;
 }else{
  const p=stage.package_input;
  await db.query('INSERT INTO ai_distill.library_packages(id,name,description,tags,processing_settings) VALUES($1,$2,$3,$4,$5::jsonb)',[packageId,p.name,p.description,p.tags,JSON.stringify(job.config_snapshot.settings)]);
 }
 await db.query(`INSERT INTO ai_distill.library_revisions(id,package_id,parent_revision_id,state,manifest_sha256,file_count,source_info,request_key,request_digest)
  VALUES($1,$2,$3,'pending',$4,$5,$6::jsonb,$7,$8)`,[revisionId,packageId,parent,job.input_snapshot.manifest_sha256,files.length,JSON.stringify({kind:'atomic_import',job_id:job.id}),job.request_key,job.input_snapshot.request_digest]);
 await lockLibraryBlobWrites(db,files.map(f=>f.source_sha256));
 for(const file of files){
  const bytes=await readLibraryBlob(root,file.storage_path,file.source_sha256);
  if(hash(bytes)!==file.source_sha256||bytes.length!==file.size_bytes)throw new Error('导入暂存原件已变化');
  const blob=await installLibraryBlob(root,bytes,file.content_type,'local');
  (job.atomic_installed??=[]).push(blob);
  const created=await db.query(`INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,storage_target,storage_path)
   VALUES($1,$2,$3,$4,'file','local',$5) ON CONFLICT(sha256,storage_target) WHERE storage_kind='file' DO NOTHING RETURNING id`,[randomUUID(),blob.sha256,blob.size_bytes,blob.content_type,blob.storage_path]);
  let blobId=created.rows[0]?.id;
  if(!blobId){
   const existing=(await db.query("SELECT id,size_bytes,content_type,storage_path FROM ai_distill.library_blobs WHERE sha256=$1 AND storage_kind='file' AND storage_target='local' FOR UPDATE",[blob.sha256])).rows[0];
   if(!existing||Number(existing.size_bytes)!==blob.size_bytes)throw new Error('原件对象大小冲突');
   const textTypes=['text/plain','text/markdown'];
   if(existing.content_type!==blob.content_type&&!(textTypes.includes(existing.content_type)&&textTypes.includes(blob.content_type))&&!(blob.content_type==='application/pdf'&&['scanned','text'].includes(existing.content_type)))throw new Error('原件对象类型冲突');
   if(existing.storage_path!==blob.storage_path)await db.query('UPDATE ai_distill.library_blobs SET storage_path=$2 WHERE id=$1',[existing.id,blob.storage_path]);
   blobId=existing.id;
  }
  await db.query('INSERT INTO ai_distill.library_files(id,revision_id,blob_id,original_name,position,redaction_mode) VALUES($1,$2,$3,$4,$5,$6)',[file.file_id,revisionId,blobId,file.original_name,file.position,file.redaction_mode]);
 }
 await db.query("UPDATE ai_distill.library_revisions SET state='ready',sealed_at=now() WHERE id=$1",[revisionId]);
 await db.query('UPDATE ai_distill.library_packages SET current_revision_id=$2,lock_version=lock_version+1,updated_at=now() WHERE id=$1',[packageId,revisionId]);
 const bound=await db.query("UPDATE ai_distill.library_jobs SET package_id=$2,revision_id=$3 WHERE id=$1 AND status='running' AND package_id IS NULL AND revision_id IS NULL",[job.id,packageId,revisionId]);
 if(bound.rowCount!==1)throw new Error('导入任务发布身份已失效');
 job.package_id=packageId;job.revision_id=revisionId;
}
