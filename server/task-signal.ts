import type {Pool} from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage<AbortSignal>();
export const currentTaskSignal=()=>context.getStore();
export function withTaskSignal<T>(signal:AbortSignal,run:()=>Promise<T>){return context.run(signal,run);}
export function watchTaskCancellation(pool:Pool,id:string,upstream?:AbortSignal,projectSkill=false,intervalMs=1000){
 const controller=new AbortController();let checking=false,disposed=false;
 const abort=()=>controller.abort();upstream?.addEventListener('abort',abort,{once:true});if(upstream?.aborted)abort();
 const timer=setInterval(async()=>{
  if(checking||disposed||controller.signal.aborted)return;checking=true;
  try{
   const result=await pool.query(projectSkill?'SELECT status FROM ai_distill.project_skill_attempts WHERE id=$1':'SELECT status FROM ai_distill.step_attempts WHERE id=$1',[id]);
   if(!disposed&&result.rows[0]?.status!=='running')abort();
  }catch{console.error('任务取消状态暂时无法读取，等待下次核对');}finally{checking=false;}
 },intervalMs);timer.unref();
 return {signal:controller.signal,dispose(){disposed=true;clearInterval(timer);upstream?.removeEventListener('abort',abort);}};
}
