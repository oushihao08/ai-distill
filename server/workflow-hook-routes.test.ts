/** 验证失败钩子续跑的状态、检查点和副作用确认边界；仅使用本地 Hono 与 SQL 替身。 */
import {expect,test,beforeAll,afterAll} from 'bun:test';
const previousQueueMode=process.env.EXECUTION_QUEUE_MODE;
beforeAll(()=>{process.env.EXECUTION_QUEUE_MODE='legacy';});
afterAll(()=>{if(previousQueueMode===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previousQueueMode;});
import type {Pool} from 'pg';
import {Hono} from 'hono';
const modulePromise=import('./workflow-hook-routes').catch(()=>undefined);
const id='11111111-1111-4111-8111-111111111111';
function fixture(options:{status?:string;marker?:string;hooks?:any[];unknownMain?:boolean;active?:boolean;missingCheckpoint?:boolean}={}){
 const calls:{sql:string;values:any[]}[]=[],row={id,workflow_id:'22222222-2222-4222-8222-222222222222',project_id:'project',ordinal:5,status:options.status??'failed',result:{error_code:options.marker??'project_hook_failed'}};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.includes('to_regclass'))return {rows:[{available:true}],rowCount:1};
  if(sql.startsWith('SELECT a.*,w.project_id'))return {rows:[row],rowCount:1};
  if(sql.startsWith('SELECT h.*'))return {rows:options.hooks??[{position:'after',status:'failed',idempotent:true}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.hook_runs')&&sql.includes("status='succeeded'"))return {rows:options.missingCheckpoint?[]:[{id:'checkpoint'}],rowCount:options.missingCheckpoint?0:1};
  if(sql.startsWith('SELECT id FROM ai_distill.hook_runs'))return {rows:options.unknownMain?[{id:'uncertain'}]:[],rowCount:options.unknownMain?1:0};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return {rows:options.active?[{id:'other'}]:[],rowCount:options.active?1:0};
  return {rows:[],rowCount:1};
 };
 return {pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,calls,row};
}
test('续跑只恢复已失败钩子的原尝试，不创建新的主模型任务',async()=>{
 const m=await modulePromise;expect(typeof m?.resumeHookAttempt).toBe('function');const f=fixture();
 expect(await m!.resumeHookAttempt(f.pool,id,false)).toEqual({id,reused:false});
 expect(f.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
 expect(f.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.hook_runs'))?.sql).toContain('history');
 expect(f.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts'))?.values[0]).toBe(id);
 expect(f.calls.at(-1)?.sql).toBe('COMMIT');
});
test('缺少有效失败标记、当前输入不匹配或主结果未知时拒绝续跑',async()=>{
 const m=(await modulePromise)!;
 for(const options of [{marker:'other'},{hooks:[]},{unknownMain:true},{active:true},{missingCheckpoint:true}]){
  const f=fixture(options);await expect(m.resumeHookAttempt(f.pool,id,false)).rejects.toThrow();
  expect(f.calls.some(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts'))).toBe(false);
 }
});
test('未知副作用必须明确确认，已有续跑任务重复请求复用',async()=>{
 const m=(await modulePromise)!;
 const f=fixture({hooks:[{position:'after',status:'needs_review',idempotent:false}]});
 await expect(m.resumeHookAttempt(f.pool,id,false)).rejects.toThrow('副作用');
 expect(await m.resumeHookAttempt(f.pool,id,true)).toMatchObject({id,reused:false});
 expect(await m.resumeHookAttempt(fixture({status:'waiting'}).pool,id,false)).toMatchObject({id,reused:true});
});
test('HTTP续跑校验参数并返回202，不以请求完成冒充模型已完成',async()=>{
 const m=(await modulePromise)!,f=fixture(),app=new Hono();m.registerWorkflowHookRoutes(app,f.pool);
 const invalid=await app.request(`/api/attempts/${id}/resume-hooks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acknowledge_side_effects:'yes'})});expect(invalid.status).toBe(400);
 const response=await app.request(`/api/attempts/${id}/resume-hooks`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(response.status).toBe(202);expect(await response.json()).toMatchObject({id,reused:false});
});
test('增强重试同步等待，不重派或改写主阶段',async()=>{
 const m=(await modulePromise)!,f=fixture({hooks:[{id,status:'failed',idempotent:true,snapshot:{hook:{},payload:{}}}]});
 expect(await m.retryAsyncHook(f.pool,id,false,async()=>({notes:[],data:{}}))).toEqual({id,reused:false,status:'succeeded'});
 expect(f.calls.some(c=>/UPDATE ai_distill\.(steps|step_attempts)/.test(c.sql))).toBe(false);
 const unknown=fixture({hooks:[{id,status:'needs_review',idempotent:false,snapshot:{hook:{},payload:{}}}]});
 await expect(m.retryAsyncHook(unknown.pool,id,false)).rejects.toThrow('副作用');
 expect(await m.retryAsyncHook(unknown.pool,id,true,async()=>({notes:[],data:{}}))).toMatchObject({id,reused:false});
});
test('流程配置局部保存仅合并workflow，不覆盖模型、提示词和作答策略',async()=>{
 const m=(await modulePromise)!,f=fixture(),app=new Hono();m.registerWorkflowHookRoutes(app,f.pool);
 const response=await app.request(`/api/projects/${id}/steps/5/workflow`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow:{hooks:{}}})});
 expect(response.status).toBe(200);
 const saved=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.project_step_configs'));
 expect(saved?.sql).toContain("current_config.config-'workflow'");
 expect(saved?.values[2]).toBe(JSON.stringify({workflow:{contract:'legacy',rules_text:'',reference_answer:'none',hooks:{before:[],after:[]}}}));
 const invalid=await app.request(`/api/projects/${id}/steps/5/workflow`,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"model":"other"}'});expect(invalid.status).toBe(400);
 const removed=await app.request(`/api/projects/${id}/steps/4/workflow`,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"workflow":null}'});expect(removed.status).toBe(200);expect(f.calls.at(-1)?.values[2]).toBe('{}');
});
test('成功主检查点后尚未登记后置钩子也能续跑，已成功钩子不需再次确认',async()=>{
 const m=(await modulePromise)!;
 const f=fixture({hooks:[{position:'main',mode:'checkpoint',status:'succeeded',idempotent:false}]});
 expect(await m.resumeHookAttempt(f.pool,id,false)).toEqual({id,reused:false});
});

test('补执行请求等待脚本完成，不登记后台任务',async()=>{
 const m=(await modulePromise)!,f=fixture({hooks:[{id,status:'waiting',idempotent:true,snapshot:{hook:{},payload:{}}}]});
 let release!:()=>void,started!:()=>void,finished=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
 const request=m.retryAsyncHook(f.pool,id,false,async()=>{started();await gate;return {notes:[],data:{}};}).then(result=>{finished=true;return result;});
 await entered;expect(finished).toBe(false);
 expect(f.calls.some(c=>c.sql.includes('execution_dispatches'))).toBe(false);
 release();expect(await request).toMatchObject({status:'succeeded'});
 expect(f.calls.some(c=>/UPDATE ai_distill\.(steps|step_attempts)/.test(c.sql))).toBe(false);
});
