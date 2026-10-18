/**
 * 职责：校验当前脱敏输入、归档当前原件副本并生成可选 DOCX，安全下载现行产物。
 * 主要入口：`exportRedactedDocx()` 归档单题附件；`readCurrentRedactedDocx()` 校验指纹后读取；`isLibraryDocxPath()` 供下载与重置共用路径契约。
 * 使用场景：由工作流 API 调用；不派发 worker 任务或写入步骤、尝试、发布与返修状态。
 */
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {getWorkflowStepDefinitions} from '@shared/step-registry';
import {redactionInputDigest} from './redaction-jobs';
import {REDACTED_DOCX_RENDERER_VERSION,buildRedactedDocx,type RedactedDocumentStructure} from './redacted-docx';
import {documentBlocksToText} from './pdf';
import {readQuestionMaterials} from '../question-materials';

const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const beneath=(root:string,path:string)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel);};
type Source={material_id:string;source_sha256:string;artifact_id:string;artifact_sha256:string;redaction_mode?:'model'|'declared_redacted'};
type Original={id:string;original_name:string;storage_path:string;sha256:string;size_bytes:number|string};
type FileChange={path:string;previous:Buffer|null};
type IndexedDocument={document:RedactedDocumentStructure;structure_sha256:string};
type ExportContext={workflow_id:string;project_id:string;project_name:string;parent_name:string|null;phase_name:string|null;title:string;source_key:string|null;attempt_id:string|null;redacted_sha256:string;markdown:string;materialMarkdown:Map<string,string>;materialDocuments:Map<string,IndexedDocument>;originals:Original[];material_origin?:import('@shared/material-library').QuestionMaterialOrigin;material_snapshot_digest?:string};
type ManifestMaterial={material_id:string;source_sha256:string;document_sha256:string;docx_artifact_id:string;docx_sha256:string};
type DocxManifestV1={format:'redacted-docx-manifest-v1';attempt_id:string|null;redacted_sha256:string;renderer_version:string;materials:ManifestMaterial[]};
type DocxManifestV2={format:'redacted-docx-manifest-v2';attempt_id:null;material_origin:import('@shared/material-library').QuestionMaterialOrigin;snapshot_digest:string;redacted_sha256:string;renderer_version:string;materials:ManifestMaterial[]};
type DocxManifest=DocxManifestV1|DocxManifestV2;
type ArchiveLocation={questionDir:string;originalDir:string;docxPath:string;storagePath:string;archivePath:string};

function safeLabel(value:string,fallback:string){
 const normalized=value.normalize('NFKC').replace(/[\\/\u0000-\u001f<>:"|?*]/g,'_').replace(/\s+/g,' ').replace(/^\.+|\.+$/g,'').trim();
 let label='';for(const character of normalized){if(Buffer.byteLength(label+character)>190)break;label+=character;}label||=fallback;
 return label;
}
/** 下载与工作流重置共用附件库契约，同时接受旧项目／题目与新项目／期数／题目路径。 */
export function isLibraryDocxPath(path:string){const segments=path.split('/'),legacy=segments.length===5&&segments[3]==='成果',phased=segments.length===6&&segments[4]==='成果';return segments[0]==='附件库'&&(legacy||phased)&&segments.slice(1,-2).every(Boolean)&&Boolean(segments.at(-1)?.endsWith('.docx'))&&!segments.some(segment=>!segment||segment==='.'||segment==='..'||/[\\\u0000-\u001f]/.test(segment));}
async function ensureDirectory(path:string,restrictAccess=true,allowParentAliases=false){
 await mkdir(path,{recursive:true,mode:0o700});
 let actual:string;try{actual=await realpath(path);}catch{throw new HTTPException(409,{message:'附件库目录不可读取'});}
 let info;try{info=await lstat(path);}catch{throw new HTTPException(409,{message:'附件库目录不可读取'});}
 if((actual!==path&&!allowParentAliases)||info.isSymbolicLink()||!info.isDirectory())throw new HTTPException(409,{message:'附件库目录不能包含符号链接'});
 if(restrictAccess)await chmod(path,0o700);
 return actual;
}
async function archiveLocation(exportRootInput:string,projectName:string,phaseName:string,title:string):Promise<ArchiveLocation>{
 const exportRoot=await ensureDirectory(resolve(exportRootInput),false,true);
 const libraryRoot=join(exportRoot,'附件库');await ensureDirectory(libraryRoot);
 const projectDir=join(libraryRoot,safeLabel(projectName,'项目'));await ensureDirectory(projectDir);
 const periodDir=phaseName?join(projectDir,safeLabel(phaseName,'期数')):projectDir;if(phaseName)await ensureDirectory(periodDir);
 const questionDir=join(periodDir,safeLabel(title,'题目'));await ensureDirectory(questionDir);
 const originalDir=join(questionDir,'原件'),resultDir=join(questionDir,'成果');await ensureDirectory(originalDir);await ensureDirectory(resultDir);
 const docxPath=join(resultDir,'脱敏材料.docx');
 if(!beneath(exportRoot,docxPath)||!beneath(questionDir,docxPath))throw new HTTPException(409,{message:'附件库导出路径无效'});
 return{questionDir,originalDir,docxPath,storagePath:relative(exportRoot,docxPath).split(sep).join('/'),archivePath:relative(exportRoot,questionDir).split(sep).join('/')};
}
/** 达标题目的项目交付与脱敏 DOCX 共用同一成果目录。有期数时题目名与 DOCX 归档一致。 */
export async function questionResultDirectory(exportRoot:string,projectName:string,phaseName:string,questionName:string){
 return dirname((await archiveLocation(exportRoot,projectName,phaseName,questionName)).docxPath);
}

async function safeOriginalBytes(storageRootInput:string,material:Original){
 if(!material.storage_path||isAbsolute(material.storage_path)||material.storage_path.split(/[\\/]/).some(segment=>!segment||segment==='.'||segment==='..'))throw new HTTPException(409,{message:'当前附件原件路径无效'});
 let storageRoot:string;try{storageRoot=await realpath(storageRootInput);}catch{throw new HTTPException(409,{message:'附件原件存储目录不可读取'});}
 const path=resolve(storageRoot,material.storage_path);if(!beneath(storageRoot,path))throw new HTTPException(409,{message:'当前附件原件路径越界'});
 let actual:string,info;try{actual=await realpath(path);info=await lstat(path);}catch{throw new HTTPException(409,{message:'当前附件原件文件缺失'});}
 if(actual!==path||info.isSymbolicLink()||!info.isFile())throw new HTTPException(409,{message:'当前附件原件路径不能包含符号链接'});
 const bytes=await readFile(path);
 if(digest(bytes)!==material.sha256||bytes.byteLength!==Number(material.size_bytes))throw new HTTPException(409,{message:'当前附件原件指纹校验失败'});
 return bytes;
}

async function installFile(path:string,bytes:Uint8Array,expectedSha256:string,changes:FileChange[]){
 let previous:Buffer|null=null;
 try{
  const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile())throw new HTTPException(409,{message:'附件库目标不是普通文件'});
  previous=await readFile(path);if(digest(previous)===expectedSha256)return;
 }catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
 const temporary=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`);
 try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,path);changes.push({path,previous});}
 finally{await rm(temporary,{force:true}).catch(()=>{});}
}
async function restoreFiles(changes:FileChange[]){
 for(const change of [...changes].reverse()){
  if(change.previous===null){await rm(change.path,{force:true});continue;}
  const temporary=join(dirname(change.path),`.${basename(change.path)}.${randomUUID()}.restore`);
  try{await writeFile(temporary,change.previous,{mode:0o600,flag:'wx'});await rename(temporary,change.path);}finally{await rm(temporary,{force:true}).catch(()=>{});}
 }
}

async function readCurrentSources(db:Pool|PoolClient,workflowId:string):Promise<Source[]>{
 const result=await db.query("SELECT DISTINCT ON(m.id) m.id AS material_id,m.sha256 AS source_sha256,m.redaction_mode,ar.id AS artifact_id,ar.sha256 AS artifact_sha256 FROM ai_distill.materials m JOIN ai_distill.artifacts ar ON ar.workflow_id=m.workflow_id AND ar.material_id=m.id AND ar.kind='private_extracted_pages' JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id AND a.status='succeeded' WHERE m.workflow_id=$1 AND m.deleted_at IS NULL ORDER BY m.id,a.finished_at DESC NULLS LAST,ar.created_at DESC,ar.id DESC",[workflowId]);
 const total=Number((await db.query('SELECT count(*)::int AS count FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL',[workflowId])).rows[0]?.count??0);
 if(!total||result.rows.length!==total)throw new HTTPException(409,{message:'当前附件尚无完整入库文本'});
 return result.rows as Source[];
}

/** 复用同一脱敏索引校验，供独立DOCX导出和归档结构传递；不读取原文结构。 */
export async function readCurrentRedactionForDocx(db:Pool|PoolClient,workflowId:string){
 const backend=(await db.query(`SELECT p.material_backend FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1`,[workflowId])).rows[0]?.material_backend;
 if(backend==='library_v1'){
  const source=await readQuestionMaterials(db,workflowId);
  if(source.origin.kind!=='library_v1')throw new HTTPException(409,{message:'材料库来源信息无效'});
  const record=(await db.query('SELECT snapshot_manifest,redaction_id FROM ai_distill.question_library_sources WHERE workflow_id=$1',[workflowId])).rows[0];
  const indexArtifact=(await db.query('SELECT id,content,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND id=$2 AND kind=\'redacted_index\' AND attempt_id IS NULL',[workflowId,record?.snapshot_manifest?.redacted_index?.artifact_id])).rows[0];
  let index:any;try{if(typeof indexArtifact?.content!=='string'||digest(indexArtifact.content)!==indexArtifact.sha256)throw new Error('invalid index');index=JSON.parse(indexArtifact.content);}catch{throw new HTTPException(409,{message:'材料库脱敏索引缺失或损坏'});}
  if(index.format!=='redacted-index-v2'||index.redacted_sha256!==source.attachments[0]?.sha256||!Array.isArray(index.materials)||!Array.isArray(record?.snapshot_manifest?.files))throw new HTTPException(409,{message:'材料库脱敏索引与冻结来源不匹配'});
  const materialMarkdown=new Map<string,string>(),materialDocuments=new Map<string,IndexedDocument>();
  for(const item of index.materials){
   if(typeof item?.material_id!=='string'||typeof item.markdown!=='string'||materialMarkdown.has(item.material_id))throw new HTTPException(409,{message:'材料库脱敏附件正文缺失或重复'});
   materialMarkdown.set(item.material_id,item.markdown);
   if(item.document?.format==='redacted-structure-v1'){
    const document=item.document as RedactedDocumentStructure;
    if(!Array.isArray(document.pages)||!document.pages.length||document.pages.some(page=>!Number.isSafeInteger(page.page)||!Array.isArray(page.blocks)))throw new HTTPException(409,{message:'材料库脱敏结构无效'});
    const projected=document.pages.map(page=>documentBlocksToText(page.blocks)).join('\n\n'),structure_sha256=digest(JSON.stringify(document));
    if(projected!==item.markdown||item.structure_sha256!==structure_sha256)throw new HTTPException(409,{message:'材料库脱敏结构与正文不一致'});
    materialDocuments.set(item.material_id,{document,structure_sha256});
   }
  }
  const sources=record.snapshot_manifest.files.map((file:any)=>({material_id:String(file.material_id),source_sha256:String(file.source_sha256)}));
  if(sources.length!==index.materials.length||sources.some((item:any)=>!materialMarkdown.has(item.material_id)||!materialDocuments.has(item.material_id)))throw new HTTPException(409,{message:'材料库脱敏索引缺少附件或文档结构'});
  return{attempt_id:null,redacted_sha256:source.attachments[0]!.sha256,markdown:source.attachments[0]!.content,materialMarkdown,materialDocuments,material_origin:source.origin,material_snapshot_digest:source.origin.snapshot_digest};
 }
 const step=(await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9',[workflowId])).rows[0];
 const row=(await db.query("SELECT a.id,a.status,a.input,a.result,ar.id AS artifact_id,ar.content,ar.sha256 FROM ai_distill.step_attempts a JOIN ai_distill.artifacts ar ON ar.workflow_id=a.workflow_id AND ar.attempt_id=a.id AND ar.kind='redacted_markdown' WHERE a.workflow_id=$1 AND a.ordinal=9 ORDER BY a.attempt DESC LIMIT 1",[workflowId])).rows[0];
 if(step?.status!=='succeeded'||row?.status!=='succeeded'||typeof row.content!=='string')throw new HTTPException(409,{message:'当前脱敏结果未完成'});
 const input=row.input&&typeof row.input==='object'?row.input as {digest?:unknown;materials?:unknown}:{};
 const sources=await readCurrentSources(db,workflowId);
 // 摘要包含附件顺序；按脱敏时冻结的顺序核对当前指纹，避免数据库 ID 排序造成误报。
 const inputMaterials=Array.isArray(input.materials)?input.materials as Source[]:[];
 const sourceOrder=new Map(inputMaterials.map((material,index)=>[material?.material_id,index]));
 sources.sort((a,b)=>(sourceOrder.get(a.material_id)??Number.MAX_SAFE_INTEGER)-(sourceOrder.get(b.material_id)??Number.MAX_SAFE_INTEGER));
 if(typeof input.digest!=='string'||input.digest!==redactionInputDigest(sources)||!Array.isArray(input.materials)||redactionInputDigest(input.materials as Source[])!==input.digest||digest(row.content)!==row.sha256||row.result?.redacted_sha256!==row.sha256)throw new HTTPException(409,{message:'当前脱敏结果与附件版本不一致'});
 const indexRow=(await db.query("SELECT content,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind='redacted_index'",[workflowId,row.id])).rows[0];
 let index:any;try{if(typeof indexRow?.content!=='string'||digest(indexRow.content)!==indexRow.sha256)throw new Error('invalid index');index=JSON.parse(indexRow.content);}catch{throw new HTTPException(409,{message:'脱敏附件索引缺失或损坏，请重新脱敏'});}
 if(index.redacted_sha256!==row.sha256||!Array.isArray(index.materials)||index.materials.length!==sources.length)throw new HTTPException(409,{message:'脱敏附件索引与当前附件不一致'});
 const materialMarkdown=new Map<string,string>(),materialDocuments=new Map<string,IndexedDocument>();
 for(const material of index.materials){
  if(typeof material?.material_id!=='string'||typeof material.markdown!=='string'||materialMarkdown.has(material.material_id))throw new HTTPException(409,{message:'脱敏附件正文缺失或重复'});
  materialMarkdown.set(material.material_id,material.markdown);
  if(material.document?.format==='redacted-structure-v1'){
   const document=material.document as RedactedDocumentStructure;
   if(!Array.isArray(document.pages)||!document.pages.length||document.pages.some(page=>!Number.isSafeInteger(page.page)||!Array.isArray(page.blocks)))throw new HTTPException(409,{message:'脱敏结构与正文投影不一致，请重新脱敏'});
   const projected=document.pages.map(page=>documentBlocksToText(page.blocks)).join('\n\n'),structure_sha256=digest(JSON.stringify(document));
   if(projected!==material.markdown||material.structure_sha256!==structure_sha256)throw new HTTPException(409,{message:'脱敏结构与正文投影不一致，请重新脱敏'});
   materialDocuments.set(material.material_id,{document,structure_sha256});
  }
 }
 if(sources.some(source=>!materialMarkdown.has(source.material_id)))throw new HTTPException(409,{message:'脱敏附件索引与当前附件不一致'});
 if(index.format==='redacted-index-v2'&&sources.some(source=>!materialDocuments.has(source.material_id)))throw new HTTPException(409,{message:'结构化脱敏索引缺少文档结构'});
 return{attempt_id:String(row.id),redacted_sha256:String(row.sha256),markdown:String(row.content),materialMarkdown,materialDocuments};
}

async function contextForExport(db:Pool|PoolClient,workflowId:string,requireCompleted:boolean):Promise<ExportContext>{
 const workflow=(await db.query('SELECT w.id AS workflow_id,w.project_id,w.title,w.source_key,w.workflow_kind,p.material_backend,p.name AS project_name,p.parent_name,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 if(requireCompleted){
  const steps=(await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN (2,3) ORDER BY display_position NULLS LAST,ordinal FOR UPDATE',[workflowId])).rows;
  const statuses=new Map(steps.map((step:any)=>[Number(step.ordinal),step.status]));
  // 材料库题目只有4–8；按统一步骤注册表检查适用步骤，不能要求不存在的旧入库/脱敏记录。
  const required=getWorkflowStepDefinitions(workflow.material_backend??'legacy',workflow.workflow_kind??'question');
  if(required.some(step=>!['succeeded','skipped'].includes(String(statuses.get(step.ordinal))))||statuses.get(8)!=='succeeded')throw new HTTPException(409,{message:'请先完成当前工作流并归档达标题目'});
  const active=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal<>10 AND status IN ('waiting','running') LIMIT 1",[workflowId])).rowCount;
  if(active)throw new HTTPException(409,{message:'当前仍有工作流任务执行中'});
 }
 const redaction=await readCurrentRedactionForDocx(db,workflowId);
 if(typeof workflow.project_name!=='string'||typeof workflow.title!=='string')throw new HTTPException(409,{message:'项目或题目名称不完整'});
 const originals=(await db.query('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id',[workflowId])).rows as Original[];
 if(!originals.length)throw new HTTPException(409,{message:'当前题目没有可归档附件'});
 return{...workflow,project_name:workflow.project_name,parent_name:workflow.parent_name??workflow.project_name,phase_name:workflow.phase_name??null,title:workflow.title,...redaction,originals};
}

/** Archive one redacted DOCX per current material; never changes workflow steps. */
export async function exportRedactedDocx(pool:Pool,workflowId:string,storageRoot:string,projectExportsRoot:string){
 const db=await pool.connect();let tx=false;const changes:FileChange[]=[];
 try{
  await db.query('BEGIN');tx=true;
  const context=await contextForExport(db,workflowId,true),location=await archiveLocation(projectExportsRoot,context.parent_name||context.project_name,context.phase_name??'',context.phase_name?(context.source_key||context.title):context.title);
  const prior=(await db.query("SELECT id,material_id,attempt_id,sha256,storage_path FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx' ORDER BY created_at DESC,id DESC FOR UPDATE",[workflowId])).rows;
  const priorManifestRows=(await db.query("SELECT id,attempt_id,sha256,storage_path,content FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx_manifest' ORDER BY created_at DESC,id DESC FOR UPDATE",[workflowId])).rows;
  let priorManifest:DocxManifest|undefined;
  for(const row of priorManifestRows){
   try{if(typeof row.content!=='string'||digest(row.content)!==row.sha256)continue;const parsed=JSON.parse(row.content);if(['redacted-docx-manifest-v1','redacted-docx-manifest-v2'].includes(parsed?.format)&&Array.isArray(parsed.materials)){priorManifest=parsed as DocxManifest;break;}}catch(error){if(error instanceof SyntaxError)continue;continue;}
  }
  const artifacts:{artifact_id:string;material_id:string;filename:string;sha256:string;reused:boolean}[]=[];
  const manifestMaterials:ManifestMaterial[]=[];
  for(const material of context.originals){
   const bytes=await safeOriginalBytes(storageRoot,material),normalizedName=basename(material.original_name).normalize('NFKC').replace(/[\\/\u0000-\u001f<>:"|?*]/g,'_').replace(/^\.+|\.+$/g,'');let name='';for(const character of normalizedName){if(Buffer.byteLength(name+character)>150)break;name+=character;}name||='附件';
   const target=join(location.originalDir,`${material.id.slice(0,8)}_${name}`);if(!beneath(location.questionDir,target))throw new HTTPException(409,{message:'附件归档路径无效'});
   await installFile(target,bytes,material.sha256,changes);
   const stem=name.replace(/\.[^.]+$/,''),filename=`${stem}-脱敏-${material.id.slice(0,8)}.docx`,docxPath=join(dirname(location.docxPath),filename),storagePath=location.storagePath.replace(/[^/]+$/,filename);
   const current=prior.find(row=>row.material_id===material.id);
   const document=context.materialDocuments.get(material.id),document_sha256=document?.structure_sha256??digest(context.materialMarkdown.get(material.id)!);
   const priorSourceMatches=context.material_origin?.kind==='library_v1'
    ?priorManifest?.format==='redacted-docx-manifest-v2'&&priorManifest.snapshot_digest===context.material_snapshot_digest&&JSON.stringify(priorManifest.material_origin)===JSON.stringify(context.material_origin)
    :priorManifest?.format==='redacted-docx-manifest-v1'&&priorManifest.attempt_id===context.attempt_id;
   const manifestMaterial=priorManifest?.materials.find(item=>item.material_id===material.id),manifestMatches=priorSourceMatches&&priorManifest?.redacted_sha256===context.redacted_sha256&&priorManifest.renderer_version===REDACTED_DOCX_RENDERER_VERSION&&manifestMaterial?.source_sha256===material.sha256&&manifestMaterial?.document_sha256===document_sha256&&manifestMaterial?.docx_artifact_id===current?.id&&manifestMaterial?.docx_sha256===current?.sha256;
   if(current?.attempt_id===context.attempt_id&&current.storage_path===storagePath&&manifestMatches){
    try{const existing=await readSafeFile(projectExportsRoot,storagePath);if(digest(existing)===current.sha256){artifacts.push({artifact_id:String(current.id),material_id:material.id,filename,sha256:current.sha256,reused:true});manifestMaterials.push({material_id:material.id,source_sha256:material.sha256,document_sha256,docx_artifact_id:String(current.id),docx_sha256:current.sha256});continue;}}catch(error){if(!(error instanceof HTTPException&&error.status===404))throw error;}
   }
   const docx=await buildRedactedDocx(document?.document??context.materialMarkdown.get(material.id)!),sha256=digest(docx);
   await installFile(docxPath,docx,sha256,changes);
   const artifactId=current?String(current.id):randomUUID();
   if(current)await db.query('UPDATE ai_distill.artifacts SET attempt_id=$2,storage_path=$3,sha256=$4,size_bytes=$5,content=NULL,created_at=now() WHERE id=$1',[artifactId,context.attempt_id,storagePath,sha256,docx.byteLength]);
   else await db.query("INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content,material_id) VALUES($1,$2,$3,'redacted_docx',$4,$5,$6,NULL,$7)",[artifactId,workflowId,context.attempt_id,storagePath,sha256,docx.byteLength,material.id]);
   artifacts.push({artifact_id:artifactId,material_id:material.id,filename,sha256,reused:false});
   manifestMaterials.push({material_id:material.id,source_sha256:material.sha256,document_sha256,docx_artifact_id:artifactId,docx_sha256:sha256});
  }
  const manifest:DocxManifest=context.material_origin?.kind==='library_v1'
   ?{format:'redacted-docx-manifest-v2',attempt_id:null,material_origin:context.material_origin,snapshot_digest:context.material_snapshot_digest!,redacted_sha256:context.redacted_sha256,renderer_version:REDACTED_DOCX_RENDERER_VERSION,materials:manifestMaterials}
   :{format:'redacted-docx-manifest-v1',attempt_id:context.attempt_id,redacted_sha256:context.redacted_sha256,renderer_version:REDACTED_DOCX_RENDERER_VERSION,materials:manifestMaterials};
  const manifestContent=JSON.stringify(manifest),manifestSha256=digest(manifestContent),manifestFilename='redacted-docx-manifest.json',manifestPath=join(dirname(location.docxPath),manifestFilename),manifestStoragePath=location.storagePath.replace(/[^/]+$/,manifestFilename),currentManifestRow=priorManifestRows.find(row=>row.content===manifestContent),manifestArtifactId=currentManifestRow?String(currentManifestRow.id):priorManifestRows[0]?String(priorManifestRows[0].id):randomUUID();
  await installFile(manifestPath,Buffer.from(manifestContent),manifestSha256,changes);
  if(priorManifestRows.length)await db.query('UPDATE ai_distill.artifacts SET attempt_id=$2,storage_path=$3,sha256=$4,size_bytes=$5,content=$6,material_id=NULL,created_at=now() WHERE id=$1',[manifestArtifactId,context.attempt_id,manifestStoragePath,manifestSha256,Buffer.byteLength(manifestContent),manifestContent]);
  else await db.query("INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content,material_id) VALUES($1,$2,$3,'redacted_docx_manifest',$4,$5,$6,$7,NULL)",[manifestArtifactId,workflowId,context.attempt_id,manifestStoragePath,manifestSha256,Buffer.byteLength(manifestContent),manifestContent]);
  await db.query("DELETE FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx' AND NOT(id=ANY($2::uuid[]))",[workflowId,artifacts.map(artifact=>artifact.artifact_id)]);
  await db.query("DELETE FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx_manifest' AND id<>$2",[workflowId,manifestArtifactId]);
  await db.query('COMMIT');tx=false;
  const oldQuestionDirs=new Set<string>();
  for(const artifact of prior){
   const segments=String(artifact.storage_path??'').split('/');
   if(isLibraryDocxPath(String(artifact.storage_path??''))&&segments[1]?.endsWith(`--${context.project_id.slice(0,8)}`)&&segments[2]?.endsWith(`--${workflowId.slice(0,8)}`))oldQuestionDirs.add(segments.slice(0,3).join('/'));
  }
  try{
   const libraryRoot=await realpath(join(resolve(projectExportsRoot),'附件库'));
   for(const oldDir of oldQuestionDirs){
    const path=resolve(libraryRoot,...oldDir.split('/').slice(1));
    if(path===location.questionDir||!beneath(libraryRoot,path))continue;
    try{const actual=await realpath(path),info=await lstat(path);if(actual===path&&!info.isSymbolicLink()&&info.isDirectory())await rm(path,{recursive:true,force:true});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')console.error('旧版附件库目录清理失败，请手动核对');}
   }
  }catch{console.error('旧版附件库目录清理失败，请手动核对');}
  return{...artifacts[0]!,artifacts,reused:artifacts.every(artifact=>artifact.reused),archive_path:location.archivePath};
 }catch(error){
  if(tx)try{await db.query('ROLLBACK');tx=false;}catch{console.error('DOCX导出索引事务回滚失败');}
  try{await restoreFiles(changes);}catch{console.error('附件库导出失败后文件恢复失败');}
  throw error;
 }finally{db.release();}
}

async function readSafeFile(rootInput:string,storagePath:string){
 if(!storagePath||isAbsolute(storagePath)||storagePath.split(/[\\/]/).some(segment=>!segment||segment==='.'||segment==='..'))throw new HTTPException(404,{message:'当前 DOCX 路径无效'});
 let root:string;try{root=await realpath(rootInput);}catch{throw new HTTPException(404,{message:'DOCX 文件不存在'});}
 const path=resolve(root,storagePath);if(!beneath(root,path))throw new HTTPException(404,{message:'当前 DOCX 路径无效'});
 try{const actual=await realpath(path),info=await lstat(path);if(actual!==path||info.isSymbolicLink()||!info.isFile())throw new HTTPException(404,{message:'当前 DOCX 路径无效'});return await readFile(path);}catch(error){if(error instanceof HTTPException)throw error;if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')throw new HTTPException(404,{message:'DOCX 文件不存在'});throw error;}
}

/** Read only the indexed DOCX when its redaction attempt and file digest remain current. */
export async function readCurrentRedactedDocx(pool:Pool|PoolClient,artifactId:string,projectExportsRoot:string){
 const row=(await pool.query("SELECT ar.id,ar.workflow_id,ar.attempt_id,ar.storage_path,ar.sha256,ar.material_id,w.source_key,p.material_root FROM ai_distill.artifacts ar JOIN ai_distill.workflows w ON w.id=ar.workflow_id AND w.deleted_at IS NULL JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE ar.id=$1 AND ar.kind='redacted_docx'",[artifactId])).rows[0];
 if(!row)return null;
 const redaction=await readCurrentRedactionForDocx(pool,String(row.workflow_id));
 if(row.material_id&&!redaction.materialMarkdown.has(row.material_id))throw new HTTPException(404,{message:'当前脱敏附件已失效'});
 if(redaction.attempt_id!==row.attempt_id)throw new HTTPException(404,{message:'当前脱敏 DOCX 不存在或已过期'});
 const libraryPrefix='附件库/';let bytes:Buffer;
 if(typeof row.storage_path==='string'&&row.storage_path.startsWith(libraryPrefix)){if(!isLibraryDocxPath(row.storage_path))throw new HTTPException(404,{message:'当前 DOCX 路径无效'});bytes=await readSafeFile(projectExportsRoot,row.storage_path);}
 else{
  if(typeof row.material_root!=='string'||typeof row.source_key!=='string')throw new HTTPException(404,{message:'当前脱敏 DOCX 路径无效'});
  const questions=await realpath(row.material_root),projectRoot=await realpath(dirname(questions)),legacyPath=join('outputs',row.source_key,'脱敏材料.docx');
  if(row.storage_path!==legacyPath)throw new HTTPException(404,{message:'当前脱敏 DOCX 路径无效'});
  bytes=await readSafeFile(projectRoot,legacyPath);
 }
 if(digest(bytes)!==row.sha256)throw new HTTPException(404,{message:'当前脱敏 DOCX 指纹校验失败'});
 return{bytes,filename:basename(row.storage_path)};
}
