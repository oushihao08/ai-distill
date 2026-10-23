/**
 * 文件职责：按期次来源模式，将选定脱敏结果或成功提取原文冻结为题目私有附件、结构和来源记录。
 * 关键入口：`createLibraryQuestion()` 负责幂等建题、来源复制、锁序复核与步骤 4–8 创建；不创建旧材料步骤或 attempts。
 * 使用场景：项目加载材料后调用；生成目录只归本题所有，材料库更新不改写已创建题目。
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {STEP_REGISTRY} from '../../shared/step-registry';
import {assertMaterialUse} from './uses';
import {canonicalJson} from '../../shared/workflow-config';
import type {CreateLibraryQuestionRequest} from '../../shared/material-library';
import {readLibraryBlob} from './storage';
import {redactionJobCurrentValidationSql} from './processing-policy';
import {assertLibraryExtractionUsable} from './jobs';
import {resolveMaterialProcessingMode,materialProcessingSourceMode,redactionProcessingMode,type MaterialProcessingMode} from '../../shared/material-library';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const conflict=(message:string)=>new HTTPException(409,{message});
const validText=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max?value:undefined;

export interface ValidLibraryQuestionInput extends CreateLibraryQuestionRequest{
 request_key:string;redaction_id?:string;revision_id?:string;expected_link_version:number;title:string;question_tags:string[];
 scenario?:string;role_perspective?:string;authoring_direction?:string;
}

export function validateLibraryQuestionInput(value:unknown,projectTags:unknown):ValidLibraryQuestionInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'建题参数无效'});
 const input=value as Record<string,unknown>,allowed=['request_key','redaction_id','revision_id','expected_link_version','title','scenario','role_perspective','target_level','authoring_direction','question_tags'];
 if(Object.keys(input).some(key=>!allowed.includes(key)))throw new HTTPException(400,{message:'建题参数包含不支持的字段'});
 if(typeof input.request_key!=='string'||!uuidPattern.test(input.request_key))throw new HTTPException(400,{message:'建题幂等标识无效'});
 if(input.redaction_id!==undefined&&(typeof input.redaction_id!=='string'||!uuidPattern.test(input.redaction_id)))throw new HTTPException(400,{message:'脱敏结果标识无效'});
 if(input.revision_id!==undefined&&(typeof input.revision_id!=='string'||!uuidPattern.test(input.revision_id)))throw new HTTPException(400,{message:'提取版本标识无效'});
 if(Boolean(input.redaction_id)===Boolean(input.revision_id))throw new HTTPException(400,{message:'必须且只能选择脱敏结果或提取版本'});
 if(!Number.isSafeInteger(input.expected_link_version)||Number(input.expected_link_version)<1)throw new HTTPException(400,{message:'加载关系版本无效'});
 if(typeof input.title!=='string'||!input.title.trim()||input.title.trim().length>180)throw new HTTPException(400,{message:'题目标题须为1至180字'});
 for(const [key,max,label] of [['scenario',2000,'场景'],['role_perspective',1000,'角色视角'],['authoring_direction',10000,'出题方向']] as const){
  if(input[key]!==undefined&&(typeof input[key]!=='string'||String(input[key]).length>max))throw new HTTPException(400,{message:`${label}长度无效`});
 }
 if(input.target_level!==undefined&&input.target_level!==null&&!['L2','L3','L4','L5'].includes(String(input.target_level)))throw new HTTPException(400,{message:'题目级别无效'});
 const tags=input.question_tags??[];
 if(!Array.isArray(tags)||tags.length>50||tags.some(tag=>typeof tag!=='string'||!tag.trim())||new Set(tags).size!==tags.length)throw new HTTPException(400,{message:'题目标签无效'});
 const allowedTags=Array.isArray(projectTags)?new Set(projectTags.filter((tag):tag is string=>typeof tag==='string')):new Set<string>();
 if(tags.some(tag=>!allowedTags.has(tag)))throw new HTTPException(400,{message:'题目标签须属于当前项目'});
 return{
  request_key:input.request_key,...(typeof input.redaction_id==='string'?{redaction_id:input.redaction_id}:{}),...(typeof input.revision_id==='string'?{revision_id:input.revision_id}:{}),expected_link_version:Number(input.expected_link_version),title:input.title.trim(),question_tags:tags as string[],
  ...(validText(input.scenario,2000)?{scenario:String(input.scenario)}:{}),...(validText(input.role_perspective,1000)?{role_perspective:String(input.role_perspective)}:{}),
  ...(typeof input.target_level==='string'?{target_level:input.target_level as ValidLibraryQuestionInput['target_level']}:{ }),
  ...(validText(input.authoring_direction,10000)?{authoring_direction:String(input.authoring_direction)}:{}),
 };
}

export function libraryQuestionRequestDigest(value:{project_id:string;project_material_id:string;input:ValidLibraryQuestionInput}){
 const {project_id,project_material_id,input}=value;
 return hash(canonicalJson({version:2,project_id,project_material_id,redaction_id:input.redaction_id??null,revision_id:input.revision_id??null,title:input.title,scenario:input.scenario??null,role_perspective:input.role_perspective??null,target_level:input.target_level??null,authoring_direction:input.authoring_direction??null,question_tags:input.question_tags}));
}

type SourceFile={id:string;original_name:string;position:number;redaction_mode:'model'|'declared_redacted';source_sha256:string;source_size_bytes:number;source_content_type:string;source_storage_path:string;source_storage_target:string;document_content:string;document_blob_sha256:string;document_sha256:string;document_issues:unknown;};
type FrozenSource={processing_mode:MaterialProcessingMode;material_mode:'redacted'|'original';project_id:string;project_name:string;project_tags:string[];package_id:string;package_name:string;revision_id:string;redaction_id:string|null;source_digest:string;markdown:string;markdown_sha256:string;index:string;index_sha256:string;files:SourceFile[];};

async function transaction<T>(pool:Pool,action:(db:PoolClient)=>Promise<T>,beforeCommit?:()=>void):Promise<T>{
 const db=await pool.connect();
 try{await db.query('BEGIN');const result=await action(db);beforeCommit?.();await db.query('COMMIT');return result;}
 catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'题目快照事务失败且回滚状态不确定');}throw error;}
 finally{db.release();}
}

async function locatePackage(pool:Pool,projectId:string,linkId:string){
 const row=(await pool.query('SELECT package_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2',[linkId,projectId])).rows[0];
 if(!row)throw new HTTPException(404,{message:'项目加载的材料包不存在'});
 return String(row.package_id);
}

async function lockAndReadSource(db:PoolClient,projectId:string,linkId:string,packageId:string,input:ValidLibraryQuestionInput):Promise<FrozenSource>{
 const pkg=(await db.query('SELECT id,name,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[packageId])).rows[0];
 if(!pkg||pkg.deleted_at)throw conflict('材料包已归档或不存在，不能建题');
 await db.query('SELECT g.id FROM ai_distill.project_groups g JOIN ai_distill.projects p ON p.project_group_id=g.id WHERE p.id=$1 FOR UPDATE OF g',[projectId]);
 const project=(await db.query('SELECT id,name,material_backend,workspace_path,local_skill_path,question_tags,deleted_at,project_group_id,parent_name FROM ai_distill.projects WHERE id=$1 FOR UPDATE',[projectId])).rows[0];
 if(!project||project.deleted_at)throw new HTTPException(404,{message:'项目不存在'});
 const packageLevel=/(?:^|[-_\s])L([2-5])(?=$|[-_\s])/i.exec(String(pkg.name))?.[1];
 if(packageLevel&&input.target_level!==`L${packageLevel}`)throw conflict(`材料包标题标注为L${packageLevel}，题目目标等级须为L${packageLevel}`);
 if(input.question_tags.some(tag=>!Array.isArray(project.question_tags)||!project.question_tags.includes(tag)))throw conflict('项目出题标签已变化，请刷新后重试');
 const link=(await db.query(`SELECT id,project_id,package_id,selected_revision_id,selected_redaction_id,lock_version,removed_at,material_use_id
  FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2 FOR UPDATE`,[linkId,projectId])).rows[0];
 if(!link||link.removed_at||link.package_id!==packageId)throw conflict('项目材料加载关系已移除或已变化');
 const activeQuestion=(await db.query(`SELECT q.workflow_id
  FROM ai_distill.question_library_sources q JOIN ai_distill.workflows w ON w.id=q.workflow_id
  WHERE q.project_id=$1 AND q.package_id=$2 AND w.deleted_at IS NULL LIMIT 1`,[projectId,packageId])).rows[0];
 if(activeQuestion&&singleQuestionPerPackage(project))throw conflict('Work法律全场景每个材料包只能对应一道题，请在原题返修');
 if(project.project_group_id)await assertMaterialUse(db,projectId,packageId,link.material_use_id);
 if(Number(link.lock_version)!==input.expected_link_version)throw conflict('材料选择已更新，请刷新项目后重试');
 const authorConfig=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=4',[projectId])).rows[0]?.config;
 const processingMode=resolveMaterialProcessingMode(authorConfig),materialMode=materialProcessingSourceMode(processingMode);
 if(processingMode==='mask')throw conflict('旧遮挡模式已退役，请明确选择Agent化名或提取原文后再建新题');
 if(materialMode==='original'){
  if(input.redaction_id||input.revision_id!==link.selected_revision_id||link.selected_redaction_id!==null||!link.selected_revision_id)throw conflict('未脱敏提取版本与本期设置或当前材料选择不一致');
  const extraction=(await db.query(`SELECT e.id,r.file_count FROM ai_distill.library_revisions r
    JOIN ai_distill.library_jobs e ON e.revision_id=r.id AND e.kind='extract' AND e.status='succeeded'
    WHERE r.id=$1 AND r.package_id=$2 AND r.state='ready' ORDER BY e.finished_at DESC,e.id DESC LIMIT 1`,[link.selected_revision_id,packageId])).rows[0];
  if(!extraction)throw conflict('该材料版本尚无成功提取结果');
  const rows=(await db.query(`SELECT f.id,f.original_name,f.position,f.redaction_mode,source.sha256 AS source_sha256,source.size_bytes AS source_size_bytes,
    source.content_type AS source_content_type,source.storage_path AS source_storage_path,source.storage_target AS source_storage_target,
    d.document_blob_id,doc.text_content AS document_content,doc.sha256 AS document_blob_sha256,d.text_sha256 AS document_sha256,d.issues AS document_issues
   FROM ai_distill.library_files f JOIN ai_distill.library_blobs source ON source.id=f.blob_id
   JOIN ai_distill.library_documents d ON d.revision_id=f.revision_id AND d.file_id=f.id AND d.extraction_job_id=$2
   JOIN ai_distill.library_blobs doc ON doc.id=d.document_blob_id WHERE f.revision_id=$1 ORDER BY f.position`,[link.selected_revision_id,extraction.id])).rows as SourceFile[];
  if(!rows.length||rows.length!==Number(extraction.file_count))throw conflict('原文提取结果不完整');
  const indexMaterials:any[]=[],markdownParts:string[]=[];
  for(const file of rows){
   if(typeof file.document_content!=='string'||hash(file.document_content)!==file.document_blob_sha256)throw conflict('原文提取结构摘要校验失败');
   let document:any;try{document=JSON.parse(file.document_content);}catch{throw conflict('原文提取结构无效');}
   assertLibraryExtractionUsable([{issues:file.document_issues,pages:document.pages}]);
   if(document.version!==1||document.source_sha256!==file.source_sha256||hash(document.pages.map((page:any)=>page.text).join('\n'))!==file.document_sha256)throw conflict('原文提取正文摘要校验失败');
   const text=document.pages.map((page:any)=>String(page.text??'')).filter(Boolean).join('\n\n');
   if(!text.trim())throw conflict('原文提取结果没有可用正文');
   markdownParts.push(`# ${file.original_name}\n\n${text}`);
   indexMaterials.push({material_id:file.id,markdown:text,document});
  }
  const markdown=markdownParts.join('\n\n---\n\n'),index=JSON.stringify({format:'source-index-v1',materials:indexMaterials});
  const markdownSha=hash(markdown),indexSha=hash(index),sourceDigest=hash(canonicalJson({revision_id:link.selected_revision_id,extraction_job_id:extraction.id,files:rows.map(file=>({id:file.id,source_sha256:file.source_sha256,document_sha256:file.document_sha256,document_blob_sha256:file.document_blob_sha256}))}));
  return{processing_mode:processingMode,material_mode:'original',project_id:project.id,project_name:project.name,project_tags:project.question_tags??[],package_id:pkg.id,package_name:pkg.name,revision_id:String(link.selected_revision_id),redaction_id:null,source_digest:sourceDigest,markdown,markdown_sha256:markdownSha,index,index_sha256:indexSha,files:rows};
 }
 if(!input.redaction_id||link.selected_redaction_id!==input.redaction_id||!link.selected_revision_id)throw conflict('所选脱敏结果与项目当前选择不一致');
 const redaction=(await db.query(`SELECT r.id,r.package_id,r.revision_id,r.extraction_job_id,r.output_digest,r.validation_report,
   m.text_content AS markdown,m.sha256 AS markdown_sha256,i.text_content AS redacted_index,i.sha256 AS index_sha256,
   rev.state AS revision_state,redact_job.status AS redact_status,extract_job.status AS extract_status,
   redact_job.config_snapshot->'redaction_template'->>'workflow' AS redaction_template_workflow
  FROM ai_distill.library_redactions r JOIN ai_distill.library_blobs m ON m.id=r.markdown_blob_id
  JOIN ai_distill.library_blobs i ON i.id=r.index_blob_id JOIN ai_distill.library_revisions rev ON rev.id=r.revision_id AND rev.package_id=r.package_id
  JOIN ai_distill.library_jobs redact_job ON redact_job.id=r.redaction_job_id AND redact_job.kind='redact'
  JOIN ai_distill.library_jobs extract_job ON extract_job.id=r.extraction_job_id AND extract_job.kind='extract'
  WHERE r.id=$1 AND r.package_id=$2 AND r.revision_id=$3 AND ${redactionJobCurrentValidationSql('redact_job')}`,[input.redaction_id,packageId,link.selected_revision_id])).rows[0];
 if(!redaction||redaction.revision_state!=='ready'||redaction.redact_status!=='succeeded'||redaction.extract_status!=='succeeded'||redaction.validation_report?.usable_for_question!==true)throw conflict('所选脱敏结果尚未完整成功或不适用于建题');
 if(redactionProcessingMode({...redaction.validation_report,redaction_template_workflow:redaction.redaction_template_workflow??redaction.validation_report?.redaction_template_workflow})!==processingMode)throw conflict('该脱敏结果的处理方式与本期设置不一致，请选择对应版本');
 if(typeof redaction.markdown!=='string'||typeof redaction.redacted_index!=='string'||hash(redaction.markdown)!==redaction.markdown_sha256||hash(redaction.redacted_index)!==redaction.index_sha256)throw conflict('材料库脱敏产物摘要校验失败');
 let parsedIndex:any;try{parsedIndex=JSON.parse(redaction.redacted_index);}catch{throw conflict('材料库脱敏结构索引无效');}
 if(parsedIndex?.format!=='redacted-index-v2'||parsedIndex.redacted_sha256!==redaction.markdown_sha256||!Array.isArray(parsedIndex.materials))throw conflict('材料库脱敏索引与正文不匹配');
 const rows=(await db.query(`SELECT f.id,f.original_name,f.position,f.redaction_mode,source.sha256 AS source_sha256,source.size_bytes AS source_size_bytes,
   source.content_type AS source_content_type,source.storage_path AS source_storage_path,source.storage_target AS source_storage_target,
   d.document_blob_id,doc.text_content AS document_content,doc.sha256 AS document_blob_sha256,d.text_sha256 AS document_sha256,d.issues AS document_issues
  FROM ai_distill.library_files f JOIN ai_distill.library_blobs source ON source.id=f.blob_id
  JOIN ai_distill.library_documents d ON d.revision_id=f.revision_id AND d.file_id=f.id AND d.extraction_job_id=$2
  JOIN ai_distill.library_blobs doc ON doc.id=d.document_blob_id
  WHERE f.revision_id=$1 ORDER BY f.position`,[redaction.revision_id,redaction.extraction_job_id])).rows as SourceFile[];
 if(!rows.length||rows.length!==Number((await db.query('SELECT file_count FROM ai_distill.library_revisions WHERE id=$1',[redaction.revision_id])).rows[0]?.file_count)||rows.length!==parsedIndex.materials.length)throw conflict('所选脱敏结果缺少完整附件或结构');
 for(const file of rows){
  if(!parsedIndex.materials.some((item:any)=>item?.material_id===file.id)||typeof file.document_content!=='string'||hash(file.document_content)!==file.document_blob_sha256||file.document_blob_sha256===undefined)throw conflict('材料提取结构与脱敏附件对应关系不完整');
  let document:any;try{document=JSON.parse(file.document_content);}catch{throw conflict('材料提取结构无效');}
  assertLibraryExtractionUsable([{issues:file.document_issues,pages:document.pages}]);
  if(document.version!==1||document.source_sha256!==file.source_sha256||hash(document.pages.map((page:any)=>page.text).join('\n'))!==file.document_sha256)throw conflict('材料提取正文摘要校验失败');
 }
 return{processing_mode:processingMode,material_mode:'redacted',project_id:project.id,project_name:project.name,project_tags:project.question_tags??[],package_id:pkg.id,package_name:pkg.name,revision_id:redaction.revision_id,redaction_id:redaction.id,source_digest:redaction.output_digest,markdown:redaction.markdown,markdown_sha256:redaction.markdown_sha256,index:redaction.redacted_index,index_sha256:redaction.index_sha256,files:rows};
}

async function copyPrivateSource(root:string,questionId:string,source:FrozenSource){
 const directory=join(resolve(root),questionId),mapping=new Map<string,string>();
 await mkdir(directory,{recursive:true,mode:0o700});
 const files=[];
 for(const file of source.files){
  if(file.source_storage_target!=='local')throw conflict('材料原件位于另一执行节点，当前环境尚未接入跨节点传输');
  const bytes=await readLibraryBlob(root,file.source_storage_path,file.source_sha256);
  if(bytes.byteLength!==Number(file.source_size_bytes))throw conflict('材料原件大小与来源清单不一致');
  const materialId=randomUUID(),sourceArtifactId=randomUUID(),pagesArtifactId=randomUUID();
  const sourcePath=`${questionId}/${materialId}.source`,pagesPath=`${questionId}/${materialId}.extracted.json`;
  const sourceDocument=JSON.parse(file.document_content),sourceDocumentBytes=Buffer.from(file.document_content);
  await writeFile(join(directory,`${materialId}.source`),bytes,{mode:0o600,flag:'wx'});
  await writeFile(join(directory,`${materialId}.extracted.json`),sourceDocumentBytes,{mode:0o600,flag:'wx'});
  mapping.set(file.id,materialId);
  files.push({file,materialId,sourceArtifactId,pagesArtifactId,sourcePath,pagesPath,sourceDocument,sourceDocumentBytes});
 }
 return{directory,files,mapping};
}

export function remapLibraryRedactedIndex(source:Pick<FrozenSource,'index'|'material_mode'>,mapping:Map<string,string>){
 const index=JSON.parse(source.index);
 if(source.material_mode==='original'){
  if(index?.format!=='source-index-v1'||!Array.isArray(index.materials))throw conflict('原文结构索引无效');
  index.materials=index.materials.map((item:any)=>{const target=mapping.get(item.material_id);if(!target)throw conflict('原文索引引用了不存在的附件');return{...item,material_id:target};});
  return JSON.stringify(index);
 }
 if(index?.format!=='redacted-index-v2'||!Array.isArray(index.materials)||!Array.isArray(index.pages))throw conflict('脱敏结构索引无效');
 const remap=(id:string)=>{const target=mapping.get(id);if(!target)throw conflict('脱敏索引引用了不存在的附件');return target;};
 index.materials=index.materials.map((item:any)=>({...item,material_id:remap(item.material_id)}));
 index.pages=index.pages.map((item:any)=>({...item,material_id:remap(item.material_id)}));
 if(Array.isArray(index.prepared_documents))index.prepared_documents=index.prepared_documents.map((document:any)=>({...document,...(Array.isArray(document.segments)?{segments:document.segments.map((segment:any)=>({...segment,file_id:remap(segment.file_id)}))}:{})}));
 return JSON.stringify(index);
}

export function libraryQuestionStepOrdinals(){return STEP_REGISTRY.filter(item=>item.ordinal>=4&&item.ordinal<=8).map(item=>item.ordinal);}

export async function createLibraryQuestion(pool:Pool,storageRoot:string,projectId:string,linkId:string,value:unknown){
 const packageId=await locatePackage(pool,projectId,linkId);
 const projectTags=(await pool.query('SELECT question_tags FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows[0]?.question_tags;
 const input=validateLibraryQuestionInput(value,projectTags);
 const requestDigest=libraryQuestionRequestDigest({project_id:projectId,project_material_id:linkId,input});
 const prior=(await pool.query('SELECT workflow_id,request_digest FROM ai_distill.question_library_sources WHERE project_id=$1 AND request_key=$2',[projectId,input.request_key])).rows[0];
 if(prior){if(prior.request_digest!==requestDigest)throw conflict('同一建题幂等标识对应了不同请求内容');return{id:prior.workflow_id,reused:true};}
 const first=await transaction(pool,async db=>lockAndReadSource(db,projectId,linkId,packageId,input));
 const questionId=randomUUID(),markdownArtifactId=randomUUID(),indexArtifactId=randomUUID();
 let copied:Awaited<ReturnType<typeof copyPrivateSource>>|undefined,commitAttempted=false;
 try{
  copied=await copyPrivateSource(storageRoot,questionId,first);
  const indexText=remapLibraryRedactedIndex(first,copied.mapping),indexSha=hash(indexText),indexPath=`${questionId}/${first.material_mode==='original'?'source':'redacted'}_index.json`,markdownPath=`${questionId}/${first.material_mode==='original'?'source':'redacted'}_markdown.md`;
  await writeFile(join(copied.directory,`${first.material_mode==='original'?'source':'redacted'}_markdown.md`),first.markdown,{mode:0o600,flag:'wx'});
  await writeFile(join(copied.directory,`${first.material_mode==='original'?'source':'redacted'}_index.json`),indexText,{mode:0o600,flag:'wx'});
  const manifest={version:2,origin:{kind:'library_v1',material_processing_mode:first.processing_mode,material_mode:first.material_mode,package_id:packageId,package_name:first.package_name,revision_id:first.revision_id,redaction_id:first.redaction_id,source_digest:first.source_digest},files:copied.files.map(({file,materialId,sourceArtifactId,pagesArtifactId})=>({library_file_id:file.id,material_id:materialId,source_sha256:file.source_sha256,document_sha256:file.document_sha256,source_artifact_id:sourceArtifactId,pages_artifact_id:pagesArtifactId,position:file.position,original_name:file.original_name})),material_markdown:{artifact_id:markdownArtifactId,sha256:first.markdown_sha256,kind:first.material_mode==='original'?'source_markdown':'redacted_markdown'},material_index:{artifact_id:indexArtifactId,sha256:indexSha,kind:first.material_mode==='original'?'source_index':'redacted_index'}};
  const snapshotDigest=hash(canonicalJson(manifest)),sourceManifest=copied.files.map(({file})=>({name:file.original_name,path:markdownPath,size:Buffer.byteLength(first.markdown),sha256:first.markdown_sha256}));
  const result=await transaction(pool,async db=>{
   const current=await lockAndReadSource(db,projectId,linkId,packageId,input);
   if(current.processing_mode!==first.processing_mode||current.source_digest!==first.source_digest||current.markdown_sha256!==first.markdown_sha256||current.index_sha256!==first.index_sha256)throw conflict('材料来源在复制期间发生变化，请重新建题');
   const existing=(await db.query('SELECT workflow_id,request_digest FROM ai_distill.question_library_sources WHERE project_id=$1 AND request_key=$2',[projectId,input.request_key])).rows[0];
   if(existing){if(existing.request_digest!==requestDigest)throw conflict('同一建题幂等标识对应了不同请求内容');return{id:existing.workflow_id,reused:true};}
   await db.query(`INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_manifest,workflow_kind,scenario,role_perspective,target_level,question_tags,authoring_direction)
    VALUES($1,$2,$3,$4,$5::jsonb,'question',$6,$7,$8,$9,$10)`,[questionId,projectId,randomUUID(),input.title,JSON.stringify(sourceManifest),input.scenario??null,input.role_perspective??null,input.target_level??null,input.question_tags,input.authoring_direction??null]);
   for(const item of copied!.files){
    const {file,materialId,sourcePath,pagesPath,pagesArtifactId,sourceArtifactId,sourceDocumentBytes}=item;
    await db.query(`INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes,content_type,processing_status,redaction_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[materialId,questionId,file.original_name,sourcePath,file.source_sha256,file.source_size_bytes,file.source_content_type,first.material_mode==='original'?'text_extracted':'redacted',file.redaction_mode]);
    await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content)
     VALUES($1,$2,$3,NULL,'private_extracted_pages',$4,$5,$6,$7)`,[pagesArtifactId,questionId,materialId,pagesPath,file.document_blob_sha256,sourceDocumentBytes.byteLength,sourceDocumentBytes.toString('utf8')]);
    await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes)
     VALUES($1,$2,$3,NULL,'source_document',$4,$5,$6)`,[sourceArtifactId,questionId,materialId,sourcePath,file.source_sha256,file.source_size_bytes]);
   }
   const markdownKind=first.material_mode==='original'?'source_markdown':'redacted_markdown',indexKind=first.material_mode==='original'?'source_index':'redacted_index';
   await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content)
    VALUES($1,$2,NULL,NULL,$3,$4,$5,$6,$7)`,[markdownArtifactId,questionId,markdownKind,markdownPath,first.markdown_sha256,Buffer.byteLength(first.markdown),first.markdown]);
   await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content)
    VALUES($1,$2,NULL,NULL,$3,$4,$5,$6,$7)`,[indexArtifactId,questionId,indexKind,indexPath,indexSha,Buffer.byteLength(indexText),indexText]);
   await db.query(`INSERT INTO ai_distill.question_library_sources(workflow_id,project_id,project_material_id,package_id,revision_id,redaction_id,source_digest,snapshot_manifest,snapshot_digest,markdown_artifact_id,index_artifact_id,request_key,request_digest,material_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,[questionId,projectId,linkId,packageId,first.revision_id,first.redaction_id,first.source_digest,JSON.stringify(manifest),snapshotDigest,markdownArtifactId,indexArtifactId,input.request_key,requestDigest,first.material_mode]);
   for(const stage of STEP_REGISTRY.filter(item=>libraryQuestionStepOrdinals().includes(item.ordinal)))await db.query(`INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position,enabled)
    VALUES($1,$2,$3,'waiting',$4,$5,$6,$4)`,[questionId,stage.ordinal,stage.name,stage.defaultEnabled,stage.key,stage.position]);
   return{id:questionId,reused:false,source_digest:first.source_digest,snapshot_digest:snapshotDigest};
  },()=>{commitAttempted=true;});
  if(result.reused)await rm(copied.directory,{recursive:true,force:true});
  return result;
 }catch(error){
  if(copied){
   try{const existing=(await pool.query('SELECT workflow_id,request_digest FROM ai_distill.question_library_sources WHERE project_id=$1 AND request_key=$2',[projectId,input.request_key])).rows[0];
    if(existing?.request_digest===requestDigest){if(existing.workflow_id!==questionId)await rm(copied.directory,{recursive:true,force:true});return{id:existing.workflow_id,reused:existing.workflow_id!==questionId};}
    if(!existing&&!commitAttempted)await rm(copied.directory,{recursive:true,force:true});
   }catch{throw new AggregateError([error],'建题提交状态未知，已保留私有目录供核对');}
  }
  throw error;
 }
}

/** Work项目明确一包一道；其他主项目不继承此业务限制。历史题目与来源不改写。 */
export function singleQuestionPerPackage(project:{parent_name?:string|null;name?:string|null}){
 return(project.parent_name??project.name?.split(' - ')[0])==='Work法律全场景';
}
