/**
 * 职责：目录入库队列：创建或复用接收任务，领取题目目录材料并接续 PDF 文本提取。
 * 关键方法与用途：`enqueueIngestion()`／`enqueueIntake()` 创建或复用入库任务；`runNextIntake()` 领取目录材料并接续 PDF 提取。
 * 使用场景：`app.ts` 派发入库，`worker.ts` 消费持久化队列。
 */
import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { receiveMaterials } from './intake';
import {invalidateMaterialResults} from './materials/state';
import { enqueueExtraction } from './materials/jobs';
import { scanQuestionFolder, validateFolder, type FolderFile } from './project-folders';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from './logging';
/**
 * 按当前已入库附件选择接收或 PDF 提取队列；没有 PDF 且入库已成功时复用完成状态。
 * API 派发入口使用此路由方法，避免把 PDF 文本提取重复创建成另一条可见入库流程。
 */
export async function enqueueIngestion(pool:Pool,workflowId:string){
 const current=(await pool.query("SELECT \n  EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.deleted_at IS NULL) AS has_materials,\n  EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.deleted_at IS NULL AND lower(m.original_name) LIKE '%.pdf') AS has_pdf,\n  (SELECT status FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=1) AS status\n  FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL",[workflowId])).rows[0];
 if(!current)throw new HTTPException(404,{message:'题目不存在'});
 if(current.has_pdf)return enqueueExtraction(pool,workflowId);
 if(current.has_materials&&current.status==='succeeded')return{id:'',reused:true,completed:true};
 return enqueueIntake(pool,workflowId);
}
/**
 * 扫描题目来源目录并以完整文件清单与 source_manifest 比较；清单变化时刷新附件并使旧结果失效。
 * 在同一事务里失效旧尝试并创建或复用当前版本的入库任务，不改写来源文件。
 */
export async function enqueueIntake(pool: Pool, workflowId: string) {
 const db = await pool.connect();
 try {
  await db.query('BEGIN');
  const row = (await db.query('SELECT w.*,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w,p', [workflowId])).rows[0];
  if (!row) throw new HTTPException(404, { message: '题目不存在' });
  if (!row.source_key) throw new HTTPException(409, { message: '此题目没有材料目录，请在题目详情补充材料' });
  const actual = await scanQuestionFolder(await validateFolder(row.material_root), row.source_key);
  if (!actual.files.length) throw new HTTPException(409, { message: `题目「${row.source_key}」目录中没有PDF、DOCX、TXT或MD文件，请补充材料后重试` });
  const manifestSignature = (files: FolderFile[]) => JSON.stringify(files.map(file => [file.name,file.path,file.size,file.sha256]));
  const previousManifest = (row.source_manifest ?? []) as FolderFile[];
  if (manifestSignature(previousManifest) !== manifestSignature(actual.files)) {
   await db.query("UPDATE ai_distill.workflows SET source_manifest=$2::jsonb,status='waiting' WHERE id=$1",[workflowId,JSON.stringify(actual.files)]);
   await invalidateMaterialResults(db,workflowId);
   await db.query('UPDATE ai_distill.materials SET deleted_at=now() WHERE workflow_id=$1 AND deleted_at IS NULL',[workflowId]);
   row.source_manifest = actual.files;
  }
  const active = await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=1 AND status IN ('waiting','running')", [workflowId]);
  if (active.rowCount) { await db.query('COMMIT'); withLogContext({component:'intake',workflow_id:workflowId,project_id:row.project_id,ordinal:1,attempt_id:active.rows[0].id,operation:'intake'},()=>logEvent('attempt.reused',{level:'info',state:'waiting'})); return { id:active.rows[0].id,reused:true }; }
  const step = (await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=1', [workflowId])).rows[0];
  if (step?.status === 'succeeded') throw new HTTPException(409, { message: '材料已接收；目录变化后请先同步目录' });
  const id = crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input) SELECT $1,$2::uuid,1,COALESCE(max(attempt),0)+1,'waiting',$3 FROM ai_distill.step_attempts WHERE workflow_id=$2::uuid AND ordinal=1", [id,workflowId,JSON.stringify({source_key:row.source_key,files:row.source_manifest})]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=1", [workflowId]);
  await db.query('COMMIT'); withLogContext({component:'intake',workflow_id:workflowId,project_id:row.project_id,ordinal:1,attempt_id:id,operation:'intake'},()=>logEvent('attempt.enqueued',{level:'info',state:'waiting',material_count:actual.files.length})); return { id,reused:false };
 } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
/**
 * 领取一条活动入库任务，恢复超时尝试后读取冻结的来源清单并调用 receiveMaterials。
 * 成功入库后按材料类型接续 PDF 提取；worker 轮询调用，重复领取由行锁和 SKIP LOCKED 避免。
 */
export async function runNextIntake(pool: Pool, root: string, workflowId?: string) {
 const db = await pool.connect(); let job;let staleRows:any[]=[];
 try {
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale = await db.query("SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=1 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' FOR UPDATE OF w,a SKIP LOCKED");
  for (const row of stale.rows) {
   const updated=await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='接收进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id", [row.id]);
   await db.query("UPDATE ai_distill.steps SET status='failed',error='接收进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=1", [row.workflow_id]);
   if(updated.rowCount)staleRows.push(row);
  }
  job = (await db.query("SELECT a.*,w.project_id,w.title,w.source_key FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id WHERE a.ordinal=1 AND a.status='waiting' AND w.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR w.id=$1) ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1", [workflowId??null])).rows[0];
  if (!job) { await db.query('COMMIT');for(const row of staleRows)withLogContext({component:'intake',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:1,attempt_id:row.id,operation:'intake'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));return false; }
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1", [job.id]);
  await db.query("UPDATE ai_distill.steps SET status='running',started_at=now(),error=NULL WHERE workflow_id=$1 AND ordinal=1", [job.workflow_id]);
  await db.query('COMMIT');
 } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 for(const row of staleRows)withLogContext({component:'intake',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:1,attempt_id:row.id,operation:'intake'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));
 const restoreLogContext=enterLogContext({component:'intake',workflow_id:job.workflow_id,project_id:job.project_id,ordinal:1,attempt_id:job.id,operation:'intake'});
 logEvent('attempt.claimed',{level:'info',state:'running'});logEvent('attempt.started',{level:'info',state:'running',material_count:(job.input.files as FolderFile[]).length});
 let heartbeatFailed=false,lastHeartbeatAt=new Date().toISOString();
 const heartbeat = setInterval(() => { withLogContext({component:'intake',project_id:job.project_id,workflow_id:job.workflow_id,ordinal:1,attempt_id:job.id},()=>pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id", [job.id]).then(result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});heartbeatFailed=true;}else{if(heartbeatFailed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch(error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});console.error('接收任务心跳写入失败');}heartbeatFailed=true;})); },10000);
 try {
  const files: File[] = [];
  for (const source of job.input.files as FolderFile[]) {
   const bytes = await readFile(source.path);
   if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('材料目录已变化，请同步目录后重新接收');
   const extension=source.name.split('.').at(-1)?.toLowerCase();
   files.push(new File([bytes],source.name,{type:extension==='pdf'?'application/pdf':extension==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain'}));
  }
  await receiveMaterials(pool,root,{projectId:job.project_id,requestId:job.id,title:job.title,key:job.source_key,files,job:{workflowId:job.workflow_id,attemptId:job.id}});
  logEvent('attempt.completed',{level:'info',state:'succeeded',material_count:files.length,input_bytes:files.reduce((sum,file)=>sum+file.size,0)});
  if(files.some(file=>file.name.toLowerCase().endsWith('.pdf')))await enqueueExtraction(pool,job.workflow_id);
 } catch (error) {
  logEvent('attempt.failed',{level:'error',state:'failed',...classifyLogError(error)});
  const message = error instanceof HTTPException ? error.message : error instanceof Error && error.message.startsWith('材料目录') ? error.message : '接收失败，请检查材料文件、目录访问权限或存储空间';
  const failed = await pool.connect();
  try {
   await failed.query('BEGIN');
   const current = await failed.query("SELECT id FROM ai_distill.workflows WHERE id=$1 FOR UPDATE",[job.workflow_id]);
   const active = await failed.query("UPDATE ai_distill.step_attempts SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='running'",[job.id,message]);
   if (active.rowCount) await failed.query("UPDATE ai_distill.steps SET status='failed',error=$2,finished_at=now() WHERE workflow_id=$1 AND ordinal=1",[job.workflow_id,message]);
   await failed.query('COMMIT');
  } catch (failure) { await failed.query('ROLLBACK'); throw failure; } finally { failed.release(); }
 } finally { clearInterval(heartbeat);restoreLogContext(); }
 return true;
}
