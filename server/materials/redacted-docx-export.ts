/**
 * 职责：校验单题导出前置条件、生成并索引可选脱敏 DOCX，及安全读取当前导出。
 * 主要入口：`exportRedactedDocx()` 手动生成；`readCurrentRedactedDocx()` 拒绝过期或被篡改文件。
 * 使用场景：由独立工作流 API 调用；不派发 worker 任务或写入步骤、尝试、发布与返修状态。
 */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {STEP_REGISTRY} from '@shared/step-registry';
import {redactionInputDigest} from './redaction-jobs';
import {buildRedactedDocx} from './redacted-docx';

const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const beneath=(root:string,path:string)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel);};
type Source={material_id:string;source_sha256:string;artifact_id:string;artifact_sha256:string};
type ExportContext={workflow_id:string;project_id:string;title:string;source_key:string;material_root:string;attempt_id:string;redacted_sha256:string;markdown:string;docx:Uint8Array};

async function outputLocation(materialRoot:string,sourceKey:string,create=false){
 if(typeof sourceKey!=='string'||!sourceKey.trim()||sourceKey!==sourceKey.trim()||sourceKey==='.'||sourceKey==='..'||/[\\/\u0000-\u001f]/.test(sourceKey)||sourceKey.length>240)throw new HTTPException(409,{message:'题目目录标识不适合安全导出'});
 let questions:string;try{questions=await realpath(materialRoot);if(!(await stat(questions)).isDirectory())throw new Error('not a directory');}catch{throw new HTTPException(409,{message:'项目题目目录不可读取'});}
 const projectRoot=await realpath(dirname(questions)),outputs=join(projectRoot,'outputs'),questionDir=join(outputs,sourceKey),filePath=join(questionDir,'脱敏材料.docx');
 if(!beneath(projectRoot,outputs)||!beneath(outputs,questionDir)||!beneath(questionDir,filePath))throw new HTTPException(409,{message:'导出路径无效'});
 if(create)await mkdir(outputs,{recursive:true,mode:0o700});
 let outputsReal:string;try{outputsReal=await realpath(outputs);}catch{throw new HTTPException(404,{message:'项目 outputs 目录不存在'});}
 if(outputsReal!==outputs)throw new HTTPException(409,{message:'项目 outputs 目录不能是符号链接'});
 if(create)await mkdir(questionDir,{recursive:true,mode:0o700});
 let questionReal:string;try{questionReal=await realpath(questionDir);}catch{throw new HTTPException(404,{message:'题目成果目录不存在'});}
 if(questionReal!==questionDir||!beneath(outputsReal,questionReal))throw new HTTPException(409,{message:'题目成果目录不能越出 outputs'});
 return{projectRoot,filePath,storagePath:relative(projectRoot,filePath)};
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
 const workflow=(await db.query('SELECT w.id AS workflow_id,w.project_id,w.title,w.source_key,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 if(requireCompleted){
  const steps=(await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN (2,3) ORDER BY display_position NULLS LAST,ordinal FOR UPDATE',[workflowId])).rows;
  const statuses=new Map(steps.map((step:any)=>[Number(step.ordinal),step.status]));
  if(STEP_REGISTRY.filter(step=>step.visible).some(step=>!['succeeded','skipped'].includes(String(statuses.get(step.ordinal))))||statuses.get(8)!=='succeeded')throw new HTTPException(409,{message:'请先完成当前工作流并归档达标题目'});
  const active=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal<>10 AND status IN ('waiting','running') LIMIT 1",[workflowId])).rowCount;
  if(active)throw new HTTPException(409,{message:'当前仍有工作流任务执行中'});
 }
 const redaction=await currentRedaction(db,workflowId);
 if(typeof workflow.material_root!=='string'||typeof workflow.source_key!=='string')throw new HTTPException(409,{message:'项目题目目录配置不完整'});
 const docx=buildRedactedDocx(redaction.markdown);
 return{...workflow,material_root:workflow.material_root,source_key:workflow.source_key,...redaction,docx};
}

/** Generate or replace a single current DOCX export; only the artifact index is written. */
export async function exportRedactedDocx(pool:Pool,workflowId:string){
 const db=await pool.connect();let tx=false,tempPath='',finalPath='',previous:Buffer|undefined,replaced=false;
 try{
  await db.query('BEGIN');tx=true;
  const context=await contextForExport(db,workflowId,true),location=await outputLocation(context.material_root,context.source_key,true);finalPath=location.filePath;
  const prior=(await db.query("SELECT id,attempt_id,sha256,storage_path FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx' ORDER BY created_at DESC,id DESC FOR UPDATE",[workflowId])).rows;
  const current=prior[0];
  if(current?.attempt_id===context.attempt_id&&current.sha256===digest(context.docx)&&current.storage_path===location.storagePath){
   try{const existing=await readFile(finalPath);if(digest(existing)===current.sha256){await db.query('COMMIT');tx=false;return{artifact_id:current.id,sha256:current.sha256,reused:true};}}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  }
  try{if(!(await lstat(finalPath)).isFile())throw new HTTPException(409,{message:'已有导出目标不是普通文件'});previous=await readFile(finalPath);}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  tempPath=join(dirname(finalPath),`.脱敏材料.${randomUUID()}.tmp`);await writeFile(tempPath,context.docx,{mode:0o600,flag:'wx'});await rename(tempPath,finalPath);tempPath='';replaced=true;
  const sha256=digest(context.docx),size=context.docx.byteLength;
  let artifactId:string;
  if(current){artifactId=String(current.id);await db.query('UPDATE ai_distill.artifacts SET attempt_id=$2,storage_path=$3,sha256=$4,size_bytes=$5,content=NULL,created_at=now() WHERE id=$1',[artifactId,context.attempt_id,location.storagePath,sha256,size]);}
  else{artifactId=randomUUID();await db.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,\'redacted_docx\',$4,$5,$6,NULL)',[artifactId,workflowId,context.attempt_id,location.storagePath,sha256,size]);}
  if(prior.length>1)await db.query("DELETE FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx' AND id<>$2",[workflowId,artifactId]);
  await db.query('COMMIT');tx=false;return{artifact_id:artifactId,sha256,reused:false};
 }catch(error){
  if(tx)try{await db.query('ROLLBACK');tx=false;}catch(rollbackError){console.error('DOCX导出索引事务回滚失败');}
  if(tempPath)try{await rm(tempPath,{force:true});}catch(cleanupError){console.error('DOCX导出临时文件清理失败');}
  if(replaced&&finalPath)try{if(previous){const restore=`${finalPath}.${randomUUID()}.restore`;await writeFile(restore,previous,{mode:0o600,flag:'wx'});await rename(restore,finalPath);}else await rm(finalPath,{force:true});}catch(restoreError){console.error('DOCX导出失败后文件恢复失败');}
  throw error;
 }finally{db.release();}
}

/** Read only a DOCX whose redaction attempt and current attachment digest still match. */
export async function readCurrentRedactedDocx(pool:Pool,artifactId:string){
 const row=(await pool.query("SELECT ar.id,ar.workflow_id,ar.attempt_id,ar.storage_path,ar.sha256,w.source_key,p.material_root FROM ai_distill.artifacts ar JOIN ai_distill.workflows w ON w.id=ar.workflow_id AND w.deleted_at IS NULL JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE ar.id=$1 AND ar.kind='redacted_docx'",[artifactId])).rows[0];
 if(!row)return null;
 const redaction=await currentRedaction(pool,String(row.workflow_id));
 if(redaction.attempt_id!==row.attempt_id||typeof row.material_root!=='string'||typeof row.source_key!=='string')throw new HTTPException(404,{message:'当前脱敏 DOCX 不存在或已过期'});
 const location=await outputLocation(row.material_root,row.source_key);
 if(row.storage_path!==location.storagePath)throw new HTTPException(404,{message:'当前脱敏 DOCX 路径无效'});
 try{if(!(await lstat(location.filePath)).isFile())throw new HTTPException(404,{message:'DOCX 文件不存在'});const bytes=await readFile(location.filePath);if(digest(bytes)!==row.sha256||row.sha256!==digest(buildRedactedDocx(redaction.markdown)))throw new HTTPException(404,{message:'当前脱敏 DOCX 指纹校验失败'});return{bytes,filename:'脱敏材料.docx'};}catch(error){if(error instanceof HTTPException)throw error;if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')throw new HTTPException(404,{message:'DOCX 文件不存在'});throw error;}
}
