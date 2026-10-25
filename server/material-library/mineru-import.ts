/** 职责：通过材料库HTTP入口导入MinerU桌面端content_list，复用结构转换与存储；不重跑OCR或改变原件。
 * 入口：importMineruExtraction；完整同版本文件集合、原件摘要/页数校验后在单事务发布，并按request_key恢复。
 */
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {command} from '../materials/pdf';
import {parseMineruJson} from '../materials/pdf-extraction/mineru-cli';
import {canonicalJson} from '../../shared/workflow-config';
import {ensurePages,hash,storeExtractedDocument} from './execution-shared';
import {assertLibraryExtractionUsable} from './jobs';
import {readLibraryBlob} from './storage';

const conflict=(message:string)=>new HTTPException(409,{message});
export async function importMineruExtraction(pool:Pool,root:string,revisionId:string,body:any){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['request_key','files'].includes(k)))throw new HTTPException(400,{message:'MinerU导入参数无效'});
 const requestKey=uuid(body.request_key);
 if(!Array.isArray(body.files)||!body.files.length||body.files.length>100)throw new HTTPException(400,{message:'请提供完整的MinerU文件集合'});
 const ids=new Set<string>();
 for(const file of body.files){
  if(!file||typeof file!=='object'||Object.keys(file).some(k=>!['file_id','source_sha256','page_count','content_list'].includes(k))||!Array.isArray(file.content_list)||!Number.isInteger(file.page_count)||file.page_count<1||typeof file.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.source_sha256))throw new HTTPException(400,{message:'MinerU文件结构、页数或摘要无效'});
  uuid(file.file_id);if(ids.has(file.file_id))throw new HTTPException(400,{message:'MinerU文件标识重复'});ids.add(file.file_id);
 }
 const digest=hash(canonicalJson({revision_id:revisionId,files:body.files})),db=await pool.connect();
 try{
  await db.query('BEGIN');
  const identity=(await db.query('SELECT package_id FROM ai_distill.library_revisions WHERE id=$1',[revisionId])).rows[0];
  if(!identity)throw new HTTPException(404,{message:'材料版本不存在'});
  const pkg=(await db.query('SELECT id,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[identity.package_id])).rows[0];
  if(!pkg||pkg.deleted_at)throw conflict('材料包已归档');
  const revision=(await db.query('SELECT state,file_count,manifest_sha256 FROM ai_distill.library_revisions WHERE id=$1 FOR UPDATE',[revisionId])).rows[0];
  const prior=(await db.query('SELECT id,revision_id,input_digest,config_snapshot,result_summary FROM ai_distill.library_jobs WHERE package_id=$1 AND request_key=$2',[pkg.id,requestKey])).rows[0];
  if(prior){
   if(prior.revision_id!==revisionId||prior.input_digest!==digest||prior.config_snapshot?.protocol!=='mineru-desktop-import-v1')throw conflict('请求标识已对应其他导入内容');
   await db.query('COMMIT');return{job_id:prior.id,...prior.result_summary,reused:true};
  }
  if(revision.state!=='ready')throw conflict('请先完成材料入库');
  if((await db.query("SELECT id FROM ai_distill.library_jobs WHERE revision_id=$1 AND status IN ('queued','running')",[revisionId])).rowCount)throw conflict('该版本已有活动处理任务，请先等待完成');
  const files=(await db.query(`SELECT f.id,f.original_name,b.sha256,b.size_bytes,b.storage_target,b.storage_path FROM ai_distill.library_files f JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=$1 ORDER BY f.position`,[revisionId])).rows;
  if(files.length!==Number(revision.file_count)||files.length!==body.files.length||files.some(f=>!ids.has(f.id)))throw conflict('MinerU导入必须完整覆盖本版本所有文件');
  const prepared=[];
  for(const file of files){
   const input=body.files.find((f:any)=>f.file_id===file.id);
   if(file.storage_target!=='local'||!file.original_name.toLowerCase().endsWith('.pdf')||input.source_sha256!==file.sha256)throw conflict('MinerU导入仅支持本机同摘要PDF原件');
   const bytes=await readLibraryBlob(root,file.storage_path,file.sha256);
   if(bytes.byteLength!==Number(file.size_bytes))throw conflict('原件大小与清单不匹配');
   const info=await command(['pdfinfo',resolve(root,file.storage_path)]);
   const pageCount=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
   if(pageCount!==input.page_count)throw conflict('MinerU页数与PDF原件不一致');
   let document;
   try{document=ensurePages(parseMineruJson(input.content_list,pageCount),file.sha256);}catch{throw new HTTPException(400,{message:'MinerU content_list结构无法完整转换'});}
   assertLibraryExtractionUsable([{issues:[],pages:document.pages}]);
   const issues=document.pages.flatMap(p=>(p.issues??[]).map(kind=>({page:p.page,kind})));
   prepared.push({file,document,issues,content_list_sha256:hash(canonicalJson(input.content_list))});
  }
  const jobId=randomUUID(),config={protocol:'mineru-desktop-import-v1',provider:'mineru-desktop',model_invoked:false};
  const snapshot={protocol:config.protocol,manifest_sha256:revision.manifest_sha256,files:prepared.map(p=>({file_id:p.file.id,source_sha256:p.file.sha256,content_list_sha256:p.content_list_sha256,page_count:p.document.pages.length}))};
  const summary={provider:config.provider,imported:true,model_invoked:false,file_count:prepared.length,page_count:prepared.reduce((n,p)=>n+p.document.pages.length,0),issue_count:prepared.reduce((n,p)=>n+p.issues.length,0)};
  await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,result_summary,finished_at)
   VALUES($1,$2,$3,'extract','succeeded',$4,$5,$6::jsonb,$7,$8::jsonb,'internal','local',$9::jsonb,now())`,[jobId,pkg.id,revisionId,requestKey,digest,JSON.stringify(snapshot),hash(canonicalJson(config)),JSON.stringify(config),JSON.stringify(summary)]);
  for(const p of prepared){
   const {blob,document}=await storeExtractedDocument(db,p.document);
   await db.query(`INSERT INTO ai_distill.library_documents(id,revision_id,file_id,extraction_job_id,document_blob_id,source_sha256,text_sha256,page_count,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[randomUUID(),revisionId,p.file.id,jobId,blob.id,p.file.sha256,hash(document.pages.map(page=>page.text).join('\n')),document.pages.length,JSON.stringify(p.issues)]);
  }
  await db.query('COMMIT');return{job_id:jobId,...summary,reused:false};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'MinerU导入回滚状态未知');}throw error;}finally{db.release();}
}
