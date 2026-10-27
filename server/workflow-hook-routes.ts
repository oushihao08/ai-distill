/**
 * 职责：阶段钩子的受限记录读取与显式续跑 API，保留主操作检查点和历史错误。
 * 入口：resumeHookAttempt() 恢复原失败尝试；registerWorkflowHookRoutes() 装配 Hono 路由。
 * 约束：只恢复程序标记的钩子失败；不自动重复未知主模型调用，不读取或返回私有脚本快照。
 */
import {runHookScript} from './workflow-hooks';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../shared/workflow-config';
import {releaseRolledBackRegistrations,forgetLocalRegistrations,rearmLocalJob,registerLocalJob} from './execution-queue/runtime';
import type {Pool} from 'pg';
import type {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {uuid} from './validation';
import {activeHookParentSql} from './workflow-hook-worker';
import {validateWorkflowConfig} from '../shared/workflow-config';
const conflict=(message:string)=>new HTTPException(409,{message});
async function hasTable(db:Pick<Pool,'query'>){return (await db.query("SELECT to_regclass('ai_distill.hook_runs') IS NOT NULL AS available")).rows[0]?.available===true;}
/** 原尝试只有在自身报告钩子失败、当前输入仍有效且主调用结果不处于未知状态时才能继续。 */
export async function resumeHookAttempt(pool:Pool,id:string,acknowledgeSideEffects:boolean){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  if(!await hasTable(db))throw conflict('钩子执行表尚未安装，请先应用033迁移');
  const row=(await db.query(`SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id
   WHERE a.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w,a`,[id])).rows[0];
  if(!row||![4,5,6].includes(row.ordinal)||row.result?.error_code!=='project_hook_failed')throw conflict('本次尝试不是可续跑的钩子失败');
  if(['waiting','running'].includes(row.status)){await db.query('COMMIT');forgetLocalRegistrations(db);return {id,reused:true};}
  if(row.status!=='failed')throw conflict('本次尝试状态不允许续跑');
  const hooks=(await db.query(`SELECT h.* FROM ai_distill.hook_runs h WHERE h.attempt_id=$1 AND h.mode IN ('sync','checkpoint') AND ${activeHookParentSql(true)} ORDER BY h.created_at FOR UPDATE OF h`,[id])).rows;
  if(!hooks.length)throw conflict('输入已失效或没有可续跑的失败钩子');
  if(hooks.some(hook=>hook.position==='after')){
   const checkpoint=await db.query("SELECT id FROM ai_distill.hook_runs WHERE attempt_id=$1 AND mode='checkpoint' AND status='succeeded' AND result IS NOT NULL AND result<>'null'::jsonb LIMIT 1",[id]);
   if(!checkpoint.rowCount)throw conflict('主操作检查点缺失，不能续跑后置钩子');
  }
  const unknown=await db.query("SELECT id FROM ai_distill.hook_runs WHERE attempt_id=$1 AND status='running' OR (attempt_id=$1 AND mode='checkpoint' AND status='needs_review') LIMIT 1",[id]);
  if(unknown.rowCount)throw conflict('主操作或钩子仍在执行，或完成状态未知，不能重复调用');
  const active=await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=$2 AND id<>$3 AND status IN ('waiting','running') LIMIT 1",[row.workflow_id,row.ordinal,id]);
  if(active.rowCount)throw conflict('同一步骤还有活动任务，请等待完成后续跑');
  if(hooks.some(hook=>hook.mode!=='checkpoint'&&['failed','needs_review','cancelled'].includes(hook.status)&&!hook.idempotent)&&!acknowledgeSideEffects)throw conflict('钩子副作用状态需要核实；确认可再次执行后才能续跑');
  await db.query(`UPDATE ai_distill.hook_runs SET history=history||jsonb_build_array(jsonb_build_object('status',status,'error',error,'started_at',started_at,'finished_at',finished_at)),status='waiting',error=NULL,finished_at=NULL
   WHERE attempt_id=$1 AND mode='sync' AND status IN ('failed','needs_review','cancelled')`,[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='waiting',error=NULL,finished_at=NULL WHERE id=$1 AND status='failed'",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>=$2 AND ordinal<=8",[row.workflow_id,row.ordinal]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='钩子续跑，下游当前结果失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>$2 AND ordinal<=8 AND status IN ('waiting','running')",[row.workflow_id,row.ordinal]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[row.workflow_id]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='钩子续跑，当前结果待更新',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded')",[row.project_id]);
  await registerLocalJob(db,id,'step',row.ordinal===4||row.config?.provider==='codex'||row.ordinal===6&&row.config?.provider!=='api'?'agent':'api',({4:'authoring',5:'answer',6:'score'} as Record<number,string>)[row.ordinal]);
  await rearmLocalJob(db,id);
  await db.query('COMMIT');forgetLocalRegistrations(db);return {id,reused:false};
 }catch(error){await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);throw error;}finally{db.release();}
}
/** 显式补执行单个增强并等待终态；retryAsyncHook为历史导出名，当前不派队列或模型任务，兼容旧async记录。 */
export async function retryAsyncHook(pool:Pool,id:string,acknowledgeSideEffects:boolean,execute:typeof runHookScript=runHookScript){
 const db=await pool.connect();let row:any;
 try{
  await db.query('BEGIN');if(!await hasTable(db))throw conflict('钩子执行表尚未安装，请先应用033迁移');
  row=(await db.query(`SELECT h.* FROM ai_distill.hook_runs h WHERE h.id=$1 AND h.mode<>'checkpoint' AND ${activeHookParentSql()} FOR UPDATE OF h`,[id])).rows[0];
  if(!row)throw conflict('附加任务不存在或输入已失效');
  if(row.status==='succeeded'){await db.query('COMMIT');return {id,reused:true,status:'succeeded'};}
  if(row.status==='running')throw conflict('增强正在执行或完成状态未知，请先核实原执行');
  if(!['waiting','failed','needs_review','cancelled'].includes(row.status))throw conflict('附加任务状态不允许重试');
  if(!row.idempotent&&row.status!=='waiting'&&!acknowledgeSideEffects)throw conflict('钩子副作用状态需要核实；确认可再次执行后才能重试');
  const saved=await db.query(`UPDATE ai_distill.hook_runs h SET history=history||jsonb_build_array(jsonb_build_object('status',status,'error',error,'started_at',started_at,'finished_at',finished_at)),mode='sync',status='running',error=NULL,started_at=now(),finished_at=NULL
   WHERE h.id=$1 AND h.status IN ('waiting','failed','needs_review','cancelled') AND ${activeHookParentSql()} RETURNING id`,[id]);
  if(!saved.rowCount)throw conflict('附加任务输入已失效');
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 try{
  const result=await execute(row.snapshot.hook,row.snapshot.payload);
  const saved=await pool.query(`UPDATE ai_distill.hook_runs h SET status='succeeded',result=$2,result_digest=$3,error=NULL,finished_at=now() WHERE h.id=$1 AND h.status='running' AND ${activeHookParentSql()} RETURNING id`,[id,JSON.stringify(result),createHash('sha256').update(canonicalJson(result)).digest('hex')]);
  if(!saved.rowCount)throw conflict('增强结束时输入已失效，请核实副作用');
  return {id,reused:false,status:'succeeded'};
 }catch(error){
  const status=row.idempotent?'failed':'needs_review';
  await pool.query("UPDATE ai_distill.hook_runs SET status=$2,error='生命周期增强执行失败或中断',finished_at=now() WHERE id=$1 AND status='running'",[id,status]);
  return {id,reused:false,status};
 }
}
function acknowledgment(body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='acknowledge_side_effects')||('acknowledge_side_effects' in body&&typeof body.acknowledge_side_effects!=='boolean'))throw new HTTPException(400,{message:'重试参数无效'});
 return 'acknowledge_side_effects' in body&&body.acknowledge_side_effects===true;
}
export function registerWorkflowHookRoutes(app:Hono,pool:Pool){
 // 局部编辑扩展配置，尤其避免模型集合页与步骤设置互相覆盖作答供应商配置。
 app.put('/api/projects/:id/steps/:ordinal/workflow',async c=>{
  const id=uuid(c.req.param('id')),ordinal=Number(c.req.param('ordinal'));
  if(![4,5,6].includes(ordinal))throw new HTTPException(400,{message:'此步骤不支持流程扩展'});
  const body:unknown=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'流程配置须为有效JSON'});});
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('workflow' in body))throw new HTTPException(400,{message:'仅允许保存workflow配置'});
  let workflow;try{workflow=body.workflow===null?undefined:validateWorkflowConfig(body.workflow);}catch{throw new HTTPException(400,{message:'项目流程配置格式无效'});}
  const saved=await pool.query(`INSERT INTO ai_distill.project_step_configs AS current_config(project_id,ordinal,config)
   SELECT id,$2,$3::jsonb FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL
   ON CONFLICT(project_id,ordinal) DO UPDATE SET config=(current_config.config-'workflow')||EXCLUDED.config,updated_at=now() RETURNING config`,[id,ordinal,JSON.stringify(workflow?{workflow}:{})]);
  if(!saved.rowCount)throw new HTTPException(404,{message:'项目不存在'});
  return c.json(saved.rows[0]);
 });
 app.post('/api/attempts/:id/resume-hooks',async c=>{
  const body:unknown=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'续跑参数须为有效JSON'});});
  return c.json(await resumeHookAttempt(pool,uuid(c.req.param('id')),acknowledgment(body)),202);
 });
 app.post('/api/hooks/:id/retry',async c=>{
  const body:unknown=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'重试参数须为有效JSON'});});
  return c.json(await retryAsyncHook(pool,uuid(c.req.param('id')),acknowledgment(body)));
 });
 app.get('/api/workflows/:id/hooks',async c=>{
  const id=uuid(c.req.param('id'));
  const visible=await pool.query('SELECT w.id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL',[id]);
  if(!visible.rowCount)throw new HTTPException(404,{message:'工作流不存在'});
  if(!await hasTable(pool))return c.json({available:false,runs:[]});
  const runs=await pool.query(`SELECT h.id,h.attempt_id,h.stage,h.position,h.action_id,h.mode,h.status,h.idempotent,h.error,h.result,h.history,h.created_at,h.started_at,h.finished_at,
   (SELECT a.status FROM ai_distill.step_attempts a WHERE a.id=h.attempt_id) AS parent_status,
   EXISTS(SELECT 1 FROM ai_distill.hook_runs cp WHERE cp.attempt_id=h.attempt_id AND cp.mode='checkpoint' AND cp.status='succeeded') AS checkpoint_available
   FROM ai_distill.hook_runs h WHERE h.workflow_id=$1 AND h.mode<>'checkpoint' ORDER BY h.created_at DESC,h.id LIMIT 200`,[id]);
  return c.json({available:true,runs:runs.rows});
 });
}
