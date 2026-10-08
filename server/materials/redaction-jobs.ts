import {readRevisionSettings,bindRevisionAttempt} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {runCodex} from '../codex/client';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {watchTaskCancellation} from '../automation/task-signal';
import {validateStepConfig} from '../project-folders';
import {DEFAULT_REDACTION_PROMPT} from '../../shared/step-registry';
import {redactExtractedMaterials,type ExtractedMaterial} from './redaction';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const redactionInputDigest=(revision:number,materials:{material_id:string;source_sha256:string;artifact_id:string;artifact_sha256:string}[])=>hash(JSON.stringify({input_revision:revision,materials:materials.map(item=>({material_id:item.material_id,source_sha256:item.source_sha256,artifact_id:item.artifact_id,artifact_sha256:item.artifact_sha256}))}));
const defaultConfig={provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'medium',prompt:DEFAULT_REDACTION_PROMPT};

async function currentSources(db:Pool|PoolClient,id:string,revision:number){
 const rows=await db.query("SELECT DISTINCT ON(m.id) m.id AS material_id,m.sha256 AS source_sha256,ar.id AS artifact_id,ar.sha256 AS artifact_sha256 FROM ai_distill.materials m JOIN ai_distill.artifacts ar ON ar.workflow_id=m.workflow_id AND ar.material_id=m.id AND ar.kind='private_extracted_pages' JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id AND a.input_revision=m.input_revision AND a.status='succeeded' WHERE m.workflow_id=$1 AND m.input_revision=$2 ORDER BY m.id,a.finished_at DESC NULLS LAST,ar.created_at DESC,ar.id DESC",[id,revision]);
 const materialCount=Number((await db.query('SELECT count(*)::int AS count FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2',[id,revision])).rows[0]?.count??0);
 if(!materialCount||rows.rows.length!==materialCount)throw new HTTPException(409,{message:'材料原文尚未全部入库，请先完成提取'});
 return rows.rows as {material_id:string;source_sha256:string;artifact_id:string;artifact_sha256:string}[];
}
export async function enqueueRedaction(pool:Pool,id:string,roundId?:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT w.input_revision,w.project_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w',[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const gate=(await db.query('SELECT ordinal,status,enabled FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal IN (1,2,9) ORDER BY display_position FOR UPDATE',[id])).rows;
  if(gate.length!==3||!gate.find(row=>row.ordinal===9)?.enabled)throw new HTTPException(409,{message:'此项目未启用脱敏步骤'});
  if(gate.find(row=>row.ordinal===1)?.status!=='succeeded'||!['succeeded','skipped'].includes(gate.find(row=>row.ordinal===2)?.status))throw new HTTPException(409,{message:'原始文本尚未完成入库'});
  const sources=await currentSources(db,id,workflow.input_revision);
  const settings=await readRevisionSettings(db,id,workflow.input_revision,roundId);
  const raw=settings?settings.configs?.['9']??defaultConfig:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=9',[workflow.project_id])).rows[0]?.config??defaultConfig;
  const config=validateStepConfig(9,raw);
  const input={input_revision:workflow.input_revision,materials:sources};
  const digest=redactionInputDigest(input.input_revision,input.materials);
  const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 AND input_revision=$2 AND input->>'digest'=$3 AND config=$4::jsonb AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,workflow.input_revision,digest,JSON.stringify(config)])).rows[0];
  if(previous){await db.query('COMMIT');return{id:previous.id,reused:true};}
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision) SELECT $2,$1::uuid,9,COALESCE(max(attempt),0)+1,'waiting',$3,$4,$5 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=9",[id,attempt,JSON.stringify({...input,digest}),JSON.stringify(config),workflow.input_revision]);
  await bindRevisionAttempt(db,id,workflow.input_revision,attempt,roundId);
  await db.query("UPDATE ai_distill.steps SET status='waiting',implemented=true,result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=9",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal IN (3,4,5,6,7,8) AND ($2::boolean=false OR ordinal<>3)",[id,!!roundId]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='脱敏输入或设置变化，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal IN (3,4,5,6,7,8) AND ($2::boolean=false OR ordinal<>3) AND status IN ('waiting','running')",[id,!!roundId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function readSource(pool:Pool,root:string,item:any,workflowId:string,revision:number):Promise<ExtractedMaterial>{
 const row=(await pool.query("SELECT ar.content,ar.storage_path,ar.sha256,m.sha256 AS source_sha256 FROM ai_distill.artifacts ar JOIN ai_distill.materials m ON m.id=ar.material_id JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id WHERE ar.id=$1 AND ar.workflow_id=$2 AND ar.material_id=$3 AND ar.kind='private_extracted_pages' AND a.input_revision=$4 AND m.input_revision=$4",[item.artifact_id,workflowId,item.material_id,revision])).rows[0];
 if(!row||row.source_sha256!==item.source_sha256||row.sha256!==item.artifact_sha256)throw new Error('raw source changed');
 let content:string;
 if(typeof row.content==='string')content=row.content;
 else{
  if(isAbsolute(row.storage_path))throw new Error('unsafe source path');
  const base=await realpath(resolve(root)),path=await realpath(join(base,row.storage_path)),within=relative(base,path);
  if(!within||within==='..'||within.startsWith('../')||isAbsolute(within))throw new Error('unsafe source path');
  const bytes=await readFile(path);if(hash(bytes)!==row.sha256)throw new Error('raw source hash mismatch');content=bytes.toString('utf8');
 }
 if(hash(content)!==row.sha256)throw new Error('raw source hash mismatch');
 const parsed=JSON.parse(content);
 if(parsed.source_sha256!==item.source_sha256||!Array.isArray(parsed.pages)||!parsed.pages.length||parsed.pages.some((page:any,index:number)=>page.page!==index+1||typeof page.text!=='string'))throw new Error('raw source format invalid');
 return{material_id:item.material_id,source_sha256:item.source_sha256,pages:parsed.pages};
}

export async function runNextRedaction(pool:Pool,root:string,signal?:AbortSignal,execute:typeof runCodex=runCodex){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any;
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.input_revision FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=9 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='脱敏进程中断，可重试',finished_at=now() WHERE id=$1",[row.id]);await db.query("UPDATE ai_distill.steps SET status='failed',error='脱敏进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=9 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1 AND input_revision=$2)",[row.workflow_id,row.input_revision]);}
  job=(await db.query("SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 AND s.enabled WHERE a.ordinal=9 AND a.status='waiting' AND w.deleted_at IS NULL AND ai_distill.dispatch_allowed(w.id,'codex') ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);
  await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=9",[job.workflow_id]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 const heartbeat=setInterval(()=>{pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>console.error('脱敏任务心跳写入失败'));},10000);
 const directory=join(resolve(root),job.workflow_id,job.id);let wrote=false;
 try{
  const {digest,...input}=job.input;
  if(!input||redactionInputDigest(input.input_revision,input.materials)!==digest||job.input_revision!==input.input_revision)throw new Error('stale snapshot');
  const sources=await currentSources(pool,job.workflow_id,job.input_revision);
  if(redactionInputDigest(job.input_revision,sources)!==digest)throw new Error('stale source');
  const materials:ExtractedMaterial[]=[];
  for(const item of input.materials)materials.push(await readSource(pool,root,item,job.workflow_id,job.input_revision));
  const config=validateStepConfig(9,job.config);
  if(!('prompt' in config)||typeof config.prompt!=='string')throw new Error('脱敏设置缺少提示词');
  const output=await redactExtractedMaterials({directory:join(directory,'private'),materials,prompt:config.prompt,model:config.model,reasoning_effort:config.reasoning_effort,signal,execute:options=>runRevisionCall(pool,job.id,'redaction',remaining=>execute({...options,timeout_ms:Math.min(options.timeout_ms??1800000,remaining??1800000)}))});
  if(signal?.aborted)throw new Error('cancelled');
  const markdownPath=join(directory,'materials.md'),indexPath=join(directory,'pages.json');
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(markdownPath,output.markdown,{mode:0o600,flag:'wx'});
  await writeFile(indexPath,output.index,{mode:0o600,flag:'wx'});
  wrote=true;
  const files=[
   {kind:'redacted_markdown',storage_path:relative(resolve(root),markdownPath),content:output.markdown},
   {kind:'redacted_index',storage_path:relative(resolve(root),indexPath),content:output.index},
  ].map(file=>({...file,sha256:hash(file.content),size_bytes:Buffer.byteLength(file.content)}));
  const result={input_revision:job.input_revision,material_count:materials.length,page_count:materials.reduce((sum,item)=>sum+item.pages.length,0),redacted_sha256:files[0]!.sha256,index_sha256:files[1]!.sha256,prompt_sha256:hash(config.prompt),session_id:output.session_id,usage:output.usage,duration_ms:output.duration_ms};
  const tx=await pool.connect();
  try{
   await tx.query('BEGIN');
   const current=await tx.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[job.workflow_id]);
   const active=await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id]);
   const sourcesNow=await currentSources(tx,job.workflow_id,job.input_revision);
   if(current.rows[0]?.input_revision!==job.input_revision||!active.rowCount||redactionInputDigest(job.input_revision,sourcesNow)!==digest)throw new Error('任务材料版本已失效，结果未发布');
   for(const file of files)await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),job.workflow_id,job.id,file.kind,file.storage_path,file.sha256,file.size_bytes,file.content]);
   await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(result),output.session_id]);
   await tx.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=9",[job.workflow_id,JSON.stringify(result)]);
   await tx.query("UPDATE ai_distill.materials SET processing_status='redacted' WHERE workflow_id=$1 AND input_revision=$2",[job.workflow_id,job.input_revision]);
   await tx.query('COMMIT');
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  if(wrote)try{const status=await pool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[job.id]);if(status.rows[0]?.status!=='succeeded')await rm(directory,{recursive:true,force:true});}catch{console.error('无法确认脱敏结果发布状态，保留文件等待核对');}
  const failed=await pool.connect();
  try{await failed.query('BEGIN');const current=await failed.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[job.workflow_id]);const updated=await failed.query("UPDATE ai_distill.step_attempts SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='running'",[job.id,'脱敏执行失败或结果校验未通过，可检查配置后重试']);if(updated.rowCount&&current.rows[0]?.input_revision===job.input_revision)await failed.query("UPDATE ai_distill.steps SET status='failed',error=$2,finished_at=now() WHERE workflow_id=$1 AND ordinal=9 AND status='running'",[job.workflow_id,'脱敏执行失败或结果校验未通过，可检查配置后重试']);await failed.query('COMMIT');}catch(failure){await failed.query('ROLLBACK');throw failure;}finally{failed.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);}
 return true;
}
