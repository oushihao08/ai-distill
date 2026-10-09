import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {dirname,join,resolve} from 'node:path';
import {rm} from 'node:fs/promises';
import {scanRuleWorkspace,freezeRuleWorkspace,verifyRuleSnapshot} from '../rule-files';
import {validateStepConfig} from '../project-folders';
import {mergeCodexDefaults,readProjectCodexDefaults} from '../codex/system-config';
import {generateProjectSkill} from './generate';
const projectSql="SELECT p.*, (SELECT manifest->>'workspace_path' FROM ai_distill.rule_versions WHERE project_id=p.id ORDER BY version DESC LIMIT 1) AS workspace_path FROM ai_distill.projects p WHERE p.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p";
export async function enqueueProjectSkill(pool:Pool,id:string,raw:unknown,options:{template?:string}={}){
 const db=await pool.connect();let snapshot:string|undefined;let attempt:string|undefined;
 try{
  await db.query('BEGIN');const project=(await db.query(projectSql,[id])).rows[0];if(!project)throw new HTTPException(404,{message:'项目不存在'});
  const validated=validateStepConfig(3,mergeCodexDefaults(raw,await readProjectCodexDefaults(db,id)));
  if(!('reasoning_effort' in validated))throw new HTTPException(400,{message:'skill生成需要Codex配置'});
  const config={provider:'codex',model:validated.model,reasoning_effort:validated.reasoning_effort};
  const workspace=project.workspace_path??dirname(project.material_root??project.local_skill_path??'');
  const template=options.template??process.env.SKILL_BASE_TEMPLATE_DIR??'/Users/jack/Documents/codes/lvgou/豆包高经/company-legal-task';
  const source=await scanRuleWorkspace(workspace,template);if(source.issues.length)throw new HTTPException(409,{message:'基础模板或本期资料不完整'});
  const existing=(await db.query("SELECT id,status,input,config FROM ai_distill.project_skill_attempts WHERE project_id=$1 AND status IN ('waiting','running','succeeded') ORDER BY created_at DESC",[id])).rows;
  const previous=existing.find(row=>row.input.source_digest===source.source_digest&&JSON.stringify(row.config)===JSON.stringify(config));
  // JSONB property order is irrelevant to frozen config equality.
  const matching=previous??existing.find(row=>row.input.source_digest===source.source_digest&&row.config.provider===config.provider&&row.config.model===config.model&&row.config.reasoning_effort===config.reasoning_effort);
  if(matching){await db.query('COMMIT');return{id:matching.id,reused:true};}
  if(existing.some(row=>['waiting','running'].includes(row.status)))throw new HTTPException(409,{message:'已有skill生成任务，请等待完成'});
  attempt=crypto.randomUUID();snapshot=await freezeRuleWorkspace(source,`skill-input-${attempt}`);
  const input={workspace_path:source.workspace_path,template_path:source.skill_path,source_digest:source.source_digest,snapshot_path:snapshot,files:source.files};
  await db.query("INSERT INTO ai_distill.project_skill_attempts(id,project_id,status,input,config) VALUES($1,$2,'waiting',$3,$4)",[attempt,id,JSON.stringify(input),JSON.stringify(config)]);await db.query('COMMIT');return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');if(snapshot&&attempt)try{if(!(await pool.query('SELECT id FROM ai_distill.project_skill_attempts WHERE id=$1',[attempt])).rowCount)await rm(snapshot,{recursive:true,force:true});}catch{console.error('无法确认skill输入快照提交状态，保留文件');}throw error;}finally{db.release();}
}
async function current(db:PoolClient,job:any){
 const project=(await db.query(projectSql,[job.project_id])).rows[0];if(!project)return false;
 const workspace=project.workspace_path??dirname(project.material_root??project.local_skill_path??'');
 try{return (await scanRuleWorkspace(workspace,job.input.template_path)).source_digest===job.input.source_digest;}catch{return false;}
}
export async function runNextProjectSkill(pool:Pool,root:string,generate:typeof generateProjectSkill=generateProjectSkill,signal?:AbortSignal){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any;
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.project_id FROM ai_distill.project_skill_attempts a JOIN ai_distill.projects p ON p.id=a.project_id WHERE a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY p.id,a.id FOR UPDATE OF p,a SKIP LOCKED");
  for(const row of stale.rows)await db.query("UPDATE ai_distill.project_skill_attempts SET status='failed',error='skill生成进程中断，可重试',finished_at=now() WHERE id=$1",[row.id]);
  job=(await db.query("SELECT a.* FROM ai_distill.project_skill_attempts a JOIN ai_distill.projects p ON p.id=a.project_id WHERE p.deleted_at IS NULL AND a.status='waiting' ORDER BY a.created_at,a.id FOR UPDATE OF p,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');return false;}
  await db.query("UPDATE ai_distill.project_skill_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const cancellation=watchTaskCancellation(pool,job.id,signal,true);signal=cancellation.signal;
 const heartbeat=setInterval(()=>{pool.query("UPDATE ai_distill.project_skill_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>console.error('skill任务心跳失败'));},10000);
 try{
  await verifyRuleSnapshot(job.input.snapshot_path,job.input.files);
  const before=await pool.connect();try{await before.query('BEGIN');if(!await current(before,job))throw new Error('stale input');await before.query('COMMIT');}catch(error){await before.query('ROLLBACK');throw error;}finally{before.release();}
  const result=await generate({project:job.input.snapshot_path,template:join(job.input.snapshot_path,'skill'),root:join(resolve(root),'project-skills',job.project_id,job.id),model:job.config.model,reasoning_effort:job.config.reasoning_effort,signal});
  if(signal?.aborted)throw new Error('cancelled');
  const tx=await pool.connect();try{await tx.query('BEGIN');if(!await current(tx,job))throw new Error('stale input');const saved=await tx.query("UPDATE ai_distill.project_skill_attempts SET status=$2,result=$3,session_id=$4,error=NULL,finished_at=now() WHERE id=$1 AND status='running'",[job.id,'succeeded',JSON.stringify(result),result.session_id]);if(!saved.rowCount)throw new Error('inactive');await tx.query('COMMIT');}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch{
  await pool.query("UPDATE ai_distill.project_skill_attempts SET status='failed',error='skill生成失败、取消或输入已变化，请核对后重试',finished_at=now() WHERE id=$1 AND status='running'",[job.id]);
 }finally{cancellation.dispose();clearInterval(heartbeat);}
 return true;
}
export async function listProjectSkillAttempts(pool:Pool,id:string){
 try{const project=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);if(!project.rowCount)throw new HTTPException(404,{message:'项目不存在'});return (await pool.query('SELECT id,status,config,result,error,session_id,created_at,started_at,finished_at FROM ai_distill.project_skill_attempts WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 100',[id])).rows;}catch(error){throw error;}
}
