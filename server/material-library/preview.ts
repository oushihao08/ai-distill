/**
 * 职责：按材料文件、提取任务或脱敏结果身份读取预览，禁止任意 blob 读取。
 * 入口：readLibraryOriginal/readLibraryDocuments/readLibraryRedactionPreview 供本地材料库路由调用；
 * 所有正文按需返回，原件与数据库文本均复核摘要，不返回存储路径或任务配置。
 */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {readLibraryBlob} from './storage';
import {documentBlocksToText} from '../materials/pdf';

const conflict=(message:string)=>new HTTPException(409,{message});
const missing=()=>new HTTPException(404,{message:'材料预览不存在'});
function checkedText(content:unknown,sha:unknown){
 if(typeof content!=='string'||typeof sha!=='string'||createHash('sha256').update(content).digest('hex')!==sha)throw conflict('材料预览摘要校验失败');
 if(Buffer.byteLength(content)>4*1024*1024)throw new HTTPException(413,{message:'正文超过预览大小限制，请通过成果导出查看'});
 return content;
}

export async function readLibraryOriginal(pool:Pool,root:string,fileId:string){
 const row=(await pool.query(`SELECT f.original_name,b.storage_path,b.storage_target,b.sha256,b.size_bytes,b.content_type
  FROM ai_distill.library_files f JOIN ai_distill.library_revisions r ON r.id=f.revision_id
  JOIN ai_distill.library_packages p ON p.id=r.package_id AND p.deleted_at IS NULL
  JOIN ai_distill.library_blobs b ON b.id=f.blob_id AND b.storage_kind='file' WHERE f.id=$1`,[fileId])).rows[0];
 if(!row)throw missing();
 const target=process.env.MATERIAL_EXECUTION_TARGET==='server'?'server':'local';
 if(row.storage_target!==target)throw conflict('原件不在当前运行端，请在原件所在端查看');
 const bytes=await readLibraryBlob(root,row.storage_path,row.sha256);
 if(bytes.byteLength!==Number(row.size_bytes))throw conflict('材料原件大小校验失败');
 return{bytes,name:String(row.original_name),content_type:String(row.content_type)};
}

export async function readLibraryDocuments(pool:Pool,revisionId:string,jobId:string,fileId?:string){
 const valid=(await pool.query(`SELECT j.id FROM ai_distill.library_jobs j
  JOIN ai_distill.library_revisions r ON r.id=j.revision_id JOIN ai_distill.library_packages p ON p.id=r.package_id AND p.deleted_at IS NULL
  WHERE j.id=$1 AND j.revision_id=$2 AND j.kind='extract' AND j.status='succeeded'`,[jobId,revisionId])).rows[0];
 if(!valid)throw missing();
 const rows=(await pool.query(`SELECT d.id,d.file_id,f.original_name,d.page_count,d.issues,d.text_sha256,
  ${fileId?'b.sha256,b.text_content':'NULL AS sha256,NULL AS text_content'} FROM ai_distill.library_documents d
  JOIN ai_distill.library_files f ON f.id=d.file_id AND f.revision_id=d.revision_id
  JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id AND b.storage_kind='database_text'
  WHERE d.revision_id=$1 AND d.extraction_job_id=$2 AND ($3::uuid IS NULL OR d.file_id=$3) ORDER BY f.position`,[revisionId,jobId,fileId??null])).rows;
 if(fileId&&!rows.length)throw missing();
 return{items:rows.map(({text_content,sha256,text_sha256,...row})=>{
  if(!fileId)return row;
  let document:any;
  try{document=JSON.parse(checkedText(text_content,sha256));}catch(error){if(error instanceof HTTPException)throw error;throw conflict('材料提取结构无效');}
  if(document?.version!==1||!Array.isArray(document.pages)||document.pages.some((page:any)=>typeof page?.text!=='string')||createHash('sha256').update(document.pages.map((page:any)=>page.text).join('\n')).digest('hex')!==text_sha256)throw conflict('材料提取正文校验失败');
  return{...row,pages:document.pages.map((page:any)=>({page:page.page,text:page.text,issues:page.issues??[]}))};
 })};
}

export async function readLibraryRedactionPreview(pool:Pool,redactionId:string,fileId?:string){
 const row=(await pool.query(`SELECT r.id,r.package_id,r.revision_id,r.extraction_job_id,r.redaction_job_id,r.validation_report,r.output_digest,b.text_content,b.sha256,
  ${fileId?'i.text_content AS index_content,i.sha256 AS index_sha256':'NULL AS index_content,NULL AS index_sha256'}
  FROM ai_distill.library_redactions r JOIN ai_distill.library_packages p ON p.id=r.package_id AND p.deleted_at IS NULL
  JOIN ai_distill.library_jobs j ON j.id=r.redaction_job_id AND j.kind='redact' AND j.status='succeeded'
  JOIN ai_distill.library_blobs b ON b.id=r.markdown_blob_id AND b.storage_kind='database_text'
  JOIN ai_distill.library_blobs i ON i.id=r.index_blob_id AND i.storage_kind='database_text' WHERE r.id=$1`,[redactionId])).rows[0];
 if(!row)throw missing();
 const {text_content,sha256,index_content,index_sha256,...metadata}=row;
 const markdown=checkedText(text_content,sha256);
 if(!fileId)return{...metadata,markdown};
 let index:any;
 try{index=JSON.parse(checkedText(index_content,index_sha256));}catch(error){if(error instanceof HTTPException)throw error;throw conflict('脱敏结构索引无效');}
 if(index.format!=='redacted-index-v2'||index.redacted_sha256!==sha256||!Array.isArray(index.materials))throw conflict('脱敏正文与结构索引不一致');
 const file=index.materials.find((item:any)=>item.material_id===fileId);
 if(!file||!Array.isArray(file.document?.pages))throw missing();
 if(createHash('sha256').update(JSON.stringify(file.document)).digest('hex')!==file.structure_sha256)throw conflict('脱敏文件结构摘要校验失败');
 const pages=file.document.pages.map((page:any)=>({page:page.page,text:documentBlocksToText(page.blocks),issues:page.issues??[]}));
 if(pages.map((page:any)=>page.text).join('\n\n')!==file.markdown)throw conflict('脱敏文件结构与正文不一致');
 return{...metadata,file_id:fileId,pages};
}
