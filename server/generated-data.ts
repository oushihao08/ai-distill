import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {mkdir,rename,rm,lstat,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function clearGeneratedData(pool:Pool,storageRoot:string,id:string){
 if(!uuid.test(id))throw new HTTPException(400,{message:'题目ID无效'});
 const db=await pool.connect();const moved:{from:string;to:string}[]=[];let commitAttempted=false;let committed=false;let ids:string[]=[];let trash:string|undefined;
 async function discard(){if(trash)await rm(trash,{recursive:true,force:true});}
 try{
  await db.query('BEGIN');
  if(!(await db.query('SELECT w.id FROM ai_distill.workflows w WHERE w.id=$1 FOR UPDATE OF w',[id])).rowCount)throw new HTTPException(404,{message:'题目不存在'});
  const attempts=(await db.query('SELECT id,status,ordinal FROM ai_distill.step_attempts WHERE workflow_id=$1 FOR UPDATE',[id])).rows;
  if(attempts.some(a=>['waiting','running'].includes(a.status)))throw new HTTPException(409,{message:'题目任务正在排队或运行，结束后才能清理生成数据'});
  const keep=attempts.filter(a=>a.ordinal===1||(a.ordinal===2&&a.status==='succeeded')).map(a=>a.id);
  ids=attempts.filter(a=>a.ordinal>=3||(a.ordinal===2&&a.status!=='succeeded')).map(a=>a.id);
  if(ids.some(value=>!uuid.test(value)))throw new Error('invalid persisted attempt ID');
  await mkdir(storageRoot,{recursive:true});const root=await realpath(storageRoot);
  trash=join(root,'.generated-trash',id,crypto.randomUUID());await mkdir(trash,{recursive:true,mode:0o700});
  if(await realpath(trash)!==trash)throw new HTTPException(409,{message:'清理隔离目录存在符号链接，停止清理'});
  const paths=[...ids.map(attempt=>join(root,id,attempt)),join(root,'.extraction-checkpoints',id)];
  for(const from of paths){
   let info;try{info=await lstat(from);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
   const actual=await realpath(from),within=relative(root,actual);
   if(actual!==from||info.isSymbolicLink()||!info.isDirectory()||within==='..'||within.startsWith('../')||isAbsolute(within))throw new HTTPException(409,{message:'生成目录越界或不是普通目录，停止清理'});
   const to=join(trash,String(moved.length));await rename(from,to);moved.push({from,to});
  }
  await db.query('DELETE FROM ai_distill.artifacts WHERE workflow_id=$1 AND (attempt_id IS NULL OR NOT (attempt_id=ANY($2::uuid[])))',[id,keep]);
  if(ids.length)await db.query('DELETE FROM ai_distill.step_attempts WHERE id=ANY($1::uuid[])',[ids]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>=3",[id]);
  await db.query(`WITH current_input AS (
    SELECT EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=$1 AND m.input_revision=w.input_revision AND lower(m.original_name) LIKE '%.pdf') AS has_pdf,
      EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND a.input_revision=w.input_revision AND a.ordinal=2 AND a.status='succeeded') AS extracted
    FROM ai_distill.workflows w WHERE w.id=$1
  )
  UPDATE ai_distill.steps extraction SET
    status=CASE WHEN current_input.has_pdf THEN CASE WHEN current_input.extracted THEN 'succeeded' ELSE 'waiting' END ELSE 'skipped' END,
    enabled=false,error=NULL,
    result=CASE WHEN current_input.has_pdf AND current_input.extracted THEN extraction.result WHEN current_input.has_pdf THEN NULL ELSE '{"reason":"没有PDF，无需单独OCR"}'::jsonb END,
    started_at=CASE WHEN current_input.has_pdf AND current_input.extracted THEN extraction.started_at WHEN current_input.has_pdf THEN NULL ELSE now() END,
    finished_at=CASE WHEN current_input.has_pdf AND current_input.extracted THEN extraction.finished_at WHEN current_input.has_pdf THEN NULL ELSE now() END
  FROM current_input WHERE extraction.workflow_id=$1 AND extraction.ordinal=2`,[id]);
  await db.query(`UPDATE ai_distill.steps ingestion SET
    status=CASE WHEN extraction.status='skipped' THEN 'succeeded' ELSE extraction.status END,
    result=CASE WHEN extraction.status='skipped' THEN ingestion.result ELSE extraction.result END,
    error=NULL,started_at=CASE WHEN extraction.status='skipped' THEN COALESCE(ingestion.started_at,now()) ELSE extraction.started_at END,
    finished_at=CASE WHEN extraction.status IN ('succeeded','skipped') THEN COALESCE(extraction.finished_at,now()) ELSE NULL END
    FROM ai_distill.steps extraction WHERE ingestion.workflow_id=$1 AND ingestion.ordinal=1 AND extraction.workflow_id=ingestion.workflow_id AND extraction.ordinal=2`,[id]);
  await db.query("UPDATE ai_distill.materials SET processing_status=CASE WHEN lower(original_name) LIKE '%.pdf' AND (SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=1)='succeeded' THEN 'text_extracted' WHEN lower(original_name) LIKE '%.pdf' THEN 'received' ELSE 'text_extracted' END WHERE workflow_id=$1",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting',rule_version_id=NULL WHERE id=$1",[id]);
  commitAttempted=true;await db.query('COMMIT');committed=true;
  try{await discard();return{cleared:true,attempts:ids.length,file_cleanup:'completed'};}
  catch{return{cleared:true,attempts:ids.length,file_cleanup:'pending',message:'数据库已清理，部分隔离文件待清理；请检查存储权限'};}
 }catch(error){
  try{await db.query('ROLLBACK');}catch{console.error('生成数据清理事务连接中断');}
  if(commitAttempted&&ids.length){
   try{committed=!(await pool.query('SELECT id FROM ai_distill.step_attempts WHERE id=ANY($1::uuid[])',[ids])).rowCount;}
   catch{throw new HTTPException(503,{message:'无法确认清理事务状态，已保留隔离文件等待核对'});}
  }
  if(committed){try{await discard();return{cleared:true,attempts:ids.length,file_cleanup:'completed'};}catch{return{cleared:true,attempts:ids.length,file_cleanup:'pending'};}}
  try{for(const move of moved.reverse())await rename(move.to,move.from);await discard();}
  catch{throw new HTTPException(503,{message:'生成数据清理失败，隔离文件恢复待核对'});}
  if(error instanceof HTTPException)throw error;
  throw new HTTPException(500,{message:'生成数据清理失败，已恢复文件；请检查数据库或存储权限'});
 }finally{db.release();}
}
