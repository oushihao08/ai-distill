/**
 * 职责：工作流重置事务：删除指定题目从入库到发布的记录和管理副本，保留项目原始来源目录。
 * 关键方法与用途：`clearGeneratedData()` 锁定工作流、隔离文件并清除处理数据，保留工作流身份与来源清单。
 * 使用场景：由 `app.ts` 的重置接口调用；活动任务存在时拒绝竞争性清理。
 */
import type {Pool} from 'pg';
import {isLibraryDocxPath} from './materials/redacted-docx-export';
import {HTTPException} from 'hono/http-exception';
import {mkdir,rename,rm,lstat,realpath} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyLogError,enterLogContext,logEvent} from './logging';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repositoryRoot=resolve(fileURLToPath(new URL('../',import.meta.url)));
type StoredPath={storage_path:string;kind:string};
type ExportPath={id:string;storage_path:string|null;workflow_ids:string[]};
function inside(parent:string,path:string){const rel=relative(parent,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));}

export async function clearGeneratedData(pool:Pool,storageRoot:string,id:string,assetExportRoot=join(repositoryRoot,'assets/out')){
 if(!uuid.test(id))throw new HTTPException(400,{message:'题目ID无效'});
 const db=await pool.connect();const moved:{from:string;to:string}[]=[];const trashDirs=new Map<string,string>();let commitAttempted=false;let committed=false;let attemptIds:string[]=[];let restoreLogContext=()=>{};
 async function trashFor(root:string){const existing=trashDirs.get(root);if(existing)return existing;const path=join(root,'.generated-trash',id,crypto.randomUUID());await mkdir(path,{recursive:true,mode:0o700});if(await realpath(path)!==path)throw new HTTPException(409,{message:'清理隔离目录存在符号链接，停止重置'});trashDirs.set(root,path);return path;}
 async function discard(){for(const path of trashDirs.values())await rm(path,{recursive:true,force:true});}
 try{
  await db.query('BEGIN');
  const workflow=(await db.query("SELECT w.id,w.project_id,w.source_manifest,w.source_key,w.workflow_kind,w.source_workflow_id,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 FOR UPDATE OF w",[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'题目不存在'});
  if(workflow.source_workflow_id)throw new HTTPException(409,{message:'派生题目的材料快照不可重置；请删除题目后从材料包重新创建'});
  if(workflow.workflow_kind==='material_package'&&(await db.query('SELECT 1 FROM ai_distill.workflows WHERE source_workflow_id=$1 LIMIT 1',[id])).rowCount)throw new HTTPException(409,{message:'材料包仍被题目历史引用，不能清理管理副本'});
  restoreLogContext=enterLogContext({component:'workflow_reset',operation:'clear_generated_data',workflow_id:id});logEvent('file.reset.started',{level:'info'});
  // 与导出使用同一项目锁；拿不到锁说明确有导出执行者，不能凭耗时回收。
  const exportLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('ai-distill-project-export'),hashtext($1)) AS acquired",[workflow.project_id])).rows[0]?.acquired;
  if(!exportLock)throw new HTTPException(409,{message:'项目导出正在执行，结束后才能重置整条工作流'});
  await db.query("UPDATE ai_distill.project_exports SET status='failed',error='导出执行已中断，请重新导出',finished_at=now() WHERE project_id=$1 AND status='running'",[workflow.project_id]);
  const attempts=(await db.query('SELECT id,status,ordinal FROM ai_distill.step_attempts WHERE workflow_id=$1 FOR UPDATE',[id])).rows;
  const remoteOperation=(await db.query("SELECT id FROM ai_distill.remote_material_operations WHERE workflow_id=$1 AND status IN ('waiting','running') FOR UPDATE",[id])).rows[0];
  if(remoteOperation)throw new HTTPException(409,{message:'远程材料操作正在进行，结束后才能重置工作流'});
  if(attempts.some(a=>['waiting','running'].includes(a.status)))throw new HTTPException(409,{message:'题目任务正在排队或运行，结束后才能重置整条工作流'});
  attemptIds=attempts.map(a=>a.id);
  if(attemptIds.some(value=>!uuid.test(value)))throw new Error('invalid persisted attempt ID');
  const manifest=Array.isArray(workflow.source_manifest)?workflow.source_manifest:[];
  const hasPdf=manifest.some((file:{name?:unknown})=>typeof file.name==='string'&&/\.(pdf|docx)$/i.test(file.name))||Boolean((await db.query("SELECT EXISTS(SELECT 1 FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL AND (lower(original_name) LIKE '%.pdf' OR lower(original_name) LIKE '%.docx')) AS has_pdf",[id])).rows[0]?.has_pdf);
  const artifactPaths=(await db.query('SELECT storage_path,kind FROM ai_distill.artifacts WHERE workflow_id=$1',[id])).rows as StoredPath[];
  const exports=(await db.query('SELECT id,storage_path,workflow_ids FROM ai_distill.project_exports WHERE $1=ANY(workflow_ids) FOR UPDATE',[id])).rows as ExportPath[];

  await mkdir(storageRoot,{recursive:true});const root=await realpath(storageRoot);
  await trashFor(root);

  const workflowDirectory=join(root,id);
  const candidates:{path:string;root:string}[]=[{path:workflowDirectory,root},{path:join(root,'.extraction-checkpoints',id),root}];
  for(const artifact of artifactPaths){
   if(isAbsolute(artifact.storage_path))throw new HTTPException(409,{message:'生成产物路径无效，停止重置'});
   if(artifact.kind==='redacted_docx'&&artifact.storage_path.startsWith('附件库/')){
    if(!isLibraryDocxPath(artifact.storage_path))throw new HTTPException(409,{message:'附件库产物路径无效，停止重置'});
    let exportRoot:string;try{exportRoot=await realpath(assetExportRoot);if((await lstat(assetExportRoot)).isSymbolicLink())throw new Error('symlink');}catch{throw new HTTPException(409,{message:'附件库根目录不可安全读取，停止重置'});}
    const libraryRoot=join(exportRoot,'附件库'),docxPath=resolve(exportRoot,artifact.storage_path),questionDir=dirname(dirname(docxPath)),pathWithinLibrary=relative(libraryRoot,questionDir);
    if(pathWithinLibrary==='..'||pathWithinLibrary.startsWith(`..${sep}`)||isAbsolute(pathWithinLibrary)||!pathWithinLibrary)throw new HTTPException(409,{message:'附件库产物路径越界，停止重置'});
    candidates.push({path:questionDir,root:exportRoot});continue;
   }
   if(artifact.kind==='redacted_docx'&&artifact.storage_path.startsWith('outputs/')){
    if(typeof workflow.source_key!=='string'||!workflow.source_key||workflow.source_key==='.'||workflow.source_key==='..'||/[\\/\u0000-\u001f]/.test(workflow.source_key)||typeof workflow.material_root!=='string')throw new HTTPException(409,{message:'旧版 DOCX 导出路径无法安全核对，停止重置'});
    const expected=join('outputs',workflow.source_key,'脱敏材料.docx');if(artifact.storage_path!==expected)throw new HTTPException(409,{message:'旧版 DOCX 导出路径无效，停止重置'});
    let projectRoot:string;try{projectRoot=await realpath(dirname(workflow.material_root));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const path=resolve(projectRoot,expected),within=relative(projectRoot,path);if(!within||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new HTTPException(409,{message:'旧版 DOCX 导出路径越界，停止重置'});
    candidates.push({path,root:projectRoot});continue;
   }
   const path=resolve(root,artifact.storage_path),within=relative(root,path);
   if(!within||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new HTTPException(409,{message:'生成产物路径越界，停止重置'});
   if(!inside(workflowDirectory,path))candidates.push({path,root});
  }
  for(const exportRow of exports){
   if(exportRow.workflow_ids.length===1&&exportRow.workflow_ids[0]===id&&exportRow.storage_path){
    if(isAbsolute(exportRow.storage_path))throw new HTTPException(409,{message:'导出文件路径无效，停止重置'});
    const exportRoot=exportRow.storage_path.startsWith('assets/out/')?repositoryRoot:root;
    const path=resolve(exportRoot,exportRow.storage_path),within=relative(exportRoot,path);
    if(!within||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new HTTPException(409,{message:'导出文件路径越界，停止重置'});
    if(!inside(workflowDirectory,path))candidates.push({path,root:exportRoot});
   }
  }
  const uniqueCandidates=[...new Map(candidates.map(candidate=>[candidate.path,candidate])).values()];
  for(const candidate of uniqueCandidates){
   const {path:from,root:allowedRoot}=candidate;
   let info;try{info=await lstat(from);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
   const actual=await realpath(from),within=relative(allowedRoot,actual);
   if(actual!==from||info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile())||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new HTTPException(409,{message:'生成文件越界或不是普通文件，停止重置'});
   const to=join(await trashFor(allowedRoot),String(moved.length));await rename(from,to);moved.push({from,to});
  }

  await db.query('DELETE FROM ai_distill.artifacts WHERE workflow_id=$1',[id]);
  if(attemptIds.length)await db.query('DELETE FROM ai_distill.step_attempts WHERE workflow_id=$1',[id]);
  await db.query('DELETE FROM ai_distill.materials WHERE workflow_id=$1',[id]);
  for(const exportRow of exports){
   if(exportRow.workflow_ids.length===1&&exportRow.workflow_ids[0]===id)await db.query('DELETE FROM ai_distill.project_exports WHERE id=$1',[exportRow.id]);
   else await db.query("UPDATE ai_distill.project_exports SET status='stale',error='包含的题目已重置',finished_at=now() WHERE id=$1 AND status='succeeded'",[exportRow.id]);
  }
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1",[id]);
  await db.query(`UPDATE ai_distill.steps SET status=CASE WHEN $2 THEN 'waiting' ELSE 'skipped' END,
   result=CASE WHEN $2 THEN NULL ELSE '{"reason":"没有PDF，无需单独OCR"}'::jsonb END,
   enabled=false,error=NULL,started_at=CASE WHEN $2 THEN NULL ELSE now() END,finished_at=CASE WHEN $2 THEN NULL ELSE now() END
   WHERE workflow_id=$1 AND ordinal=2`,[id,hasPdf]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting',rule_version_id=NULL WHERE id=$1",[id]);
  commitAttempted=true;await db.query('COMMIT');committed=true;
  try{await discard();logEvent('file.reset.completed',{level:'info',state:'succeeded',attempt_count:attemptIds.length,managed_path_count:moved.length});return{cleared:true,attempts:attemptIds.length,file_cleanup:'completed'};}
  catch(error){logEvent('file.reset.cleanup_failed',{level:'error',state:'pending',...classifyLogError(error)});return{cleared:true,attempts:attemptIds.length,file_cleanup:'pending',message:'工作流已重置，部分隔离文件待清理；请检查存储权限'};}
 }catch(error){
  logEvent('file.reset.failed',{level:'error',...classifyLogError(error)});
  try{await db.query('ROLLBACK');}catch(rollbackError){logEvent('transaction.rollback_failed',{level:'error',transaction_name:'rollback:workflow_reset',...classifyLogError(rollbackError)});console.error('工作流重置事务连接中断');}
  if(commitAttempted){
   try{const remaining=await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 LIMIT 1',[id]);const artifacts=await pool.query('SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 LIMIT 1',[id]);const materials=await pool.query('SELECT id FROM ai_distill.materials WHERE workflow_id=$1 LIMIT 1',[id]);const exports=await pool.query("SELECT id FROM ai_distill.project_exports WHERE $1=ANY(workflow_ids) AND status='succeeded' LIMIT 1",[id]);committed=!remaining.rowCount&&!artifacts.rowCount&&!materials.rowCount&&!exports.rowCount;}
   catch{throw new HTTPException(503,{message:'无法确认重置事务状态，已保留隔离文件等待核对'});}
  }
  if(committed){try{await discard();return{cleared:true,attempts:attemptIds.length,file_cleanup:'completed'};}catch{return{cleared:true,attempts:attemptIds.length,file_cleanup:'pending'};}}
  try{for(const move of moved.reverse())await rename(move.to,move.from);await discard();}
  catch{throw new HTTPException(503,{message:'工作流重置失败，文件恢复待核对'});}
  if(error instanceof HTTPException)throw error;
  throw new HTTPException(500,{message:'工作流重置失败，已恢复文件；请检查数据库或存储权限'});
 }finally{restoreLogContext();db.release();}
}
