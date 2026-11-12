/**
 * 职责：生命周期统一事件入口，向可选订阅者广播阶段事件并记录回调结果日志。
 * 核心入口：
 * - `emitLifecycle()`：直接触发通用生命周期回调并记录 `lifecycle.callback_completed` 日志。
 * - `emitProjectLifecycle()`：按需解析主项目身份（仅在存在 `project_key` 订阅时查询数据库）并触发事件。
 * 不变量与修改禁区：
 * - 回调异常与主项目身份查询异常均只记录日志，严禁升级为主步骤失败或回滚已提交业务结果。
 * - 调用方必须在释放数据库事务后再调用本入口。
 */
import type {Pool} from 'pg';
import {resolveStepProjectKey} from './steps';
import {logEvent,classifyLogError} from '../logging';
import {LifecycleRegistry, type LifecycleContext, type LifecycleEvent} from './registry';
export {LifecycleRegistry, runLifecycleTask} from './registry';
export type {LifecycleContext, LifecycleEvent, LifecycleRegistration, LifecycleOutcome} from './registry';
export const lifecycle = new LifecycleRegistry();

export async function emitLifecycle(event: LifecycleEvent, context: LifecycleContext) {
 const results = await lifecycle.emit(event, context);
 for(const result of results)logEvent('lifecycle.callback_completed', {
  level:result.status === 'succeeded'?'info':'error', operation:context.stage,
  state:result.status, reason_code:result.status === 'failed'?'lifecycle_callback_failed':undefined,
  lifecycle_event:event, callback_id:result.id, execution_id:context.execution_id,
 });
 return results;
}

export {ProjectImplementations} from './project-registry';

/**
 * 各步骤共用的项目事件入口。仅存在按key订阅的回调时读取主项目身份，避免给无扩展路径增加查询。
 * 不将身份补写进历史快照/摘要；材料无项目上下文时只发通用事件。调用点必须在外部回调前释放事务。
 */
export async function emitProjectLifecycle(pool:Pick<Pool,'query'>,event:LifecycleEvent,context:LifecycleContext){
 if(context.project_key===undefined&&lifecycle.hasProjectKeyCallbacks(event,context.stage)&&(context.project_id||context.workflow_id)){
  try {
   const project=(await pool.query(`SELECT p.parent_name,p.name FROM ai_distill.projects p WHERE p.deleted_at IS NULL AND p.id=COALESCE($1::uuid,(SELECT w.project_id FROM ai_distill.workflows w WHERE w.id=$2::uuid AND w.deleted_at IS NULL))`,[context.project_id??null,context.workflow_id??null])).rows[0];
   context={...context,project_key:project?resolveStepProjectKey(project)??undefined:undefined};
  }catch(error){
   // 这是可选通知的身份路由，不得把读库失败升级成主步骤失败或回滚已保存结果。
   logEvent('lifecycle.project_identity_failed',{level:'error',operation:context.stage,lifecycle_event:event,execution_id:context.execution_id,reason_code:'lifecycle_project_identity_unavailable',...classifyLogError(error)});
  }
 }
 return await emitLifecycle(event,context);
}
