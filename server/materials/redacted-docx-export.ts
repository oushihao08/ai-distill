/**
 * 职责：校验当前脱敏输入、归档当前原件副本并生成可选 DOCX，安全下载现行产物。
 * 主要入口：`exportRedactedDocx()` 手动归档；`readCurrentRedactedDocx()` 校验指纹后读取。
 * 使用场景：由工作流 API 调用；不派发 worker 任务或写入步骤、尝试、发布与返修状态。
 */
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {STEP_REGISTRY} from '@shared/step-registry';
import {redactionInputDigest} from './redaction-jobs';
import {buildRedactedDocx} from './redacted-docx';

const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const beneath=(root:string,path:string)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel);};
type Source={material_id:string;source_sha256:string;artifact_id:string;artifact_sha256:string};
type Original={id:string;original_name:string;storage_path:string;sha256:string;size_bytes:number|string};
type FileChange={path:string;previous:Buffer|null};
type ExportContext={workflow_id:string;project_id:string;project_name:string;title:string;attempt_id:string;redacted_sha256:string;markdown:string;originals:Original[]};
type ArchiveLocation={questionDir:string;originalDir:string;docxPath:string;storagePath:string;archivePath:string};

function safeLabel(value:string,fallback:string,id:string){
 const normalized=value.normalize('NFKC').replace(/[\\/\u0000-\u001f<>:"|?*]/g,'_').replace(/\s+/g,' ').replace(/^\.+|\.+$/g,'').trim();
 let label='';for(const character of normalized){if(Buffer.byteLength(label+character)>190)break;label+=character;}label||=fallback;
 return`${label}--${id.slice(0,8)}`;
}
function isLibraryDocxPath(path:string){const segments=path.split('/');return segments.length===5&&segments[0]==='附件库'&&Boolean(segments[1]&&segments[2])&&segments[3]==='成果'&&segments[4]==='脱敏材料.docx'&&!segments.some(segment=>segment==='.'||segment==='..');}
async function ensureDirectory(path:string,restrictAccess=true,allowParentAliases=false){
 await mkdir(path,{recursive:true,mode:0o700});
 let actual:string;try{actual=await realpath(path);}catch{throw new HTTPException(409,{message:'附件库目录不可读取'});}
 let info;try{info=await lstat(path);}catch{throw new HTTPException(409,{message:'附件库目录不可读取'});}
 if((actual!==path&&!allowParentAliases)||info.isSymbolicLink()||!info.isDirectory())throw new HTTPException(409,{message:'附件库目录不能包含符号链接'});
 if(restrictAccess)await chmod(path,0o700);
 return actual;
}
async function archiveLocation(exportRootInput:string,projectId:string,projectName:string,workflowId:string,title:string):Promise<ArchiveLocation>{
 const exportRoot=await ensureDirectory(resolve(exportRootInput),false,true);
 const libraryRoot=join(exportRoot,'附件库');await ensureDirectory(libraryRoot);
 const projectDir=join(libraryRoot,safeLabel(projectName,'项目',projectId));await ensureDirectory(projectDir);
 const questionDir=join(projectDir,safeLabel(title,'题目',workflowId));await ensureDirectory(questionDir);
 const originalDir=join(questionDir,'原件'),resultDir=join(questionDir,'成果');await ensureDirectory(originalDir);await ensureDirectory(resultDir);
 const docxPath=join(resultDir,'脱敏材料.docx');
 if(!beneath(exportRoot,docxPath)||!beneath(questionDir,docxPath))throw new HTTPException(409,{message:'附件库导出路径无效'});
 return{questionDir,originalDir,docxPath,storagePath:relative(exportRoot,docxPath).split(sep).join('/'),archivePath:relative(exportRoot,questionDir).split(sep).join('/')};
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
 const result=await db.query("SELECT DISTINCT ON(m.id) m.id AS material_id,m.sha256 AS source_sha256,ar.id AS artifact_id,ar.sha256 AS artifact_sha256 FROM ai_distill.materials m JOIN ai_distill.artifacts ar ON ar.workflow_id=m.workflow_id AND ar.material_id=m.id AND ar.kind='private_extracted_pages' JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id AND a.status='succeeded' WHERE m.workflow_id=$1 AND m.deleted_at IS NULL ORDER BY m.id,a.finished_at DESC NULLS LAST,ar.created_at DESC,ar.id DESC",[workflowId]);
 const total=Number((await db.query('SELECT count(*)::int AS count FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL',[workflowId])).rows[0]?.count??0);
 if(!total||result.rows.length!==total)throw new HTTPException(409,{message:'当前附件尚无完整入库文本'});
 return result.rows as Source[];
}

async function currentRedaction(db:Pool|PoolClient,workflowId:string){
 const step=(await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9',[workflowId])).rows[0];
 const row=(await db.query("SELECT a.id,a.status,a.input,a.result,ar.id AS artifact_id,ar.content,ar.sha256 FROM ai_distill.step_attempts a JOIN ai_distill.artifacts ar ON ar.workflow_id=a.workflow_id AND ar.attempt_id=a.id AND ar.kind='redacted_markdown' WHERE a.workflow_id=$1 AND a.ordinal=9 ORDER BY a.attempt DESC LIMIT 1",[workflowId])).rows[0];
 if(step?.status!=='succeeded'||row?.status!=='succeeded'||typeof row.content!=='string')throw new HTTPException(409,{message:'当前脱敏结果未完成'});
 const input=row.input&&typeof row.input==='object'?row.input as {digest?:unknown;materials?:unknown}:{};
 const sources=await readCurrentSources(db,workflowId);
 if(typeof input.digest!=='string'||input.digest!==redactionInputDigest(sources)||!Array.isArray(input.materials)||redactionInputDigest(input.materials as Source[])!==input.digest||digest(row.content)!==row.sha256||row.result?.redacted_sha256!==row.sha256)throw new HTTPException(409,{message:'当前脱敏结果与附件版本不一致'});
 return{attempt_id:String(row.id),redacted_sha256:String(row.sha256),markdown:String(row.content)};
}

async function contextForExport(db:Pool|PoolClient,workflowId:string,requireCompleted:boolean):Promise<ExportContext>{
 const workflow=(await db.query('SELECT w.id AS workflow_id,w.project_id,w.title,p.name AS project_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 if(requireCompleted){
  const steps=(await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN (2,3) ORDER BY display_position NULLS LAST,ordinal FOR UPDATE',[workflowId])).rows;
  const statuses=new Map(steps.map((step:any)=>[Number(step.ordinal),step.status]));
  if(STEP_REGISTRY.filter(step=>step.visible).some(step=>!['succeeded','skipped'].includes(String(statuses.get(step.ordinal))))||statuses.get(8)!=='succeeded')throw new HTTPException(409,{message:'请先完成当前工作流并归档达标题目'});
  const active=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal<>10 AND status IN ('waiting','running') LIMIT 1",[workflowId])).rowCount;
  if(active)throw new HTTPException(409,{message:'当前仍有工作流任务执行中'});
 }
 const redaction=await currentRedaction(db,workflowId);
 if(typeof workflow.project_name!=='string'||typeof workflow.title!=='string')throw new HTTPException(409,{message:'项目或题目名称不完整'});
 const originals=(await db.query('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id',[workflowId])).rows as Original[];
 if(!originals.length)throw new HTTPException(409,{message:'当前题目没有可归档附件'});
 return{...workflow,project_name:workflow.project_name,title:workflow.title,...redaction,originals};
}

/** Manually archive current original files and one generated DOCX; never changes workflow steps. */
export async function exportRedactedDocx(pool:Pool,workflowId:string,storageRoot:string,projectExportsRoot:string){
 const db=await pool.connect();let tx=false;const changes:FileChange[]=[];
 try{
  await db.query('BEGIN');tx=true;
  const context=await contextForExport(db,workflowId,true),location=await archiveLocation(projectExportsRoot,context.project_id,context.project_name,context.workflow_id,context.title);
  const prior=(await db.query("SELECT id,attempt_id,sha256,storage_path FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx' ORDER BY created_at DESC,id DESC FOR UPDATE",[workflowId])).rows;
  for(const material of context.originals){
   const bytes=await safeOriginalBytes(storageRoot,material),normalizedName=basename(material.original_name).normalize('NFKC').replace(/[\\/\u0000-\u001f<>:"|?*]/g,'_').replace(/^\.+|\.+$/g,'');let name='';for(const character of normalizedName){if(Buffer.byteLength(name+character)>180)break;name+=character;}name||='附件';
   const target=join(location.originalDir,`${material.id.slice(0,8)}_${name}`);if(!beneath(location.questionDir,target))throw new HTTPException(409,{message:'附件归档路径无效'});
   await installFile(target,bytes,material.sha256,changes);
  }
  const current=prior[0];
  if(current?.attempt_id===context.attempt_id&&current.storage_path===location.storagePath){
   try{const existing=await readFile(location.docxPath);if(digest(existing)===current.sha256){await db.query('COMMIT');tx=false;return{artifact_id:current.id,sha256:current.sha256,reused:true,archive_path:location.archivePath};}}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  }
  const docx=await buildRedactedDocx(context.markdown),sha256=digest(docx);
  await installFile(location.docxPath,docx,sha256,changes);
  const size=docx.byteLength;let artifactId:string;
  if(current){artifactId=String(current.id);await db.query('UPDATE ai_distill.artifacts SET attempt_id=$2,storage_path=$3,sha256=$4,size_bytes=$5,content=NULL,created_at=now() WHERE id=$1',[artifactId,context.attempt_id,location.storagePath,sha256,size]);}
  else{artifactId=randomUUID();await db.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,\'redacted_docx\',$4,$5,$6,NULL)',[artifactId,workflowId,context.attempt_id,location.storagePath,sha256,size]);}
  if(prior.length>1)await db.query("DELETE FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx' AND id<>$2",[workflowId,artifactId]);
  await db.query('COMMIT');tx=false;return{artifact_id:artifactId,sha256,reused:false,archive_path:location.archivePath};
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
export async function readCurrentRedactedDocx(pool:Pool,artifactId:string,projectExportsRoot:string){
 const row=(await pool.query("SELECT ar.id,ar.workflow_id,ar.attempt_id,ar.storage_path,ar.sha256,w.source_key,p.material_root FROM ai_distill.artifacts ar JOIN ai_distill.workflows w ON w.id=ar.workflow_id AND w.deleted_at IS NULL JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE ar.id=$1 AND ar.kind='redacted_docx'",[artifactId])).rows[0];
 if(!row)return null;
 const redaction=await currentRedaction(pool,String(row.workflow_id));
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
 return{bytes,filename:'脱敏材料.docx'};
}
