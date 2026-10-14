/**
 * 职责：阶段钩子的持久记录、同步执行和主操作检查点；不解释或修改模型业务结果。
 * 入口：freezeStageHooks() 用于派发；executeWithStageHooks() 包装阶段主操作；registerAsyncAfterHooks() 在成功事务内登记附加任务。
 * 无钩子时不查询新表；异步领取独立实现，不占用业务 ordinal。
 */
import type {Pool,PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson,type WorkflowConfig} from '../shared/workflow-config';
import {freezeHookScript,runHookScript,type FrozenHook,type HookPayload,type HookResult,type HookAddition} from './workflow-hooks';
export interface FrozenStageHooks {before:FrozenHook[];after:FrozenHook[]}
export type StageWorkerMode='all'|'local'|'api';
/** 默认 all 兼容旧消费者；local 只领带脚本快照的主任务，api 排除它们。 */
export function stageHookAffinitySql(mode:StageWorkerMode='all'){
 const local="(a.input->'hooks' IS NOT NULL AND a.input->'hooks'<>'null'::jsonb)";
 if(mode==='all')return 'TRUE';
 if(mode==='local')return local;
 if(mode==='api')return `NOT ${local}`;
 throw new Error('任务执行主机模式无效');
}
type Database=Pick<Pool|PoolClient,'query'>;
export interface StageHookContext {
 pool:Database;attempt_id:string;workflow_id:string;stage:HookPayload['stage'];binding_digest:string;
 input:Record<string,unknown>;hooks?:FrozenStageHooks;signal?:AbortSignal;
}
const sha=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export class StageHookError extends Error {readonly reason_code='project_hook_failed';constructor(message:string){super(`项目钩子${message}`);this.name='StageHookError';}}
const fail=(message:string)=>new StageHookError(message);
export async function freezeStageHooks(root:string,workflow?:WorkflowConfig):Promise<FrozenStageHooks|undefined>{
 if(!workflow||!workflow.hooks.before.length&&!workflow.hooks.after.length)return undefined;
 try{
  const before:FrozenHook[]=[],after:FrozenHook[]=[];
  for(const action of workflow.hooks.before)before.push(await freezeHookScript(root,action));
  for(const action of workflow.hooks.after)after.push(await freezeHookScript(root,action));
  return {before,after};
 }catch(error){throw error;}
}
function binding(context:StageHookContext){return sha({source:context.binding_digest,input:context.input,hooks:context.hooks});}
function payload(context:StageHookContext,position:'before'|'after',hook:FrozenHook,output?:Record<string,unknown>):HookPayload{
 return {stage:context.stage,position,attempt_id:context.attempt_id,workflow_id:context.workflow_id,idempotency_key:`${context.attempt_id}:${position}:${hook.action.id}`,input:context.input,...(output?{output}:{})};
}
async function record(context:StageHookContext,position:'before'|'after'|'main',action_id:string,mode:'sync'|'async'|'checkpoint',snapshot:unknown,idempotent=false){
 const digest=binding(context);
 const read=async()=>{try{return (await context.pool.query('SELECT * FROM ai_distill.hook_runs WHERE attempt_id=$1 AND position=$2 AND action_id=$3',[context.attempt_id,position,action_id])).rows[0];}catch(error){throw error;}};
 let row=await read();
 if(!row){
  row=(await context.pool.query(`INSERT INTO ai_distill.hook_runs(id,workflow_id,attempt_id,stage,position,action_id,mode,status,binding_digest,snapshot,idempotent)
   SELECT $1,$2,$3,$4,$5,$6,$7,'waiting',$8,$9,$10 WHERE EXISTS (SELECT 1 FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id WHERE a.id=$3 AND a.workflow_id=$2 AND a.status='running' AND w.deleted_at IS NULL AND p.deleted_at IS NULL)
   ON CONFLICT(attempt_id,position,action_id) DO NOTHING RETURNING *`,[randomUUID(),context.workflow_id,context.attempt_id,context.stage,position,action_id,mode,digest,JSON.stringify(snapshot),idempotent])).rows[0]??await read();
 }
 if(!row)throw fail('主任务已失效，执行记录未创建');
 if(row.binding_digest!==digest||row.mode!==mode||row.stage!==context.stage)throw fail('输入或脚本绑定不一致，不能复用检查点');
 if(row.status==='succeeded'&&mode!=='async'&&row.result_digest!==sha(row.result))throw fail('已保存结果指纹不一致，不能复用检查点');
 return row;
}
async function save(context:StageHookContext,id:string,status:string,result:unknown=null,error:string|null=null){
 const saved=await context.pool.query(`UPDATE ai_distill.hook_runs SET status=$2,result=$3,error=$4,result_digest=$5,heartbeat_at=now(),started_at=CASE WHEN $2='running' THEN now() ELSE started_at END,finished_at=CASE WHEN $2 IN ('succeeded','failed','cancelled','needs_review') THEN now() ELSE NULL END WHERE id=$1 AND EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.id=hook_runs.attempt_id AND a.status='running') RETURNING id`,[id,status,JSON.stringify(result),error,status==='succeeded'?sha(result):null]);
 if(!saved.rowCount)throw fail('主任务已失效，结果未提交');
}
/** 成功记录复用；副作用状态未知的非幂等动作不自动重跑。 */
async function syncHook(context:StageHookContext,hook:FrozenHook,position:'before'|'after',runScript:typeof runHookScript,output?:Record<string,unknown>){
 const input=payload(context,position,hook,output),row=await record(context,position,hook.action.id,'sync',{hook,payload:input},hook.action.idempotent);
 if(row.status==='succeeded')return row.result as HookResult;
 if(context.signal?.aborted)throw fail('执行已取消');
 if(['running','needs_review'].includes(row.status)&&!hook.action.idempotent)throw fail('副作用状态待核，不能自动重试');
 // 主 attempt 由既有阶段队列独占领取；本记录不进入异步消费者。
 await save(context,row.id,'running');
 try{
  const result=await runScript(hook,input,{signal:context.signal});
  if(context.signal?.aborted)throw fail('执行已取消');
  await save(context,row.id,'succeeded',result);return result;
 }catch(error){
  await save(context,row.id,context.signal?.aborted?'cancelled':hook.action.idempotent?'failed':'needs_review',null,'项目钩子执行失败或中断');
  throw fail('执行失败或中断，主操作原始结果已保留');
 }
}
export async function executeWithStageHooks<T>(context:StageHookContext&{runMain:(additions?:HookAddition[])=>Promise<T>;outputForHooks?:(result:T)=>Record<string,unknown>;runScript?:typeof runHookScript}):Promise<T>{
 if(context.signal?.aborted)throw fail('执行已取消');
 if(!context.hooks||!context.hooks.before.length&&!context.hooks.after.length)return await context.runMain();
 const runScript=context.runScript??runHookScript;
 const additions:HookAddition[]=[];
 for(const hook of context.hooks.before){
  if(hook.action.mode==='async')await record(context,'before',hook.action.id,'async',{hook,payload:payload(context,'before',hook)},hook.action.idempotent);
  else {const result=await syncHook(context,hook,'before',runScript);if(result.additions?.length){if(context.stage==='answer')throw fail('作答阶段不允许附加输入');additions.push(...result.additions);}}
 }
 const checkpoint=await record(context,'main','__main__','checkpoint',{input:context.input,...(additions.length?{additions}:{})});
 let main:T;
 if(checkpoint.status==='succeeded')main=checkpoint.result as T;
 else{
  if(['running','needs_review'].includes(checkpoint.status))throw fail('主操作完成状态未知，不能自动重复调用模型');
  await save(context,checkpoint.id,'running');
  try{main=await context.runMain(additions.length?additions:undefined);await save(context,checkpoint.id,'succeeded',main);}
  catch(error){await save(context,checkpoint.id,'needs_review',null,'主操作未返回可保存的完整结果');throw error;}
 }
 const output=context.outputForHooks?context.outputForHooks(main):{};
 for(const hook of context.hooks.after)if(hook.action.mode==='sync')await syncHook(context,hook,'after',runScript,output);
 return main;
}
/** 调用方必须传入保存主阶段成功结果的同一个事务，保证 after 附加任务与主结果一起提交。 */
export async function registerAsyncAfterHooks(context:StageHookContext,output:Record<string,unknown>){
 if(!context.hooks)return;
 for(const hook of context.hooks.after)if(hook.action.mode==='async')await record(context,'after',hook.action.id,'async',{hook,payload:payload(context,'after',hook,output)},hook.action.idempotent);
}

/** 在阶段队列持有失联主尝试锁的同一恢复事务内调用；只标记状态，不执行脚本或模型。
 * 已成功记录保持原文及摘要；运行中记录转待核，避免把失联误认为可重复的收费调用。
 */
export async function recoverInterruptedStageHooks(db:Database,attempt:{id:string;input?:{hooks?:FrozenStageHooks}}):Promise<boolean>{
 if(!attempt.input?.hooks)return false;
 if((await db.query("SELECT to_regclass('ai_distill.hook_runs') IS NOT NULL AS available")).rows[0]?.available!==true)return false;
 const records=await db.query("SELECT id,mode,status FROM ai_distill.hook_runs WHERE attempt_id=$1 AND mode IN ('sync','checkpoint') FOR UPDATE",[attempt.id]);
 if(!records.rows.length)return false;
 await db.query(`UPDATE ai_distill.hook_runs SET history=history||jsonb_build_array(jsonb_build_object('status',status,'error',error,'started_at',started_at,'finished_at',finished_at)),status='needs_review',error='执行进程中断，完成状态待核',finished_at=now()
  WHERE attempt_id=$1 AND mode IN ('sync','checkpoint') AND status='running'`,[attempt.id]);
 await db.query(`UPDATE ai_distill.step_attempts SET result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE '{}'::jsonb END)||'{"error_code":"project_hook_failed"}'::jsonb WHERE id=$1 AND status='running'`,[attempt.id]);
 return true;
}
