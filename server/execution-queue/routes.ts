/** 本机队列只读状态与本机取消入口；不暴露正文、凭证或调用检查点。由createApp挂载。 */
import type {Hono} from 'hono';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {localQueueEnabled,localQueue,registerLocalJob,synchronizeCancellation} from './runtime';
import type {JobKind,Lane} from './store';
import {uuid} from '../validation';
export function registerExecutionQueueRoutes(app:Hono,pool:Pool,root:string){
 app.get('/api/system/execution-queue',c=>{
  if(!localQueueEnabled())return c.json({mode:'legacy',executor_id:null,items:[]});
  const q=localQueue(root);return c.json({mode:'local',executor_id:q.executorId,items:q.list().map(({pid,lease,error,...job})=>job)});
 });
 app.post('/api/system/execution-queue/adopt',async c=>{
  if(!localQueueEnabled())throw new HTTPException(409,{message:'尚未启用本机独立队列'});
  const body=await c.req.json<{jobs:{id:string;kind:JobKind}[]}>().catch(()=>{throw new HTTPException(400,{message:'认领参数须为JSON'});});
  if(!body||!Array.isArray(body.jobs)||!body.jobs.length||body.jobs.length>100||body.jobs.some(j=>!j||typeof j.id!=='string'||!['step','skill','library','hook','remote'].includes(j.kind)))throw new HTTPException(400,{message:'必须明确指定1至100个旧任务，不能自动导入全库'});
  const q=localQueue(root),db=await pool.connect(),accepted:string[]=[];
  try{await db.query('BEGIN');for(const input of body.jobs){
   uuid(input.id);const table=({step:'step_attempts',skill:'project_skill_attempts',library:'library_jobs',hook:'hook_runs',remote:'remote_material_operations'} as const)[input.kind];if(!table)throw new HTTPException(400,{message:'任务类型无效'});
   const j=(await db.query(`SELECT to_jsonb(j) AS job FROM ai_distill.${table} j WHERE id=$1 FOR UPDATE`,[input.id])).rows[0]?.job;
   if(!j||!['waiting','queued'].includes(j.status))throw new HTTPException(409,{message:'只能认领明确指定的未开始任务'});
   const owner=(await db.query('SELECT executor_id FROM ai_distill.execution_dispatches WHERE job_id=$1',[input.id])).rows[0];if(owner&&owner.executor_id!==q.executorId)throw new HTTPException(409,{message:'任务已归属另一台电脑，不自动迁移'});
   let route:string,lane:Lane;
   if(input.kind==='library'){route=`library:${j.kind}`;lane=j.executor_kind;}
   else if(input.kind==='skill'){route='skill';lane='agent';}
   else if(input.kind==='hook'){if(j.mode!=='async')throw new HTTPException(409,{message:'同步钩子属于原主任务'});route='hook';lane='hook';}
   else if(input.kind==='remote'){route='remote';lane='remote';}
   else{route=({1:'intake',2:'extract',4:'authoring',5:'answer',6:'score',9:'redact'} as Record<number,string>)[j.ordinal];if(!route)throw new HTTPException(409,{message:'该步骤不属于后台执行队列'});lane=j.ordinal===1?'internal':j.ordinal===2?'api':j.ordinal===4?'agent':j.config?.provider==='codex'||j.ordinal===6&&j.config?.provider!=='api'?'agent':'api';}
   await registerLocalJob(db,input.id,input.kind,lane,route);accepted.push(input.id);
  }await db.query('COMMIT');return c.json({executor_id:q.executorId,ids:accepted});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.post('/api/system/execution-queue/:id/cancel',async c=>{
  if(!localQueueEnabled())throw new HTTPException(409,{message:'尚未启用本机独立队列'});
  const id=uuid(c.req.param('id'));const q=localQueue(root),job=q.get(id);if(!job)throw new HTTPException(404,{message:'任务不属于本机队列'});
  q.cancel(id); // local cancellation persists even when cloud is temporarily unavailable
  await synchronizeCancellation(pool,q,id);return c.json({id,cancel_requested:Boolean(q.get(id)?.cancel_requested),cloud_synced:Boolean(q.get(id)?.cancel_synced),executor_id:q.executorId});
 });
}
