/**
 * 职责：任务取消传播：为当前异步任务提供 AbortSignal，并轮询持久化状态中止失效执行。
 * 关键方法与用途：`withTaskSignal()` 为异步工作绑定取消信号；`watchTaskCancellation()` 轮询持久化状态并中止失效任务。
 * 使用场景：队列在开始执行时包装任务；`currentTaskSignal()` 供当前调用链读取。
 */
import type {Pool} from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import{classifyLogError,logEvent,withLogContext}from'./logging';
const context=new AsyncLocalStorage<AbortSignal>();
export const currentTaskSignal=()=>context.getStore();
export function withTaskSignal<T>(signal:AbortSignal,run:()=>Promise<T>){return context.run(signal,run);}
export function watchTaskCancellation(pool:Pool,id:string,upstream?:AbortSignal,projectSkill=false,intervalMs=1000){
 const controller=new AbortController();let checking=false,disposed=false,pollFailed=false;
 const abort=()=>controller.abort();upstream?.addEventListener('abort',abort,{once:true});if(upstream?.aborted)abort();
 const timer=setInterval(async()=>{
  if(checking||disposed||controller.signal.aborted)return;checking=true;
  try{
   const result=await pool.query(projectSkill?'SELECT status FROM ai_distill.project_skill_attempts WHERE id=$1':'SELECT status FROM ai_distill.step_attempts WHERE id=$1',[id]);
   if(pollFailed)withLogContext({component:'task_cancellation',...(projectSkill?{skill_attempt_id:id}:{attempt_id:id}),operation:'poll_status'},()=>logEvent('task.cancellation.poll_recovered',{level:'info'}));
   pollFailed=false;if(!disposed&&result.rows[0]?.status!=='running')abort();
  }catch(error){if(!pollFailed){withLogContext({component:'task_cancellation',...(projectSkill?{skill_attempt_id:id}:{attempt_id:id}),operation:'poll_status'},()=>logEvent('task.cancellation.poll_failed',{level:'warn',...classifyLogError(error)}));console.error('任务取消状态暂时无法读取，等待下次核对');}pollFailed=true;}finally{checking=false;}
 },intervalMs);timer.unref();
 return {signal:controller.signal,dispose(){disposed=true;clearInterval(timer);upstream?.removeEventListener('abort',abort);}};
}
