/** 任务等待单测：验证轻量投影、完整结果兼容、一秒轮询、截止和取消；只用内存连接池，不访问数据库或模型。 */
import {expect,spyOn,test} from 'bun:test';
import type {Pool} from 'pg';
import {cancelStoppedExecutorAttempt,cancelWaitingScore,waitForAttempt} from './attempts';
import {Hono} from 'hono';
import {registerWorkflowExecutionRoutes} from './workflow-execution-routes';

function fixture(states:string[]){
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{
  calls.push(sql);
  return{rows:[{id:'attempt',workflow_id:'workflow',ordinal:5,status:states[Math.min(calls.length-1,states.length-1)],error:null,...(sql.includes('a.result')?{result:{text:'完整答案'}}:{})}]};
 }} as unknown as Pool;
 return{pool,calls};
}
test('轻量等待不查询结果正文，默认完整读取保持兼容',async()=>{
 const f=fixture(['succeeded']),signal=new AbortController().signal;
 const brief=await waitForAttempt(f.pool,'attempt',0,signal,'status');
 expect(brief).toMatchObject({id:'attempt',workflow_id:'workflow',ordinal:5,status:'succeeded',completed:true});
 expect(f.calls[0]).not.toContain('a.result');expect(brief).not.toHaveProperty('result');
 expect(await waitForAttempt(f.pool,'attempt',0,signal)).toHaveProperty('result.text','完整答案');
});
test('持续运行任务一秒后再查；剩余预算较短时只睡剩余时间',async()=>{
 const original=setTimeout,delays:number[]=[];
 const timer=spyOn(globalThis,'setTimeout').mockImplementation(((callback:any,ms:number,...args:any[])=>{delays.push(ms);return original(callback,0,...args);}) as typeof setTimeout);
 try{
  const f=fixture(['running','succeeded']);
  await waitForAttempt(f.pool,'attempt',10000,new AbortController().signal,'status');
  expect(delays).toEqual([1000]);expect(f.calls).toHaveLength(2);
  delays.length=0;
  const short=fixture(['running','succeeded']);
  await waitForAttempt(short.pool,'attempt',50,new AbortController().signal,'status');
  expect(delays).toHaveLength(1);expect(delays[0]).toBeGreaterThan(0);expect(delays[0]).toBeLessThanOrEqual(50);
 }finally{timer.mockRestore();}
});
test('等待预算结束仍返回运行状态，不写入或取消任务',async()=>{
 const f=fixture(['running']);
 const result=await waitForAttempt(f.pool,'attempt',20,new AbortController().signal,'status');
 expect(result).toMatchObject({status:'running',completed:false});
 expect(f.calls.every(sql=>sql.startsWith('SELECT'))).toBe(true);
});
test('睡眠中取消立即唤醒，不再查询或改写任务',async()=>{
 const f=fixture(['running']),controller=new AbortController();
 const waiting=waitForAttempt(f.pool,'attempt',10000,controller.signal,'status');
 queueMicrotask(()=>controller.abort());
 await expect(waiting).rejects.toMatchObject({status:408});
 expect(f.calls).toHaveLength(1);
});


test('轻量状态返回数据库最后心跳，但不把陈旧心跳结算为失败或重派',async()=>{
 const heartbeat='2026-10-23T14:44:30.000Z';let sql='';
 const pool={query:async(text:string)=>{sql=text;return{rows:[{id:'remote-attempt',status:'running',heartbeat_at:heartbeat}]};}} as unknown as Pool;
 const result=await waitForAttempt(pool,'remote-attempt',0,new AbortController().signal,'status');
 expect(sql).toContain('a.heartbeat_at');expect(sql).not.toContain('a.result');expect(result).toMatchObject({status:'running',completed:false,heartbeat_at:heartbeat});expect(sql.startsWith('SELECT')).toBe(true);
});

// 只模拟事务与HTTP；行锁实际互斥仍须隔离PostgreSQL检查，不声称实体双机验收。
function cancellationFixture(options:{status?:string;heartbeat?:string|null;hasResult?:boolean;ordinal?:number;owner?:string;latest?:string;step?:string;accepted?:boolean;missing?:boolean;updated?:number;artifacts?:boolean;otherActive?:boolean}={}){
 const calls:string[]=[];let released=false;
 const id='11111111-1111-4111-8111-111111111111',workflow='22222222-2222-4222-8222-222222222222',executor='33333333-3333-4333-8333-333333333333';
 const db={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.startsWith('SELECT w.id'))return{rows:options.missing?[]:[{id:workflow}]};
  if(sql.startsWith('SELECT a.id'))return{rows:[{id,ordinal:options.ordinal??6,status:options.status??'waiting',heartbeat_at:options.heartbeat??null,no_result:!options.hasResult,executor_id:options.owner??executor}]};
  if(sql.startsWith('SELECT id'))return{rows:[{id:options.latest??id}]};
  if(sql.startsWith('SELECT ordinal'))return{rows:[{ordinal:options.ordinal??6,status:options.step??'waiting'},{ordinal:7,status:options.accepted?'succeeded':'waiting',decision:options.accepted?'accepted':null}]};
  if(sql.startsWith('SELECT 1 FROM ai_distill.artifacts'))return{rows:[],rowCount:options.artifacts?1:0};
  if(sql.startsWith('SELECT 1 FROM ai_distill.step_attempts'))return{rows:[],rowCount:options.otherActive?1:0};
  if(sql.startsWith('UPDATE'))return{rowCount:options.updated??1,rows:[{id}]};
  return{rows:[]};
 },release:()=>{released=true;}};
 return{pool:{connect:async()=>db} as unknown as Pool,calls,id,workflow,executor,released:()=>released};
}
test('未领取评分可显式取消：锁工作流及原尝试，只标skipped，不改结果/归属/答案或自动重派',async()=>{
 const f=cancellationFixture();expect(await cancelWaitingScore(f.pool,f.id,f.workflow,f.executor)).toMatchObject({status:'skipped',cancelled_before_start:true});
 expect(f.calls[0]).toBe('BEGIN');expect(f.calls).toContain("SET LOCAL lock_timeout='2s'");expect(f.calls.find(sql=>sql.startsWith('SELECT w.id'))).toContain('FOR UPDATE OF w');expect(f.calls.find(sql=>sql.startsWith('SELECT a.id'))).toContain('FOR UPDATE OF a');expect(f.calls.at(-1)).toBe('COMMIT');expect(f.released()).toBe(true);
 const writes=f.calls.filter(sql=>sql.startsWith('UPDATE'));expect(writes).toHaveLength(1);expect(writes[0]).toContain("status='waiting' AND heartbeat_at IS NULL AND result IS NULL");expect(writes[0]).not.toContain('SET result');expect(writes[0]).not.toContain('execution_dispatches');
});
test('用户确认原机停止：匹配陈旧心跳可显式结束未知旧调用，只保留unknown并让当前步骤待派发',async()=>{
 const heartbeat=new Date(Date.now()-3600000).toISOString(),f=cancellationFixture({status:'running',ordinal:5,step:'running',heartbeat});
 const result=await cancelStoppedExecutorAttempt(f.pool,f.id,f.workflow,f.executor,heartbeat);
 expect(result).toMatchObject({ordinal:5,status:'skipped',prior_outcome:'unknown',executor_stopped_confirmed:true});expect(result).not.toHaveProperty('cancelled_before_start');expect(f.calls.at(-1)).toBe('COMMIT');
 const writes=f.calls.filter(sql=>sql.startsWith('UPDATE'));expect(writes).toHaveLength(2);expect(writes[0]).toContain("date_trunc('milliseconds',heartbeat_at)");expect(writes.every(sql=>!sql.includes('SET result')&&!sql.includes('execution_dispatches'))).toBe(true);
});
for(const [name,options] of Object.entries({fresh_heartbeat:{heartbeat:new Date().toISOString()},changed_heartbeat:{heartbeat:new Date(Date.now()-3600000).toISOString()},artifact:{artifacts:true},other_active:{otherActive:true},result:{hasResult:true},accepted:{accepted:true}})){
 test(`已停原机显式取消仍拒绝${name}`,async()=>{
  const heartbeat=new Date(Date.now()-7200000).toISOString(),f=cancellationFixture({status:'running',step:'running',heartbeat,...options});
  const expected=name==='fresh_heartbeat'?options.heartbeat!:heartbeat;
  await expect(cancelStoppedExecutorAttempt(f.pool,f.id,f.workflow,f.executor,expected)).rejects.toMatchObject({status:409});expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.calls.some(sql=>sql.startsWith('UPDATE'))).toBe(false);
 });
}
test('已停原机取消HTTP必须同时明确停止与未知结果，缺任一确认均不访问数据库',async()=>{
 const f=cancellationFixture(),app=new Hono();registerWorkflowExecutionRoutes(app,{pool:f.pool,dispatch:async()=>({id:f.id})});
 const body={workflow_id:f.workflow,executor_id:f.executor,expected_heartbeat_at:null,executor_stopped:true,acknowledge_unknown_result:true};
 for(const changed of [{executor_stopped:false},{acknowledge_unknown_result:false},{expected_heartbeat_at:'bad'},{extra:true}])expect((await app.request(`/api/attempts/${f.id}/cancel-stopped-executor`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...changed})})).status).toBe(400);
 expect(f.calls).toHaveLength(0);
});
for(const [name,options] of Object.entries({running:{status:'running'},terminal:{status:'succeeded'},previously_started:{heartbeat:'2026-10-23T14:50:00Z'},has_result:{hasResult:true},answer:{ordinal:5},owner_changed:{owner:'other'},old_attempt:{latest:'new'},step_changed:{step:'running'},accepted:{accepted:true}})){
 test(`未领取评分取消拒绝${name}且回滚`,async()=>{
  const f=cancellationFixture(options);await expect(cancelWaitingScore(f.pool,f.id,f.workflow,f.executor)).rejects.toMatchObject({status:409});expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.calls.some(sql=>sql.startsWith('UPDATE'))).toBe(false);expect(f.released()).toBe(true);
 });
}
test('取消更新未命中时回滚，不把并发领取或删除冒记成功',async()=>{
 const f=cancellationFixture({updated:0});await expect(cancelWaitingScore(f.pool,f.id,f.workflow,f.executor)).rejects.toMatchObject({status:409});expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.released()).toBe(true);
});
test('取消入口严格校验身份，成功只取消原任务，不调用派发器',async()=>{
 const f=cancellationFixture();const app=new Hono();let dispatched=0;
 registerWorkflowExecutionRoutes(app,{pool:f.pool,dispatch:async()=>{dispatched++;return{id:f.id};}});
 for(const body of [{},{workflow_id:f.workflow,executor_id:f.executor,extra:true},{workflow_id:f.workflow,executor_id:'wrong'}]){
  expect((await app.request(`/api/attempts/${f.id}/cancel-waiting-score`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(400);
 }
 expect(f.calls).toHaveLength(0);
 const response=await app.request(`/api/attempts/${f.id}/cancel-waiting-score`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_id:f.workflow,executor_id:f.executor})});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({id:f.id,status:'skipped'});expect(dispatched).toBe(0);
});
