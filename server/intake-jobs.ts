import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { receiveMaterials } from './intake';
import { enqueueExtraction } from './materials/jobs';
import type { FolderFile } from './project-folders';
export async function enqueueIngestion(pool:Pool,workflowId:string){
 const current=(await pool.query(`SELECT w.input_revision,
  EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.input_revision=w.input_revision) AS has_materials,
  EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.input_revision=w.input_revision AND lower(m.original_name) LIKE '%.pdf') AS has_pdf,
  (SELECT status FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=1) AS status
  FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!current)throw new HTTPException(404,{message:'题目不存在'});
 if(current.has_pdf)return enqueueExtraction(pool,workflowId);
 if(current.has_materials&&current.status==='succeeded')return{id:'',reused:true,completed:true};
 return enqueueIntake(pool,workflowId);
}
export async function enqueueIntake(pool: Pool, workflowId: string) {
 const db = await pool.connect();
 try {
  await db.query('BEGIN');
  const row = (await db.query('SELECT w.* FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w', [workflowId])).rows[0];
  if (!row) throw new HTTPException(404, { message: '题目不存在' });
  if (!row.source_key) throw new HTTPException(409, { message: '此题目没有材料目录，请在题目详情补充材料' });
  const active = await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND input_revision=$2 AND ordinal=1 AND status IN ('waiting','running')", [workflowId,row.input_revision]);
  if (active.rowCount) { await db.query('COMMIT'); return { id:active.rows[0].id,reused:true }; }
  const step = (await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=1', [workflowId])).rows[0];
  if (step?.status === 'succeeded') throw new HTTPException(409, { message: '材料已接收；目录变化后请先同步目录' });
  const id = crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,input_revision) SELECT $1,$2::uuid,1,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$2::uuid AND ordinal=1", [id,workflowId,JSON.stringify({source_key:row.source_key,files:row.source_manifest}),row.input_revision]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=1", [workflowId]);
  await db.query('COMMIT'); return { id,reused:false };
 } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
export async function runNextIntake(pool: Pool, root: string, workflowId?: string) {
 const db = await pool.connect(); let job;
 try {
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale = await db.query("SELECT a.id,a.workflow_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision WHERE a.ordinal=1 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' FOR UPDATE OF w,a SKIP LOCKED");
  for (const row of stale.rows) {
   await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='接收进程中断，可重试',finished_at=now() WHERE id=$1", [row.id]);
   await db.query("UPDATE ai_distill.steps SET status='failed',error='接收进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=1", [row.workflow_id]);
  }
  job = (await db.query("SELECT a.*,w.project_id,w.title,w.source_key FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision JOIN ai_distill.projects p ON p.id=w.project_id WHERE a.ordinal=1 AND a.status='waiting' AND ai_distill.dispatch_allowed(w.id,'materials') AND w.deleted_at IS NULL AND p.deleted_at IS NULL AND ($1::uuid IS NULL OR w.id=$1) ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1", [workflowId??null])).rows[0];
  if (!job) { await db.query('COMMIT'); return false; }
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1", [job.id]);
  await db.query("UPDATE ai_distill.steps SET status='running',started_at=now(),error=NULL WHERE workflow_id=$1 AND ordinal=1", [job.workflow_id]);
  await db.query('COMMIT');
 } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 const heartbeat = setInterval(() => { pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'", [job.id]).catch(() => console.error('接收任务心跳写入失败')); },10000);
 try {
  const files: File[] = [];
  for (const source of job.input.files as FolderFile[]) {
   const bytes = await readFile(source.path);
   if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('材料目录已变化，请同步目录后重新接收');
   const extension=source.name.split('.').at(-1)?.toLowerCase();
   files.push(new File([bytes],source.name,{type:extension==='pdf'?'application/pdf':extension==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain'}));
  }
  await receiveMaterials(pool,root,{projectId:job.project_id,requestId:job.id,title:job.title,key:job.source_key,files,job:{workflowId:job.workflow_id,revision:job.input_revision,attemptId:job.id}});
  if(files.some(file=>file.name.toLowerCase().endsWith('.pdf')))await enqueueExtraction(pool,job.workflow_id);
 } catch (error) {
  const message = error instanceof HTTPException ? error.message : error instanceof Error && error.message.startsWith('材料目录') ? error.message : '接收失败，请检查材料文件、目录访问权限或存储空间';
  const failed = await pool.connect();
  try {
   await failed.query('BEGIN');
   const current = await failed.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 FOR UPDATE',[job.workflow_id]);
   const active = await failed.query("UPDATE ai_distill.step_attempts SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='running'",[job.id,message]);
   if (active.rowCount && current.rows[0]?.input_revision === job.input_revision) await failed.query("UPDATE ai_distill.steps SET status='failed',error=$2,finished_at=now() WHERE workflow_id=$1 AND ordinal=1",[job.workflow_id,message]);
   await failed.query('COMMIT');
  } catch (failure) { await failed.query('ROLLBACK'); throw failure; } finally { failed.release(); }
 } finally { clearInterval(heartbeat); }
 return true;
}
