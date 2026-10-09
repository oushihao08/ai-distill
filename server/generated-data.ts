import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {mkdir,rename,rm,lstat,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute,resolve,sep} from 'node:path';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StoredPath={storage_path:string;kind:string};
function inside(parent:string,path:string){const rel=relative(parent,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));}

export async function clearGeneratedData(pool:Pool,storageRoot:string,id:string){
 if(!uuid.test(id))throw new HTTPException(400,{message:'题目ID无效'});
 const db=await pool.connect();const moved:{from:string;to:string}[]=[];let commitAttempted=false;let committed=false;let attemptIds:string[]=[];let hasArtifacts=false;let trash:string|undefined;
 async function discard(){if(trash)await rm(trash,{recursive:true,force:true});}
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT w.id,w.input_revision FROM ai_distill.workflows w WHERE w.id=$1 FOR UPDATE OF w',[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'题目不存在'});
  const attempts=(await db.query('SELECT id,status,ordinal FROM ai_distill.step_attempts WHERE workflow_id=$1 FOR UPDATE',[id])).rows;
  if(attempts.some(a=>['waiting','running'].includes(a.status)))throw new HTTPException(409,{message:'题目任务正在排队或运行，结束后才能重置整条工作流'});
  attemptIds=attempts.map(a=>a.id);
  if(attemptIds.some(value=>!uuid.test(value)))throw new Error('invalid persisted attempt ID');
  const hasPdf=Boolean((await db.query("SELECT EXISTS(SELECT 1 FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2 AND lower(original_name) LIKE '%.pdf') AS has_pdf",[id,workflow.input_revision])).rows[0]?.has_pdf);
  const artifactPaths=(await db.query('SELECT storage_path,kind FROM ai_distill.artifacts WHERE workflow_id=$1',[id])).rows as StoredPath[];
  hasArtifacts=artifactPaths.length>0;

  await mkdir(storageRoot,{recursive:true});const root=await realpath(storageRoot);
  trash=join(root,'.generated-trash',id,crypto.randomUUID());await mkdir(trash,{recursive:true,mode:0o700});
  if(await realpath(trash)!==trash)throw new HTTPException(409,{message:'清理隔离目录存在符号链接，停止重置'});

  const generatedDirectories=attempts.filter(a=>a.ordinal!==1).map(a=>join(root,id,a.id));
  const candidates=[...generatedDirectories,join(root,'.extraction-checkpoints',id)];
  for(const artifact of artifactPaths){
   if(artifact.kind==='source_document')continue;
   if(isAbsolute(artifact.storage_path))throw new HTTPException(409,{message:'生成产物路径无效，停止重置'});
   const path=resolve(root,artifact.storage_path),within=relative(root,path);
   if(!within||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new HTTPException(409,{message:'生成产物路径越界，停止重置'});
   if(!generatedDirectories.some(directory=>inside(directory,path)))candidates.push(path);
  }
  for(const from of [...new Set(candidates)]){
   let info;try{info=await lstat(from);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
   const actual=await realpath(from),within=relative(root,actual);
   if(actual!==from||info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile())||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new HTTPException(409,{message:'生成文件越界或不是普通文件，停止重置'});
   const to=join(trash,String(moved.length));await rename(from,to);moved.push({from,to});
  }

  await db.query('DELETE FROM ai_distill.artifacts WHERE workflow_id=$1',[id]);
  if(attemptIds.length)await db.query('DELETE FROM ai_distill.step_attempts WHERE workflow_id=$1',[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1",[id]);
  await db.query(`UPDATE ai_distill.steps SET status=CASE WHEN $2 THEN 'waiting' ELSE 'skipped' END,
   result=CASE WHEN $2 THEN NULL ELSE '{"reason":"没有PDF，无需单独OCR"}'::jsonb END,
   enabled=false,error=NULL,started_at=CASE WHEN $2 THEN NULL ELSE now() END,finished_at=CASE WHEN $2 THEN NULL ELSE now() END
   WHERE workflow_id=$1 AND ordinal=2`,[id,hasPdf]);
  await db.query("UPDATE ai_distill.materials SET processing_status='received' WHERE workflow_id=$1",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting',rule_version_id=NULL WHERE id=$1",[id]);
  commitAttempted=true;await db.query('COMMIT');committed=true;
  try{await discard();return{cleared:true,attempts:attemptIds.length,file_cleanup:'completed'};}
  catch{return{cleared:true,attempts:attemptIds.length,file_cleanup:'pending',message:'工作流已重置，部分隔离文件待清理；请检查存储权限'};}
 }catch(error){
  try{await db.query('ROLLBACK');}catch{console.error('工作流重置事务连接中断');}
  if(commitAttempted&&(attemptIds.length||hasArtifacts)){
   try{const remaining=await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 LIMIT 1',[id]);const artifacts=await pool.query('SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 LIMIT 1',[id]);committed=!remaining.rowCount&&!artifacts.rowCount;}
   catch{throw new HTTPException(503,{message:'无法确认重置事务状态，已保留隔离文件等待核对'});}
  }
  if(committed){try{await discard();return{cleared:true,attempts:attemptIds.length,file_cleanup:'completed'};}catch{return{cleared:true,attempts:attemptIds.length,file_cleanup:'pending'};}}
  try{for(const move of moved.reverse())await rename(move.to,move.from);await discard();}
  catch{throw new HTTPException(503,{message:'工作流重置失败，文件恢复待核对'});}
  if(error instanceof HTTPException)throw error;
  throw new HTTPException(500,{message:'工作流重置失败，已恢复文件；请检查数据库或存储权限'});
 }finally{db.release();}
}
