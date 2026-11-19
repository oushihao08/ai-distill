/**
 * 职责：按原件 SHA-256 读取成功材料结果，供提取、脱敏、整理执行器在收费调用前复用。
 * 边界：只读成功产物；部分重合不复用整包；ID 按当前来源重绑，不复制任务归属或租约。
 */
import type {Pool,PoolClient} from 'pg';
import {hash,ensurePages} from './execution-shared';
import {materialSetSignature} from './uses';
import {logEvent,classifyLogError} from '../logging';
import type {PreparationUnit} from '../../shared/material-preparation-result';

type Db=Pick<Pool|PoolClient,'query'>;
type FileIdentity={id:string;sha256:string;size_bytes:number|string;image_review_required?:boolean};
export type ReusedImageCandidate={id:string;page:number;position:number;sha256:string;blob_id:string;role?:string};
export type ReusedExtraction={document:ReturnType<typeof ensurePages>;provider:string;source_job_id?:string;image_candidates?:ReusedImageCandidate[]};

/** EXCEPT 比较完整集合，忽略名称、顺序和相同文件的重复份数；不是交集命中即判重。 */
export function sameOriginalSetSql(revisionExpression:string,targetParameter='$1'){
 const files=(revision:string)=>`SELECT b.sha256,b.size_bytes FROM ai_distill.library_files f JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=${revision}`;
 return `NOT EXISTS((${files(revisionExpression)} EXCEPT ${files(targetParameter)}) UNION ALL (${files(targetParameter)} EXCEPT ${files(revisionExpression)}))`;
}

export async function revisionFileIdentities(db:Db,revisionId:string):Promise<FileIdentity[]>{
 return(await db.query(`SELECT f.id,b.sha256,b.size_bytes,f.image_review_required FROM ai_distill.library_files f
  JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=$1 ORDER BY f.position`,[revisionId])).rows;
}

/** 原件集合相同后按 SHA 映射文件ID；有歧义的重复份数不伪造一对一坐标。 */
export function fileIdentityMapping(source:FileIdentity[],target:FileIdentity[],reviewImages=false){
 if(!source.length||!target.length||materialSetSignature(source)!==materialSetSignature(target)||source.length!==target.length)return;
 const remaining=[...target],mapping=new Map<string,string>();
 for(const file of source){
  const index=remaining.findIndex(candidate=>candidate.sha256===file.sha256&&Number(candidate.size_bytes)===Number(file.size_bytes)&&(!reviewImages||!!candidate.image_review_required===!!file.image_review_required));
  if(index<0)return;
  mapping.set(file.id,remaining.splice(index,1)[0]!.id);
 }
 return mapping;
}

/** 只替换精确匹配的结构标识，不对正文做子串替换。 */
export function remapResultIds<T>(value:T,mapping:ReadonlyMap<string,string>):T{
 if(typeof value==='string')return(mapping.get(value)??value) as T;
 if(Array.isArray(value))return value.map(item=>remapResultIds(item,mapping)) as T;
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remapResultIds(item,mapping)])) as T;
 return value;
}

/** 单文件成功结果可跨包、跨版本、跨供应商复用，仍检查原件及正文对象摘要和结构。 */
export async function readReusableExtraction(db:Db,file:{source_sha256:string;size_bytes:number|string}):Promise<ReusedExtraction|undefined>{
 const candidates=(await db.query(`SELECT d.document_blob_id,d.source_sha256,d.extraction_job_id
  FROM ai_distill.library_blobs original
  JOIN ai_distill.library_files f ON f.blob_id=original.id
  JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.revision_id=f.revision_id AND d.source_sha256=$1
  JOIN ai_distill.library_jobs j ON j.id=d.extraction_job_id AND j.status='succeeded'
  WHERE original.storage_kind='file' AND original.sha256=$1 AND original.size_bytes=$2
  ORDER BY j.finished_at DESC,d.id LIMIT 5`,[file.source_sha256,Number(file.size_bytes)])).rows;
 for(const candidate of candidates){
  try{
   const blob=(await db.query("SELECT sha256,text_content FROM ai_distill.library_blobs WHERE id=$1 AND storage_kind='database_text'",[candidate.document_blob_id])).rows[0];
   if(!blob||typeof blob.text_content!=='string'||hash(blob.text_content)!==blob.sha256)continue;
   const parsed=JSON.parse(blob.text_content);
   if(parsed.version!==1||parsed.source_sha256!==file.source_sha256)continue;
   const document=ensurePages(parsed.pages,file.source_sha256);
   if(document.pages.every(page=>!page.text.trim()))continue;
   return{document,provider:'reused',source_job_id:String(candidate.extraction_job_id),image_candidates:Array.isArray(parsed.image_candidates)?parsed.image_candidates as ReusedImageCandidate[]:undefined};
  }catch(error){logEvent('library_result.reuse_unusable',{level:'warn',kind:'extract',...classifyLogError(error)});}
 }
}

/** 比较整理实际读取的整份正文与结构，允许文件ID、标题和排列变化，不混用不同化名正文。 */
export function preparationUnitMapping(source:PreparationUnit[],target:PreparationUnit[]){
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='id').map(([key,item])=>[key,canonical(item)])):value;
 if(source.length!==target.length)return;
 const remaining=target.map(unit=>({unit,digest:hash({pages:canonical(unit.pages),unit_kind:unit.unit_kind??null})})),mapping=new Map<string,string>();
 for(const unit of source){
  const digest=hash({pages:canonical(unit.pages),unit_kind:unit.unit_kind??null}),index=remaining.findIndex(candidate=>candidate.digest===digest);
  if(index<0)return;
  mapping.set(unit.id,remaining.splice(index,1)[0]!.unit.id);
 }
 return mapping;
}
