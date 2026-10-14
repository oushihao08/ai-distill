/** 验证异步钩子的执行主机、领取、独立结果、取消及中断恢复；使用 SQL 替身，不访问业务数据库。 */
import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
const modulePromise=import('./workflow-hook-worker').catch(()=>undefined);
function fixture(options:{active?:boolean;idempotent?:boolean;stale?:boolean}={}){
 const calls:{sql:string;values:any[]}[]=[],row:any={id:'hook',attempt_id:'attempt',workflow_id:'workflow',stage:'answer',position:'after',mode:'async',status:options.stale?'running':'waiting',idempotent:options.idempotent??false,snapshot:{hook:{action:{idempotent:options.idempotent??false}},payload:{input:{question:'题面'},output:{text:'答案'}}}};
 let claimed=false;
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.includes("to_regclass('ai_distill.hook_runs')"))return {rows:[{available:true}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.hook_runs h SET status=CASE')){if(options.stale)row.status=options.idempotent?'waiting':'needs_review';return {rows:[],rowCount:options.stale?1:0};}
  if(sql.startsWith("UPDATE ai_distill.hook_runs h SET status='cancelled'")){if(options.active===false)row.status='cancelled';return {rows:[],rowCount:options.active===false?1:0};}
  if(sql.startsWith('SELECT h.*'))return {rows:!claimed&&row.status==='waiting'?[structuredClone(row)]:[],rowCount:!claimed&&row.status==='waiting'?1:0};
  if(sql.startsWith("UPDATE ai_distill.hook_runs SET status='running'")){claimed=true;row.status='running';return {rows:[{id:row.id}],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.hook_runs h SET status=$2')){row.status=values[1];row.result=values[2]?JSON.parse(values[2]):null;return {rows:[{id:row.id}],rowCount:1};}
  return {rows:[],rowCount:0};
 };
 return {pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,calls,row};
}
test('API worker 不查询或执行本地脚本',async()=>{
 const m=await modulePromise;expect(typeof m?.runNextHook).toBe('function');const f=fixture();let ran=false;
 expect(await m!.runNextHook(f.pool,undefined,'api',async()=>{ran=true;return {notes:[],data:{}};})).toBe(false);
 expect(f.calls).toHaveLength(0);expect(ran).toBe(false);
});
test('旧数据库尚无钩子表时不查询新表',async()=>{
 const m=(await modulePromise)!,calls:string[]=[];
 const pool={query:async(sql:string)=>{calls.push(sql);return {rows:[{available:false}],rowCount:1};}} as unknown as Pool;
 expect(await m.runNextHook(pool,undefined,'local')).toBe(false);
 expect(calls).toHaveLength(1);expect(calls[0]).toContain('to_regclass');
});
test('异步结果只更新钩子记录，不修改主阶段结果',async()=>{
 const m=(await modulePromise)!,f=fixture();let calls=0;
 expect(await m.runNextHook(f.pool,undefined,'local',async()=>{calls++;return {notes:['完成'],data:{extra:1}};})).toBe(true);
 expect(calls).toBe(1);expect(f.row).toMatchObject({status:'succeeded',result:{notes:['完成'],data:{extra:1}}});
 expect(f.calls.some(call=>/UPDATE ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
 expect(f.calls.find(call=>call.sql.startsWith('SELECT h.*'))?.sql).toContain('SKIP LOCKED');
});
test('失效主任务取消附加任务；未知副作用不自动重试',async()=>{
 const m=(await modulePromise)!;let called=0;
 const invalid=fixture({active:false});await m.runNextHook(invalid.pool,undefined,'all',async()=>{called++;return {notes:[],data:{}};});
 expect(invalid.row.status).toBe('cancelled');expect(called).toBe(0);
 const stale=fixture({stale:true,idempotent:false});await m.runNextHook(stale.pool,undefined,'all',async()=>{called++;return {notes:[],data:{}};});
 expect(stale.row.status).toBe('needs_review');expect(called).toBe(0);
 const safe=fixture({stale:true,idempotent:true});await m.runNextHook(safe.pool,undefined,'all',async()=>{called++;return {notes:[],data:{}};});
 expect(safe.row.status).toBe('succeeded');expect(called).toBe(1);
});
test('服务停止保留异步任务：幂等动作等待恢复，非幂等动作待核',async()=>{
 const m=(await modulePromise)!;
 for(const idempotent of [true,false]){
  const f=fixture({idempotent}),controller=new AbortController();
  await m.runNextHook(f.pool,controller.signal,'local',async()=>{controller.abort();throw new Error('shutdown');});
  expect(f.row.status).toBe(idempotent?'waiting':'needs_review');
  expect(f.calls.some(call=>/UPDATE ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
 }
});
