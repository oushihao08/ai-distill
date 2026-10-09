import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { STEP_REGISTRY } from '../shared/step-registry';
import { extractLocalDocument } from './materials/document';
import { validateFile, MAX_BATCH } from './validation';
export interface IntakeInput { projectId: string; requestId: string; title: string; key: string | null; files: File[]; workflowId?: string; expectedRevision?: number; allowEmpty?: boolean; job?: { workflowId: string; revision: number; attemptId: string } }
export async function receiveMaterials(pool: Pool, storageRoot: string, input: IntakeInput) {
 const { projectId, requestId } = input;
   let directory: string | undefined;
   let committed = false;
   const client = await pool.connect();
   try {
     await client.query('BEGIN');
     await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${projectId}:${requestId}`]);
     const previous = await client.query('SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND request_id=$2', [projectId, requestId]);
     if (previous.rowCount) { await client.query('COMMIT'); return { id: previous.rows[0].id, reused: true }; }
     if (!(await client.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL', [projectId])).rowCount) throw new HTTPException(404, { message: '项目不存在' });
     const { files, title, key, job } = input;
     if ((!files.length && !input.allowEmpty) || files.length > 100) throw new HTTPException(400, { message: '请选择1至100份PDF、DOCX、TXT或MD材料' });
     if ((files as File[]).reduce((sum, f) => sum + f.size, 0) > MAX_BATCH) throw new HTTPException(413, { message: '材料包不能超过100MB' });
     const prepared = [];
     for (const file of files as File[]) {
       const bytes = new Uint8Array(await file.arrayBuffer()); validateFile(file, bytes);
       const extension=file.name.split('.').at(-1)!.toLowerCase() as 'pdf'|'docx'|'txt'|'md';
       prepared.push({ bytes, extension, local_pages:extension==='pdf'?null:extractLocalDocument(bytes,extension).pages, original_name: file.name.replace(/[\\\x00-\x1f]/g, '_').slice(0, 240), sha256: createHash('sha256').update(bytes).digest('hex') });
     }
     let existing: { id: string; input_revision: number } | undefined;
     if (input.workflowId) {
       existing = (await client.query('SELECT id,input_revision FROM ai_distill.workflows WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL FOR UPDATE',[input.workflowId,projectId])).rows[0];
       if (!existing) throw new HTTPException(404,{message:'题目不存在'});
       if (input.expectedRevision !== undefined && existing.input_revision !== input.expectedRevision) throw new HTTPException(409,{message:'材料已被另一操作更新，请刷新后重试'});
     }
     if (key && !input.workflowId) {
       await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${projectId}:source:${key}`]);
       existing = (await client.query('SELECT id,input_revision FROM ai_distill.workflows WHERE project_id=$1 AND source_key=$2 FOR UPDATE', [projectId, key])).rows[0];
       if (existing) {
         const old = await client.query('SELECT original_name,sha256 FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2', [existing.id, existing.input_revision]);
         const manifest = (rows: { original_name: string; sha256: string }[]) => JSON.stringify(rows.map(row => [row.original_name, row.sha256]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
         if (!job && manifest(old.rows) === manifest(prepared)) {
           await client.query('COMMIT');
           return { id: existing.id, reused: true, input_revision: existing.input_revision };
         }
       }
     }
     if (job && (existing?.id !== job.workflowId || existing.input_revision !== job.revision || !(await client.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE", [job.attemptId])).rowCount)) throw new Error('任务材料版本已失效，结果未发布');
     if (existing && input.workflowId) {
       const current=await client.query('SELECT original_name,sha256 FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2',[existing.id,existing.input_revision]);
       const signature=(rows:{original_name:string;sha256:string}[])=>JSON.stringify(rows.map(row=>[row.original_name,row.sha256]).sort());
       if(signature(current.rows)===signature(prepared)) { await client.query('COMMIT'); return {id:existing.id,reused:true,input_revision:existing.input_revision}; }
     }
     const id = existing?.id ?? crypto.randomUUID();
     const revision = job?.revision ?? (existing ? existing.input_revision + 1 : 1);
     const attemptId = job?.attemptId ?? crypto.randomUUID();
     const relativeDirectory = existing ? `${id}/intake-${attemptId}` : id;
     if (existing) {
       await client.query("UPDATE ai_distill.workflows SET title=$2,input_revision=$3,status='waiting' WHERE id=$1", [id, title, revision]);
       await client.query("UPDATE ai_distill.step_attempts SET status='skipped',error='材料版本更新，任务失效',finished_at=now() WHERE workflow_id=$1 AND status IN ('waiting','running') AND id<>$2", [id, attemptId]);
       await client.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>1", [id]);
     } else {
       await client.query('INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_key) VALUES($1,$2,$3,$4,$5)', [id, projectId, requestId, title, key]);
     }
     if (existing && input.workflowId && !job && prepared.length === 0) {
       await client.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL,enabled=true,name='入库（含PDF文本提取）',display_position=1 WHERE workflow_id=$1 AND ordinal=1", [id]);
       await client.query("UPDATE ai_distill.steps SET status='skipped',result=$2,error=NULL,started_at=now(),finished_at=now(),enabled=false WHERE workflow_id=$1 AND ordinal=2", [id, JSON.stringify({ reason: '等待重新入库后判断是否需要PDF文本提取' })]);
       await client.query('COMMIT');
       return { id, updated: true, input_revision: revision, empty: true };
     }
     directory = join(resolve(storageRoot), relativeDirectory);
     await mkdir(directory, { recursive: true, mode: 0o700 });
     const summaries = [];
     const rawArtifacts:{material_id:string;storage_path:string;sha256:string;size_bytes:number;content:string}[]=[];
     for (const file of prepared) {
       const materialId = crypto.randomUUID();
       const relativePath = `${relativeDirectory}/${materialId}.${file.extension}`;
       await writeFile(join(resolve(storageRoot), relativePath), file.bytes, { mode: 0o600, flag: 'wx' });
       await client.query('INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes,content_type,processing_status,input_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [materialId, id, file.original_name, relativePath, file.sha256, file.bytes.length, file.extension,file.local_pages?'text_extracted':'received',revision]);
       if(file.local_pages){
         const content=JSON.stringify({source_sha256:file.sha256,format:file.extension,provider:'local',pages:file.local_pages});
         const extractedPath=`${relativeDirectory}/material-${materialId}-extracted.json`;
         await writeFile(join(resolve(storageRoot),extractedPath),content,{mode:0o600,flag:'wx'});
         rawArtifacts.push({material_id:materialId,storage_path:extractedPath,sha256:createHash('sha256').update(content).digest('hex'),size_bytes:Buffer.byteLength(content),content});
       }
       summaries.push({ id: materialId, original_name: file.original_name, sha256: file.sha256, size_bytes: file.bytes.length });
     }
     const pdfCount=prepared.filter(file=>file.extension==='pdf').length;
     const intakeResult = { materials: summaries, input_revision: revision, pdf_count:pdfCount, direct_text_count:prepared.length-pdfCount, validation: '原件已保存；DOCX/TXT/MD文本已直接解析并入库，PDF文本提取完成后入库' };
     if (existing) {
       await client.query("UPDATE ai_distill.steps SET status=$3,result=$2,error=NULL,started_at=now(),finished_at=CASE WHEN $3='succeeded' THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=1", [id, JSON.stringify(intakeResult),pdfCount?'waiting':'succeeded']);
     } else {
       for (const stage of STEP_REGISTRY) await client.query('INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,result,started_at,finished_at,step_key,display_position,enabled) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $2=1 AND $4=\'succeeded\' THEN now() END,CASE WHEN $2=1 AND $4=\'succeeded\' THEN now() END,$7,$8,$9)', [id,stage.ordinal,stage.name,stage.ordinal===1?(pdfCount?'waiting':'succeeded'):stage.ordinal===2&&pdfCount===0?'skipped':'waiting',stage.defaultEnabled,stage.ordinal===1?JSON.stringify(intakeResult):stage.ordinal===2&&pdfCount===0?JSON.stringify({reason:'没有PDF，无需单独OCR'}):null,stage.key,stage.position,stage.defaultEnabled]);
     }
     if(existing){
       await client.query("UPDATE ai_distill.steps SET status=$2,result=$3,error=NULL,started_at=CASE WHEN $2='skipped' THEN now() ELSE NULL END,finished_at=CASE WHEN $2='skipped' THEN now() ELSE NULL END,enabled=false WHERE workflow_id=$1 AND ordinal=2",[id,pdfCount===0?'skipped':'waiting',pdfCount===0?JSON.stringify({reason:'没有PDF，无需单独OCR'}):null]);
       await client.query("UPDATE ai_distill.steps SET name='入库（含PDF文本提取）',display_position=1,enabled=true WHERE workflow_id=$1 AND ordinal=1",[id]);
     }
     if (job) await client.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE id=$1", [attemptId, JSON.stringify(intakeResult)]);
     else await client.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,finished_at,input_revision) SELECT $1,$2::uuid,1,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,now(),$5 FROM ai_distill.step_attempts WHERE workflow_id=$2::uuid AND ordinal=1", [attemptId, id, JSON.stringify({ title, source_key: key, file_count: files.length }), JSON.stringify(intakeResult), revision]);
     for(const artifact of rawArtifacts)await client.query('INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[crypto.randomUUID(),id,artifact.material_id,attemptId,'private_extracted_pages',artifact.storage_path,artifact.sha256,artifact.size_bytes,artifact.content]);
     await client.query("INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes) SELECT gen_random_uuid(),workflow_id,id,$2,'source_document',storage_path,sha256,size_bytes FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$3", [id, attemptId, revision]);
     if (!prepared.length) {
       await client.query("UPDATE ai_distill.steps SET status='failed',error='没有材料，请补充后重试' WHERE workflow_id=$1 AND ordinal=1",[id]);
       await client.query("UPDATE ai_distill.step_attempts SET status='failed',error='没有材料，请补充后重试' WHERE id=$1",[attemptId]);
     }
     await client.query('COMMIT');
     committed = true;
     directory = undefined;
     return existing ? { id, updated: true, input_revision: revision } : { id, input_revision: revision };
   } catch (error) {
     try { await client.query('ROLLBACK'); } catch { console.error('上传事务连接已中断。'); }
     if (directory && !committed) {
       try {
         // A lost COMMIT response can still have published this revision.
         const saved = await client.query('SELECT id FROM ai_distill.materials WHERE storage_path LIKE $1 LIMIT 1', [directory.slice(resolve(storageRoot).length + 1) + '/%']);
         if (!saved.rowCount) await rm(directory, { recursive: true, force: true });
       } catch { console.error('无法确认上传提交状态，保留文件等待核对。'); }
     }
     throw error;
   } finally { client.release(); }
}
