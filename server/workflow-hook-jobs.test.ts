/** 验证阶段钩子的空路径、持久检查点与失败重试；SQL 使用内存替身，不连接业务数据库。 */
import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
import {canonicalJson} from '../shared/workflow-config';
import {createHash} from 'node:crypto';
const modulePromise=import('./workflow-hook-jobs').catch(()=>undefined);
function journal(){
 const records=new Map<string,any>(),calls:string[]=[];
 const query=async(sql:string,values:any[]=[])=>{
  calls.push(sql);
  if(sql.startsWith('SELECT * FROM ai_distill.hook_runs')){const row=[...records.values()].find(r=>r.attempt_id===values[0]&&r.position===values[1]&&r.action_id===values[2]);return {rows:row?[structuredClone(row)]:[],rowCount:row?1:0};}
  if(sql.startsWith('INSERT INTO ai_distill.hook_runs')){
   const row={id:values[0],workflow_id:values[1],attempt_id:values[2],stage:values[3],position:values[4],action_id:values[5],mode:values[6],binding_digest:values[7],snapshot:JSON.parse(values[8]),idempotent:values[9],status:'waiting'};
   records.set(row.id,row);return {rows:[structuredClone(row)],rowCount:1};
  }
  if(sql.startsWith('UPDATE ai_distill.hook_runs')){
   const row=records.get(values[0]);if(!row)return {rows:[],rowCount:0};
   row.status=values[1];row.result=values[2]?JSON.parse(values[2]):null;row.result_digest=values[4];row.error=values[3]??null;return {rows:[structuredClone(row)],rowCount:1};
  }
  throw new Error('unexpected SQL');
 };
 return {pool:{query} as unknown as Pool,records,calls};
}
const action={id:'check',script:'hooks/check.ts',files:['hooks/check.ts'],mode:'sync' as const,params:{},timeout_ms:1000,idempotent:true};
const snapshot={project_root:'/fixture',action,files:[{path:'hooks/check.ts',sha256:'a'.repeat(64),size_bytes:1}]};
const hook={...snapshot,digest:createHash('sha256').update(canonicalJson(snapshot)).digest('hex')};
const base={attempt_id:'attempt',workflow_id:'workflow',stage:'answer' as const,binding_digest:'b'.repeat(64),input:{question:'题面',materials:[]}};
test('无钩子路径不依赖新表且主操作只执行一次',async()=>{
 const m=await modulePromise;expect(typeof m?.executeWithStageHooks).toBe('function');const f=journal();let calls=0;
 expect(await m!.executeWithStageHooks({...base,pool:f.pool,runMain:async()=>{calls++;return {text:'答案'};}})).toEqual({text:'答案'});
 expect(calls).toBe(1);expect(f.calls).toHaveLength(0);
});
test('后置钩子失败后复用持久主结果，不重复调用模型',async()=>{
 const m=(await modulePromise)!,f=journal();let main=0,checks=0;
 const options={...base,pool:f.pool,hooks:{before:[],after:[hook]},runMain:async()=>{main++;return {text:'原始答案'};},runScript:async()=>{checks++;if(checks===1)throw new Error('fixture');return {notes:['通过'],data:{}};}};
 expect(await m.executeWithStageHooks(options)).toEqual({text:'原始答案'});
 expect(checks).toBe(0);
 expect(await m.runCommittedStageHooks(options,{text:'原始答案'})).toEqual([{id:'check',status:'failed'}]);
 expect(main).toBe(1);expect([...f.records.values()].find(r=>r.position==='main')?.result).toEqual({text:'原始答案'});
 expect(await m.executeWithStageHooks(options)).toEqual({text:'原始答案'});expect(main).toBe(1);
 expect(await m.runCommittedStageHooks(options,{text:'原始答案'})).toEqual([{id:'check',status:'succeeded'}]);expect(checks).toBe(2);
});
test('冻结输入不同不能复用主检查点',async()=>{
 const m=(await modulePromise)!,f=journal();let main=0;
 const options={...base,pool:f.pool,hooks:{before:[],after:[hook]},runMain:async()=>{main++;return {text:'答案'};},runScript:async()=>({notes:[],data:{}})};
 await m.executeWithStageHooks(options);
 await expect(m.executeWithStageHooks({...options,binding_digest:'c'.repeat(64)})).rejects.toThrow('绑定');expect(main).toBe(1);
});
test('主检查点正文变化不能被当成原始模型输出复用',async()=>{
 const m=(await modulePromise)!,f=journal();let main=0;
 const options={...base,pool:f.pool,hooks:{before:[],after:[hook]},runMain:async()=>{main++;return {text:'原始答案'};},runScript:async()=>({notes:[],data:{}})};
 await m.executeWithStageHooks(options);
 [...f.records.values()].find(r=>r.position==='main').result.text='被改写';
 await expect(m.executeWithStageHooks(options)).rejects.toThrow('指纹');expect(main).toBe(1);
});
test('旧异步配置在提交后同步执行，不创建异步记录',async()=>{
 const m=(await modulePromise)!,f=journal();let scriptCalls=0;
 const asyncHook={...hook,action:{...hook.action,mode:'async' as const}};
 const options={...base,pool:f.pool,hooks:{before:[],after:[asyncHook]},runMain:async()=>({text:'答案'}),runScript:async()=>{scriptCalls++;return {notes:[],data:{}};}};
 await m.executeWithStageHooks(options);
 expect([...f.records.values()].filter(r=>r.position==='after')).toHaveLength(0);
 await m.runCommittedStageHooks(options,{text:'答案'});
 const row=[...f.records.values()].find(r=>r.position==='after');
 expect(row).toMatchObject({mode:'sync',status:'succeeded',snapshot:{payload:{output:{text:'答案'}}}});expect(scriptCalls).toBe(1);
});
test('前置附加输入保存检查点并按顺序显式传递，后置结果不覆盖主操作',async()=>{
 const m=(await modulePromise)!,f=journal();let received:unknown;
 const options={...base,stage:'authoring' as const,pool:f.pool,hooks:{before:[hook],after:[]},runMain:async(additions:unknown)=>{received=additions;return {text:'主结果'};},runScript:async()=>({notes:[],data:{},additions:[{purpose:'规则核对',text:'附加意见'}]})};
 expect(await m.executeWithStageHooks(options)).toEqual({text:'主结果'});
 expect(received).toEqual([{purpose:'规则核对',text:'附加意见'}]);
 expect([...f.records.values()].find(r=>r.position==='main')?.snapshot).toMatchObject({additions:received});
});
test('进程中断恢复同步记录，保留成功检查点，未知主调用不重跑',async()=>{
 const m=(await modulePromise)!;expect(typeof m.recoverInterruptedStageHooks).toBe('function');
 const rows=[{id:'before',mode:'sync',status:'succeeded',result:{notes:['原意见']}},{id:'main',mode:'checkpoint',status:'succeeded',result:{text:'原始主结果'}},{id:'after',mode:'sync',status:'running',idempotent:false}];
 const calls:{sql:string;values:any[]}[]=[];
 const db={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});if(sql.includes('to_regclass'))return {rows:[{available:true}],rowCount:1};if(sql.startsWith('SELECT id,mode,status'))return {rows:structuredClone(rows),rowCount:rows.length};return {rows:[],rowCount:1};}} as unknown as Pool;
 expect(await m.recoverInterruptedStageHooks(db,{id:'attempt',input:{hooks:{before:[hook],after:[hook]}}})).toBe(true);
 const recovery=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.hook_runs'));
 expect(recovery?.sql).toContain("status='needs_review'");expect(recovery?.sql).toContain("status='running'");expect(recovery?.sql).toContain('history');
 expect(calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts'))?.sql).toContain('project_hook_failed');
 const legacyCalls:string[]=[];const legacy={query:async(sql:string)=>{legacyCalls.push(sql);throw new Error('旧任务不应查新表');}} as unknown as Pool;
 expect(await m.recoverInterruptedStageHooks(legacy,{id:'old',input:{}})).toBe(false);expect(legacyCalls).toHaveLength(0);
});
