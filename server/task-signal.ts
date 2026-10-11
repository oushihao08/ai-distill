/**
 * 职责：任务取消传播：为当前异步任务提供 AbortSignal，并轮询持久化状态中止失效执行。
 * 关键方法与用途：`withTaskSignal()` 为异步工作绑定取消信号；`watchTaskCancellation()` 轮询持久化状态并中止失效任务。
 * 使用场景：队列在开始执行时包装任务；`currentTaskSignal()` 供当前调用链读取。
 */
import type {Pool} from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import{classifyLogError,logEvent,withIsolatedLogContext}from'./logging';
const context=new AsyncLocalStorage<AbortSignal>();
export const currentTaskSignal=()=>context.getStore();
export function withTaskSignal<T>(signal:AbortSignal,run:()=>Promise<T>){return context.run(signal,run);}
interface WatchedTask {id:string;controller:AbortController;projectSkill:boolean;disposed:boolean}
interface CancellationGroup {tasks:Set<WatchedTask>;timer:ReturnType<typeof setTimeout>|undefined;checking:boolean;failed:Set<string>;interval:number}
const groups=new WeakMap<Pool,CancellationGroup>();

async function readStatuses(pool:Pool,table:'step_attempts'|'project_skill_attempts',ids:string[]){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '2000ms'");
  const result=await client.query(`SELECT id,status FROM ai_distill.${table} WHERE id=ANY($1::uuid[])`,[ids]);
  await client.query('COMMIT');
  return result.rows;
 }catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();}
}

/** 同一连接池合并状态查询；状态读取有服务端时限，停止信号仍即时传播。 */
export function watchTaskCancellation(pool:Pool,id:string,upstream?:AbortSignal,projectSkill=false,intervalMs=3000){
 const controller=new AbortController(),task:WatchedTask={id,controller,projectSkill,disposed:false};
 const abort=()=>controller.abort();upstream?.addEventListener('abort',abort,{once:true});if(upstream?.aborted)abort();
 let group=groups.get(pool);
 if(!group){group={tasks:new Set(),timer:undefined,checking:false,failed:new Set(),interval:Math.max(1,intervalMs)};groups.set(pool,group);}
 const current=group;current.tasks.add(task);
 const schedule=()=>{
  if(current.timer||current.checking||!current.tasks.size)return;
  current.timer=setTimeout(async()=>{
   current.timer=undefined;current.checking=true;
   try{
    const tasks=[...current.tasks].filter(item=>!item.disposed&&!item.controller.signal.aborted);
    for(const skill of [false,true]){
     const selected=tasks.filter(item=>item.projectSkill===skill);if(!selected.length)continue;
     const table=skill?'project_skill_attempts':'step_attempts';
     const groupName=skill?'project-skill-attempts':'step-attempts';
     try{
      const rows=await readStatuses(pool,table,[...new Set(selected.map(item=>item.id))]);
      const states=new Map(rows.map(row=>[row.id,row.status]));
      for(const item of selected)if(!item.disposed&&states.get(item.id)!=='running')item.controller.abort();
      const operation=skill?'poll-project-skill-attempts':'poll-step-attempts';
      if(current.failed.delete(groupName))withIsolatedLogContext({component:'task_cancellation',operation},()=>logEvent('task.cancellation.poll_recovered',{level:'info'}));
     }catch(error){
      const operation=skill?'poll-project-skill-attempts':'poll-step-attempts';
      if(!current.failed.has(groupName))withIsolatedLogContext({component:'task_cancellation',operation},()=>logEvent('task.cancellation.poll_failed',{level:'error',...classifyLogError(error)}));
      current.failed.add(groupName);
     }
    }
   }finally{current.checking=false;schedule();}
  },current.interval);current.timer.unref();
 };
 schedule();
 return {signal:controller.signal,dispose(){task.disposed=true;current.tasks.delete(task);upstream?.removeEventListener('abort',abort);if(!current.tasks.size&&current.timer){clearTimeout(current.timer);current.timer=undefined;}}};
}
