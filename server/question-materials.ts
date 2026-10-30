/**
 * 文件职责：按项目材料后端读取并校验题目冻结的材料来源。
 * 关键入口：`readQuestionMaterials()` 返回完整冻结附件及可选的可见文书模型投影；library_v1缺快照时拒绝旧步骤回退。
 * 使用场景：出题与作答使用投影附件，评分核对来源身份，归档/导出按各自契约读取；不执行OCR或脱敏；数据库回读后可写本机受管快照缓存，不修改原件。
 */
import {createHash} from 'node:crypto';
import {visiblePreparedDocuments,preparationUnits,renderPreparationDocuments,validateSelectedMaterialIndex,visiblePreparationContext} from '../shared/material-preparation-result';
import {readFile,realpath,stat,mkdir,lstat,writeFile,rename,rm} from 'node:fs/promises';
import {resolve,relative,sep,isAbsolute} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../shared/workflow-config';
import {documentBlocksToText} from './materials/pdf';
import type {QuestionMaterialOrigin} from '../shared/material-library';
import {resolveMaterialProcessingMode,materialProcessingSourceMode} from '../shared/material-library';
import {storageDirectory} from './paths';
import {logEvent} from './logging';

type Db=Pool|PoolClient;
type MaterialArtifact={id:string;kind:string;attempt_id:string|null;sha256:string;content:string|null};
type SnapshotArtifact=Omit<MaterialArtifact,'content'>&{content?:string|null;storage_path?:string;size_bytes?:number|string};
export interface QuestionMaterialAttachment {id:string;sha256:string;content:string;source_names:string[];attempt_id:string|null}
export interface QuestionMaterials {origin:QuestionMaterialOrigin;attachments:QuestionMaterialAttachment[];digest:string;model_attachments?:QuestionMaterialAttachment[];model_source_names?:string[];material_scope?:{preparation_id:string;result:import('../shared/material-preparation-result').MaterialPreparationResult}}

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
  if(row.attempt_id!==origin.redaction_attempt_id||typeof row.content!=='string')throw conflict('旧来源脱敏附件缺失或摘要校验失败');
  return{id:row.id,sha256:row.sha256,content:row.content,source_names:sourceNames,attempt_id:row.attempt_id};
 });
 return{origin,attachments,digest:hash(canonicalJson(attachments.map(({id,sha256})=>({id,sha256}))))};
}

/** 本机副本只作内容缓存：数据库身份/摘要仍是依据，缺失、越界或损坏均回读数据库。 */
async function readLocalSnapshot(root:string,workflowId:string,artifact:SnapshotArtifact):Promise<string|undefined>{
 if(typeof artifact.storage_path!=='string'||!Number.isSafeInteger(Number(artifact.size_bytes))||Number(artifact.size_bytes)<0)return undefined;
 const inside=(base:string,path:string)=>{const part=relative(base,path);return part!==''&&part!=='..'&&!part.startsWith(`..${sep}`)&&!isAbsolute(part);};
 const path=resolve(root,artifact.storage_path);
 if(!inside(resolve(root,workflowId),path))return undefined;
 try{
  const [realRoot,actualPath]=await Promise.all([realpath(root),realpath(path)]);
  if(!inside(resolve(realRoot,workflowId),actualPath))return undefined;
  if((await stat(actualPath)).size!==Number(artifact.size_bytes))return undefined;
  const bytes=await readFile(actualPath);
  if(bytes.length!==Number(artifact.size_bytes)||hash(bytes)!==artifact.sha256)return undefined;
  const content=bytes.toString('utf8');
  return hash(content)===artifact.sha256?content:undefined;
 }catch{
  // 本地文件不是唯一副本；I/O失败不能使原有数据库读取路径不可用。
  return undefined;
 }
}

/** 缓存独立于原快照路径，按本题、artifact身份和数据库摘要寻址；不回写业务表或跨题共享。 */
function cachedSnapshot(workflowId:string,artifact:SnapshotArtifact):SnapshotArtifact{
 return{...artifact,storage_path:`${workflowId}/.snapshot-cache/${hash(artifact.id)}-${artifact.sha256}`};
}
async function cacheSnapshot(root:string,workflowId:string,artifact:SnapshotArtifact){
 if(typeof artifact.content!=='string'||!/^[0-9a-f-]{36}$/i.test(workflowId)||!/^[0-9a-f]{64}$/i.test(artifact.sha256)||
  Buffer.byteLength(artifact.content)!==Number(artifact.size_bytes)||hash(artifact.content)!==artifact.sha256)return;
 let temporary:string|undefined;
 try{
  await mkdir(root,{recursive:true,mode:0o700});
  let directory=await realpath(root);
  // 逐层确认目录再写入；拒绝符号链接，不沿数据库提供的原storage_path创建目录。
  for(const part of [workflowId,'.snapshot-cache']){
   directory=resolve(directory,part);
   try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())return;
  }
  const target=resolve(directory,`${hash(artifact.id)}-${artifact.sha256}`);
  temporary=`${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary,artifact.content,{flag:'wx',mode:0o600});
  await rename(temporary,target);
 }catch{
  // 只作加速副本；磁盘不可写仍使用本次已读取的数据库正文。
  logEvent('material.snapshot.cache_failed',{level:'warn',component:'question_materials',workflow_id:workflowId,reason_code:'snapshot_cache_write_failed'});
 }finally{
  if(temporary)try{await rm(temporary,{force:true});}catch{logEvent('material.snapshot.cache_cleanup_failed',{level:'warn',component:'question_materials',workflow_id:workflowId,reason_code:'snapshot_cache_cleanup_failed'});}
 }
}

async function readLibraryMaterials(db:Db,workflowId:string,root:string):Promise<QuestionMaterials>{
 const started=performance.now();
 const row=(await db.query(`SELECT project_id,package_id,revision_id,redaction_id,material_mode,source_digest,snapshot_manifest,snapshot_digest,markdown_artifact_id,index_artifact_id
  FROM ai_distill.question_library_sources WHERE workflow_id=$1`,[workflowId])).rows[0];
 if(!row)throw conflict('library_v1 题目缺少来源快照');
 const manifest=row.snapshot_manifest;
 const mode=row.material_mode==='original'?'original':'redacted';
 const markdownEntry=manifest?.material_markdown??manifest?.redacted_markdown,indexEntry=manifest?.material_index??manifest?.redacted_index;
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||![2,3].includes(manifest.version)||!manifest.origin||manifest.origin.kind!=='library_v1'||
   manifest.origin.package_id!==row.package_id||manifest.origin.revision_id!==row.revision_id||manifest.origin.redaction_id!==(row.redaction_id??null)||
   (manifest.origin.material_mode??'redacted')!==mode||markdownEntry?.artifact_id!==row.markdown_artifact_id||indexEntry?.artifact_id!==row.index_artifact_id||
   !Array.isArray(manifest.files)){
  throw conflict('library_v1 题目材料来源快照结构或摘要无效');
 }
 // 不在元数据查询中携带大字段；本地命中时不再下载整份结构索引。
 const artifacts=(await db.query(`SELECT id,kind,attempt_id,sha256,storage_path,size_bytes FROM ai_distill.artifacts
  WHERE workflow_id=$1 AND id=ANY($2::uuid[])`,[workflowId,[row.markdown_artifact_id,row.index_artifact_id]])).rows as SnapshotArtifact[];
 if(artifacts.length!==2)throw conflict('library_v1 题目正文或索引缺失');
 const markdown=artifacts.find(item=>item.id===row.markdown_artifact_id),index=artifacts.find(item=>item.id===row.index_artifact_id);
 const expectedMarkdownKind=mode==='original'?'source_markdown':'redacted_markdown',expectedIndexKind=mode==='original'?'source_index':'redacted_index';
 if(markdown?.kind!==expectedMarkdownKind||index?.kind!==expectedIndexKind||markdown.attempt_id!==null||index.attempt_id!==null){
  throw conflict('library_v1 题目正文或索引与来源快照不匹配');
 }
 await Promise.all(artifacts.map(async artifact=>{artifact.content=await readLocalSnapshot(root,workflowId,artifact)??await readLocalSnapshot(root,workflowId,cachedSnapshot(workflowId,artifact));}));
 const missing=artifacts.filter(artifact=>typeof artifact.content!=='string').map(artifact=>artifact.id);
 let databaseBytes=0;
 if(missing.length){
  const remote=(await db.query(`SELECT id,content FROM ai_distill.artifacts
   WHERE workflow_id=$1 AND id=ANY($2::uuid[])`,[workflowId,missing])).rows as {id:string;content:string|null}[];
  databaseBytes=remote.reduce((sum,artifact)=>sum+Buffer.byteLength(artifact.content??''),0);
  for(const artifact of artifacts)if(missing.includes(artifact.id))artifact.content=remote.find(value=>value.id===artifact.id)?.content;
 }
 if(typeof markdown.content!=='string'||typeof index.content!=='string')throw conflict('library_v1 题目正文或索引与来源快照不匹配');
 let parsedIndex:any;
 try{parsedIndex=JSON.parse(index.content);}catch{throw conflict('library_v1 题目材料索引格式无效');}
 if(manifest.version===3){
  try{const docs=validateSelectedMaterialIndex(parsedIndex,markdown.content,false);if(!manifest.selection?.preparation_id||JSON.stringify(docs.map((d:any)=>d.source_document_id))!==JSON.stringify(manifest.selection.document_ids))throw new Error('selection mismatch');}catch{throw conflict('选用材料快照缺失或损坏；不会恢复隐藏材料');}
 }else if(mode==='original'){
  if(parsedIndex?.format!=='source-index-v1'||!Array.isArray(parsedIndex.materials)||parsedIndex.materials.length!==manifest.files.length||
    parsedIndex.materials.some((item:any,index:number)=>{
     const file=manifest.files[index],document=item?.document;
     if(typeof item?.material_id!=='string'||item.material_id!==file?.material_id||typeof item.markdown!=='string'||!document||document.version!==1||!Array.isArray(document.pages))return true;
     const pageTexts:string[]=[];
     for(const page of document.pages){if(!Number.isSafeInteger(page.page)||typeof page.text!=='string'||!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text)return true;pageTexts.push(page.text);}
     const projected=pageTexts.filter(Boolean).join('\n\n'),textDigest=hash(pageTexts.join('\n'));
     return projected!==item.markdown;
    }))throw conflict('library_v1 题目原文索引与正文不匹配');
  const projected=parsedIndex.materials.map((item:any,index:number)=>`# ${String(manifest.files[index]?.original_name??'')}\n\n${item.markdown}`).join('\n\n---\n\n');
  if(projected!==markdown.content)throw conflict('library_v1 题目原文索引投影与正文不匹配');
 }else if(parsedIndex?.format!=='redacted-index-v2'||!Array.isArray(parsedIndex.materials))throw conflict('library_v1 题目脱敏索引与正文不匹配');
 let processingMode:ReturnType<typeof resolveMaterialProcessingMode>|undefined;
 if(manifest.origin.material_processing_mode!==undefined){
  try{processingMode=resolveMaterialProcessingMode(manifest.origin);}catch{throw conflict('题目冻结的材料处理方式无效');}
  if(materialProcessingSourceMode(processingMode)!==mode)throw conflict('题目冻结的处理方式与正文来源不一致');
 }
 const origin:QuestionMaterialOrigin={kind:'library_v1',material_mode:mode,...(processingMode?{material_processing_mode:processingMode}:{}),package_id:String(row.package_id),revision_id:String(row.revision_id),redaction_id:row.redaction_id===null?null:String(row.redaction_id),snapshot_digest:String(row.snapshot_digest)};
 // 结构检查通过后才安装副本；缓存摘要不匹配只跳过缓存，不改变数据库正文的业务准入。
 await Promise.all(artifacts.filter(artifact=>missing.includes(artifact.id)).map(artifact=>cacheSnapshot(root,workflowId,artifact)));
 logEvent('material.snapshot.read',{level:'info',component:'question_materials',workflow_id:workflowId,state:missing.length?'database_fallback':'local_snapshot',material_count:artifacts.length,input_bytes:databaseBytes,duration_ms:Math.round(performance.now()-started)});
 const attachment:QuestionMaterialAttachment={id:markdown.id,sha256:markdown.sha256,content:markdown.content,source_names:manifest.files.map((file:any)=>String(file.original_name??'')).filter(Boolean),attempt_id:null};
 const prepared=manifest.material_scope?.result?.format==='material-preparation-v2'&&typeof manifest.material_scope.preparation_id==='string'
  ?{preparation_id:String(manifest.material_scope.preparation_id),result:manifest.material_scope.result as import('../shared/material-preparation-result').MaterialPreparationResult}:undefined;
 if(!prepared){
  const docs=preparationUnits(parsedIndex).map(unit=>({id:unit.id,title:unit.title,text:'',document:{format:'redacted-structure-v1' as const,pages:unit.pages},source_refs:unit.source_refs??[]}));
  if(!docs.length)return{origin,attachments:[attachment],digest:String(row.snapshot_digest)};
  const content=renderPreparationDocuments(docs);
  return{origin,attachments:[attachment],model_attachments:content.trim()?[{...attachment,content,sha256:hash(content)}]:[],digest:String(row.snapshot_digest)};
 }
 const visibleDocuments=visiblePreparedDocuments(prepared.result,preparationUnits(parsedIndex));
 const content=renderPreparationDocuments(visibleDocuments);
 const hasHidden=prepared.result.documents.some(document=>document.visibility==='hidden');
 const modelAttachment:QuestionMaterialAttachment={...attachment,sha256:hash(content),content,source_names:hasHidden?[]:attachment.source_names};
 return{origin,attachments:[attachment],model_attachments:[...(content.trim()?[modelAttachment]:[])],model_source_names:hasHidden?[]:attachment.source_names,digest:String(row.snapshot_digest),material_scope:{preparation_id:prepared.preparation_id,result:visiblePreparationContext(prepared.result)}};
}

export async function readQuestionMaterials(db:Db,workflowId:string,root=storageDirectory()):Promise<QuestionMaterials>{
 const row=(await db.query(`SELECT p.material_backend,EXISTS(SELECT 1 FROM ai_distill.question_library_sources s WHERE s.workflow_id=w.id) AS has_library_snapshot FROM ai_distill.workflows w
  JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!row)throw new HTTPException(404,{message:'工作流不存在'});
 if(row.material_backend==='library_v1'||row.has_library_snapshot)return readLibraryMaterials(db,workflowId,root);
 if(row.material_backend!=='legacy')throw conflict('题目材料后端无效');
 return readLegacyMaterials(db,workflowId);
}
