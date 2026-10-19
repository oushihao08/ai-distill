/**
 * 文件职责：按项目材料后端读取并校验题目冻结的材料来源。
 * 关键入口：`readQuestionMaterials()` 返回类型化来源和摘要已核对的脱敏或原文附件；library_v1 缺快照时拒绝旧步骤回退。
 * 使用场景：出题、作答、评分、归档和导出共用；不执行 OCR、脱敏或文件写入。
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../shared/workflow-config';
import {documentBlocksToText} from './materials/pdf';
import type {QuestionMaterialOrigin} from '../shared/material-library';

type Db=Pool|PoolClient;
type MaterialArtifact={id:string;kind:string;attempt_id:string|null;sha256:string;content:string|null};
export interface QuestionMaterialAttachment {id:string;sha256:string;content:string;source_names:string[];attempt_id:string|null}
export interface QuestionMaterials {origin:QuestionMaterialOrigin;attachments:QuestionMaterialAttachment[];digest:string}

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const conflict=(message:string)=>new HTTPException(409,{message});

type LegacyMaterialOrigin=Extract<QuestionMaterialOrigin,{kind:'legacy'}>;
function readLegacyOrigin(value:unknown):LegacyMaterialOrigin{
 if(typeof value!=='string'||!/^[0-9a-f-]{36}$/i.test(value))throw conflict('当前题目没有有效的旧来源脱敏记录');
 return{kind:'legacy',redaction_attempt_id:value};
}

async function readLegacyMaterials(db:Db,workflowId:string):Promise<QuestionMaterials>{
 const redaction=(await db.query(`SELECT a.id,a.input FROM ai_distill.step_attempts a
  JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 AND s.status='succeeded'
  WHERE a.workflow_id=$1 AND a.ordinal=9 AND a.status='succeeded' ORDER BY a.attempt DESC LIMIT 1`,[workflowId])).rows[0];
 const origin=readLegacyOrigin(redaction?.id);
 const rows=(await db.query(`SELECT id,kind,attempt_id,sha256,content FROM ai_distill.artifacts
  WHERE workflow_id=$1 AND attempt_id=$2 AND kind='redacted_markdown' ORDER BY created_at,id`,[workflowId,origin.redaction_attempt_id])).rows as MaterialArtifact[];
 if(!rows.length)throw conflict('当前题目没有可用的脱敏附件');
 const inputMaterials=Array.isArray(redaction.input?.materials)?redaction.input.materials:[];
 const sourceNames=inputMaterials.flatMap((item:any)=>typeof item?.original_name==='string'&&item.original_name?[item.original_name]:[]);
 const attachments=rows.map(row=>{
  if(row.attempt_id!==origin.redaction_attempt_id||typeof row.content!=='string'||!/^([a-f0-9]{64})$/.test(row.sha256)||hash(row.content)!==row.sha256)throw conflict('旧来源脱敏附件缺失或摘要校验失败');
  return{id:row.id,sha256:row.sha256,content:row.content,source_names:sourceNames,attempt_id:row.attempt_id};
 });
 return{origin,attachments,digest:hash(canonicalJson(attachments.map(({id,sha256})=>({id,sha256}))))};
}

async function readLibraryMaterials(db:Db,workflowId:string):Promise<QuestionMaterials>{
 const row=(await db.query(`SELECT project_id,package_id,revision_id,redaction_id,material_mode,source_digest,snapshot_manifest,snapshot_digest,markdown_artifact_id,index_artifact_id
  FROM ai_distill.question_library_sources WHERE workflow_id=$1`,[workflowId])).rows[0];
 if(!row)throw conflict('library_v1 题目缺少来源快照');
 const manifest=row.snapshot_manifest;
 const mode=row.material_mode==='original'?'original':'redacted';
 const markdownEntry=manifest?.material_markdown??manifest?.redacted_markdown,indexEntry=manifest?.material_index??manifest?.redacted_index;
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||manifest.version!==2||!manifest.origin||manifest.origin.kind!=='library_v1'||
   manifest.origin.package_id!==row.package_id||manifest.origin.revision_id!==row.revision_id||manifest.origin.redaction_id!==(row.redaction_id??null)||
   (manifest.origin.material_mode??'redacted')!==mode||manifest.origin.source_digest!==row.source_digest||markdownEntry?.artifact_id!==row.markdown_artifact_id||indexEntry?.artifact_id!==row.index_artifact_id||
   !Array.isArray(manifest.files)||hash(canonicalJson(manifest))!==row.snapshot_digest){
  throw conflict('library_v1 题目材料来源快照结构或摘要无效');
 }
 const artifacts=(await db.query(`SELECT id,kind,attempt_id,sha256,content FROM ai_distill.artifacts
  WHERE workflow_id=$1 AND id=ANY($2::uuid[])`,[workflowId,[row.markdown_artifact_id,row.index_artifact_id]])).rows as MaterialArtifact[];
 if(artifacts.length!==2)throw conflict('library_v1 题目正文或索引缺失');
 const markdown=artifacts.find(item=>item.id===row.markdown_artifact_id),index=artifacts.find(item=>item.id===row.index_artifact_id);
 const expectedMarkdownKind=mode==='original'?'source_markdown':'redacted_markdown',expectedIndexKind=mode==='original'?'source_index':'redacted_index';
 if(markdown?.kind!==expectedMarkdownKind||index?.kind!==expectedIndexKind||markdown.attempt_id!==null||index.attempt_id!==null||
   typeof markdown.content!=='string'||typeof index.content!=='string'||hash(markdown.content)!==markdown.sha256||hash(index.content)!==index.sha256||
   markdown.sha256!==markdownEntry.sha256||index.sha256!==indexEntry.sha256){
  throw conflict('library_v1 题目正文或索引与来源快照不匹配');
 }
 let parsedIndex:any;
 try{parsedIndex=JSON.parse(index.content);}catch{throw conflict('library_v1 题目材料索引格式无效');}
 if(mode==='original'){
  if(parsedIndex?.format!=='source-index-v1'||!Array.isArray(parsedIndex.materials)||parsedIndex.materials.length!==manifest.files.length||
    parsedIndex.materials.some((item:any,index:number)=>{
     const file=manifest.files[index],document=item?.document;
     if(typeof item?.material_id!=='string'||item.material_id!==file?.material_id||typeof item.markdown!=='string'||!document||document.version!==1||document.source_sha256!==file.source_sha256||!Array.isArray(document.pages))return true;
     const pageTexts:string[]=[];
     for(const page of document.pages){if(!Number.isSafeInteger(page.page)||typeof page.text!=='string'||!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text)return true;pageTexts.push(page.text);}
     const projected=pageTexts.filter(Boolean).join('\n\n'),textDigest=hash(pageTexts.join('\n'));
     return projected!==item.markdown||textDigest!==file.document_sha256;
    }))throw conflict('library_v1 题目原文索引与正文不匹配');
  const projected=parsedIndex.materials.map((item:any,index:number)=>`# ${String(manifest.files[index]?.original_name??'')}\n\n${item.markdown}`).join('\n\n---\n\n');
  if(projected!==markdown.content)throw conflict('library_v1 题目原文索引投影与正文不匹配');
 }else if(parsedIndex?.format!=='redacted-index-v2'||parsedIndex.redacted_sha256!==markdown.sha256||!Array.isArray(parsedIndex.materials))throw conflict('library_v1 题目脱敏索引与正文不匹配');
 const origin:QuestionMaterialOrigin={kind:'library_v1',material_mode:mode,package_id:String(row.package_id),revision_id:String(row.revision_id),redaction_id:row.redaction_id===null?null:String(row.redaction_id),snapshot_digest:String(row.snapshot_digest)};
 return{origin,attachments:[{id:markdown.id,sha256:markdown.sha256,content:markdown.content,source_names:manifest.files.map((file:any)=>String(file.original_name??'')).filter(Boolean),attempt_id:null}],digest:String(row.snapshot_digest)};
}

export async function readQuestionMaterials(db:Db,workflowId:string):Promise<QuestionMaterials>{
 const row=(await db.query(`SELECT p.material_backend,EXISTS(SELECT 1 FROM ai_distill.question_library_sources s WHERE s.workflow_id=w.id) AS has_library_snapshot FROM ai_distill.workflows w
  JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!row)throw new HTTPException(404,{message:'工作流不存在'});
 if(row.material_backend==='library_v1'||row.has_library_snapshot)return readLibraryMaterials(db,workflowId);
 if(row.material_backend!=='legacy')throw conflict('题目材料后端无效');
 return readLegacyMaterials(db,workflowId);
}
