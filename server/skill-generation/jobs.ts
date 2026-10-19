/**
 * 职责：项目级 skill 队列：冻结生成来源和模型配置，保存候选结果并阻止过期来源发布。
 * 关键方法与用途：`enqueueProjectSkill()` 冻结来源和配置；`runNextProjectSkill()` 生成并保存候选；`listProjectSkillAttempts()` 查询尝试历史。
 * 使用场景：`app.ts` 提交／查询，`worker.ts` 执行生成任务。
 */
import {resolveRepositoryPath} from '../paths';
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {join,resolve} from 'node:path';
import {rm} from 'node:fs/promises';
import {resolveRuleWorkspacePaths,scanRuleWorkspace,freezeRuleWorkspace,verifyRuleSnapshot} from '../rule-files';
import {mergeCodexDefaults,readProjectAgentDefaults,validateAgentModel} from '../agent/config';
import {generateProjectSkill} from './generate';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
const projectSql="SELECT p.* FROM ai_distill.projects p WHERE p.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p";
export async function enqueueProjectSkill(pool:Pool,id:string,raw:unknown,options:{template?:string}={}){
 const db=await pool.connect();let snapshot:string|undefined;let attempt:string|undefined;
 try{
  await db.query('BEGIN');const project=(await db.query(projectSql,[id])).rows[0];if(!project)throw new HTTPException(404,{message:'项目不存在'});
  const validated=mergeCodexDefaults(raw,await readProjectAgentDefaults(db,id));
  if(typeof validated.model!=='string'||typeof validated.reasoning_effort!=='string')throw new HTTPException(400,{message:'skill生成需要Codex配置'});
  validateAgentModel(validated.model,validated.reasoning_effort);
  const config={provider:'codex',model:validated.model,reasoning_effort:validated.reasoning_effort};
  const paths=await resolveRuleWorkspacePaths(project),workspace=paths.workspace_path;
  const template=typeof project.parent_name==='string'&&typeof project.local_skill_path==='string'
   ?resolve(project.local_skill_path)
   :resolveRepositoryPath(options.template??process.env.SKILL_BASE_TEMPLATE_DIR??'templates/company-legal-task');
  const source=await scanRuleWorkspace(workspace,template,'workspace',paths.materials_path);if(source.issues.length)throw new HTTPException(409,{message:'基础模板或本期资料不完整'});
  const existing=(await db.query("SELECT id,status,input,config FROM ai_distill.project_skill_attempts WHERE project_id=$1 AND status IN ('waiting','running','succeeded') ORDER BY created_at DESC",[id])).rows;
  const previous=existing.find(row=>row.input.source_digest===source.source_digest&&JSON.stringify(row.config)===JSON.stringify(config));
  // JSONB property order is irrelevant to frozen config equality.
  const matching=previous??existing.find(row=>row.input.source_digest===source.source_digest&&row.config.provider===config.provider&&row.config.model===config.model&&row.config.reasoning_effort===config.reasoning_effort);
  if(matching){await db.query('COMMIT');withLogContext({component:'skill_generation',project_id:id,skill_attempt_id:matching.id,operation:'skill_generation'},()=>logEvent('attempt.reused',{level:'info',state:matching.status}));return{id:matching.id,reused:true};}
  if(existing.some(row=>['waiting','running'].includes(row.status)))throw new HTTPException(409,{message:'已有skill生成任务，请等待完成'});
  attempt=crypto.randomUUID();snapshot=await freezeRuleWorkspace(source,`skill-input-${attempt}`);
  const input={workspace_path:source.workspace_path,materials_path:source.materials_path,template_path:source.skill_path,source_digest:source.source_digest,snapshot_path:snapshot,files:source.files};
  await db.query("INSERT INTO ai_distill.project_skill_attempts(id,project_id,status,input,config) VALUES($1,$2,'waiting',$3,$4)",[attempt,id,JSON.stringify(input),JSON.stringify(config)]);await db.query('COMMIT');withLogContext({component:'skill_generation',project_id:id,skill_attempt_id:attempt,operation:'skill_generation',provider:'codex',model:config.model,reasoning_effort:config.reasoning_effort},()=>logEvent('attempt.enqueued',{level:'info',state:'waiting'}));return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');if(snapshot&&attempt)try{if(!(await pool.query('SELECT id FROM ai_distill.project_skill_attempts WHERE id=$1',[attempt])).rowCount)await rm(snapshot,{recursive:true,force:true});}catch(cleanupError){withLogContext({component:'skill_generation',project_id:id,skill_attempt_id:attempt,operation:'skill_generation'},()=>logEvent('file.cleanup_or_commit_check_failed',{level:'error',file_kind:'skill_input_snapshot',...classifyLogError(cleanupError)}));console.error('无法确认skill输入快照提交状态，保留文件');}throw error;}finally{db.release();}
}
async function current(db:PoolClient,job:any){
 const project=(await db.query(projectSql,[job.project_id])).rows[0];if(!project)return false;
 const paths=await resolveRuleWorkspacePaths(project);
 try{return (await scanRuleWorkspace(paths.workspace_path,job.input.template_path,'workspace',paths.materials_path)).source_digest===job.input.source_digest;}catch{return false;}
}
export async function runNextProjectSkill(pool:Pool,root:string,generate:typeof generateProjectSkill=generateProjectSkill,signal?:AbortSignal){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any,staleRows:any[]=[];
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.project_id,a.heartbeat_at FROM ai_distill.project_skill_attempts a JOIN ai_distill.projects p ON p.id=a.project_id WHERE a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY p.id,a.id FOR UPDATE OF p,a SKIP LOCKED");
  for(const row of stale.rows){const updated=await db.query("UPDATE ai_distill.project_skill_attempts SET status='failed',error='skill生成进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[row.id]);if(updated.rowCount)staleRows.push(row);}
  job=(await db.query("SELECT a.*,p.id AS project_id FROM ai_distill.project_skill_attempts a JOIN ai_distill.projects p ON p.id=a.project_id WHERE p.deleted_at IS NULL AND a.status='waiting' ORDER BY a.created_at,a.id FOR UPDATE OF p,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');for(const row of staleRows)withLogContext({component:'skill_generation',project_id:row.project_id,skill_attempt_id:row.id,operation:'skill_generation'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));return false;}
  await db.query("UPDATE ai_distill.project_skill_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 for(const row of staleRows)withLogContext({component:'skill_generation',project_id:row.project_id,skill_attempt_id:row.id,operation:'skill_generation'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));
 const restoreLogContext=enterLogContext({component:'skill_generation',project_id:job.project_id,skill_attempt_id:job.id,operation:'skill_generation',provider:'codex',model:job.config?.model,reasoning_effort:job.config?.reasoning_effort});
 logEvent('attempt.claimed',{level:'info',state:'running'});logEvent('attempt.started',{level:'info',state:'running'});
 const cancellation=watchTaskCancellation(pool,job.id,signal,true);signal=cancellation.signal;
 let heartbeatFailed=false,lastHeartbeatAt=new Date().toISOString();
 let heartbeatInFlight=false;
 const heartbeat=setInterval(()=>{if(heartbeatInFlight)return;heartbeatInFlight=true;withLogContext({component:'skill_generation',project_id:job.project_id,skill_attempt_id:job.id},()=>pool.query("UPDATE ai_distill.project_skill_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]).then(result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});heartbeatFailed=true;}else{if(heartbeatFailed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch(error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});console.error('skill任务心跳失败');}heartbeatFailed=true;}).finally(()=>{heartbeatInFlight=false;}));},10000);
 let failurePhase='input_validation';
 try{
  await verifyRuleSnapshot(job.input.snapshot_path,job.input.files);
  const before=await pool.connect();try{await before.query('BEGIN');if(!await current(before,job))throw new Error('stale input');await before.query('COMMIT');}catch(error){await before.query('ROLLBACK');throw error;}finally{before.release();}
  failurePhase='agent_execution';
  const result=await generate({project:job.input.snapshot_path,template:join(job.input.snapshot_path,'skill'),root:join(resolve(root),'project-skills',job.project_id,job.id),model:job.config.model,reasoning_effort:job.config.reasoning_effort,signal});
  if(signal?.aborted)throw new Error('cancelled');
  failurePhase='result_persistence';
  const tx=await pool.connect();try{await tx.query('BEGIN');if(!await current(tx,job))throw new Error('stale input');const saved=await tx.query("UPDATE ai_distill.project_skill_attempts SET status=$2,result=$3,session_id=$4,error=NULL,finished_at=now() WHERE id=$1 AND status='running'",[job.id,'succeeded',JSON.stringify(result),result.session_id]);if(!saved.rowCount)throw new Error('inactive');await tx.query('COMMIT');logEvent('attempt.completed',{level:'info',state:'succeeded'});}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  logEvent('attempt.failed',{level:'error',state:'failed',...classifyLogError(error),failure_phase:failurePhase});
  await pool.query("UPDATE ai_distill.project_skill_attempts SET status='failed',error='skill生成失败、取消或输入已变化，请核对后重试',finished_at=now() WHERE id=$1 AND status='running'",[job.id]);
 }finally{cancellation.dispose();clearInterval(heartbeat);restoreLogContext();}
 return true;
}
export async function listProjectSkillAttempts(pool:Pool,id:string){
 try{const project=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);if(!project.rowCount)throw new HTTPException(404,{message:'项目不存在'});return (await pool.query('SELECT id,status,config,result,error,session_id,created_at,started_at,finished_at FROM ai_distill.project_skill_attempts WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 100',[id])).rows;}catch(error){throw error;}
}
