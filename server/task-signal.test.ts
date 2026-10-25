/** 验证取消轮询到 AbortSignal 的传递、并发隔离和安全故障日志；查询使用注入 Pool，日志只写临时目录，不访问真实数据库。 */
import {test,expect} from 'bun:test';
import {watchTaskCancellation,withTaskSignal,currentTaskSignal} from './task-signal';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{configureLogger,withLogContext}from'./logging';

function poolWithQuery(query:(sql:string,values:any[])=>Promise<any>){
 return{connect:async()=>({query:(input:string|{text:string;values?:any[]},values?:any[])=>query(typeof input==='string'?input:input.text,(typeof input==='string'?values:input.values)??[]),release(){}})} as any;
}

test('database cancellation aborts in-flight work; concurrent task signals stay isolated',async()=>{
 const queries:string[]=[],pool=poolWithQuery(async sql=>{queries.push(sql);return sql.startsWith('SELECT id,status')?{rows:[{id:'a',status:'skipped'}]}:{rows:[]};});
 const watcher=watchTaskCancellation(pool,'a',undefined,false,2);
 try{await new Promise(resolve=>watcher.signal.addEventListener('abort',resolve,{once:true}));expect(watcher.signal.aborted).toBe(true);expect(queries.indexOf("SET LOCAL statement_timeout = '2000ms'")).toBeLessThan(queries.findIndex(sql=>sql.startsWith('SELECT id,status')));}finally{watcher.dispose();}
 const a=new AbortController(),b=new AbortController();
 expect(await Promise.all([withTaskSignal(a.signal,async()=>{await Bun.sleep(2);return currentTaskSignal()===a.signal;}),withTaskSignal(b.signal,async()=>currentTaskSignal()===b.signal)])).toEqual([true,true]);
 expect(currentTaskSignal()).toBeUndefined();
});

test('database cancellation polling failures are written to structured logs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-cancellation-logs-'));
 const logger=configureLogger({root,service:'worker'});
 let queries=0;
 const pool=poolWithQuery(async(sql,values)=>{if(sql.startsWith('SELECT id,status')){if(++queries===1)throw new Error('private database detail');return{rows:[{id:values[0][0],status:'running'}]};}return{rows:[]};});
 const watcher=withLogContext({attempt_id:'unrelated-attempt'},()=>watchTaskCancellation(pool,'attempt-a',undefined,false,2));
 try{
  await Bun.sleep(12);watcher.dispose();await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory).catch(()=>[]);
  const records=files.length?(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line)):[];
  expect(records).toContainEqual(expect.objectContaining({event:'task.cancellation.poll_failed',component:'task_cancellation',operation:'poll-step-attempts',level:'error',error_kind:'unknown'}));
  expect(records).not.toContainEqual(expect.objectContaining({event:'task.cancellation.poll_recovered',component:'task_cancellation',operation:'poll-step-attempts',level:'info'}));
  expect(records.filter(record=>record.event==='task.cancellation.poll_failed')).toHaveLength(1);expect(queries).toBeGreaterThan(1);expect(watcher.signal.aborted).toBe(false);
  expect(JSON.stringify(records)).not.toContain('private database detail');
 }finally{watcher.dispose();await logger.close();await rm(root,{recursive:true,force:true});}
});

test('a step cancellation query failure does not prevent project skill cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-cancellation-isolation-'));
 const logger=configureLogger({root,service:'worker'});
 const pool=poolWithQuery(async(sql,values)=>{
  if(sql.includes('step_attempts'))throw new Error('step query failure');
  if(sql.includes('project_skill_attempts'))return{rows:[{id:values[0][0],status:'skipped'}]};
  return{rows:[]};
 });
 const step=withLogContext({attempt_id:'step-a'},()=>watchTaskCancellation(pool,'step-a',undefined,false,2));
 const skill=withLogContext({skill_attempt_id:'skill-b'},()=>watchTaskCancellation(pool,'skill-b',undefined,true,2));
 try{
  await new Promise(resolve=>skill.signal.addEventListener('abort',resolve,{once:true}));
  expect(step.signal.aborted).toBe(false);expect(skill.signal.aborted).toBe(true);
  await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory);
  const records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const failure=records.find(record=>record.event==='task.cancellation.poll_failed');
  expect(failure).toMatchObject({operation:'poll-step-attempts',component:'task_cancellation'});
  expect(failure).not.toHaveProperty('attempt_id');expect(failure).not.toHaveProperty('skill_attempt_id');
  expect(JSON.stringify(records)).not.toContain('step query failure');
 }finally{step.dispose();skill.dispose();await logger.close();await rm(root,{recursive:true,force:true});}
});

test('many watchers share one slow read, never overlap and release the in-flight client after disposal',async()=>{
 let selects=0,acquired=0,released=0,active=0,maxActive=0,finishRead!:()=>void,readStarted!:()=>void;
 const started=new Promise<void>(resolve=>{readStarted=resolve;});
 const pool={connect:async()=>{acquired++;active++;maxActive=Math.max(maxActive,active);return{
  query:async(input:{text:string;values?:string[][]})=>{
   if(input.text.startsWith('SELECT')){selects++;expect(input.values?.[0]).toHaveLength(100);readStarted();await new Promise<void>(resolve=>{finishRead=resolve;});return{rows:input.values![0]!.map(id=>({id,status:'running'}))};}
   return{rows:[]};
  },release(){released++;active--;},
 };}} as any;
 const upstream=new AbortController(),watchers=Array.from({length:100},(_,i)=>watchTaskCancellation(pool,`synthetic-${i}`,upstream.signal,false,2));
 try{
  await started;await Bun.sleep(15);expect(selects).toBe(1);expect(acquired).toBe(1);expect(maxActive).toBe(1);
  for(const watcher of watchers)watcher.dispose();finishRead();await Bun.sleep(15);
  expect(selects).toBe(1);expect(released).toBe(1);expect(active).toBe(0);
  upstream.abort();expect(watchers.every(watcher=>!watcher.signal.aborted)).toBe(true);
 }finally{for(const watcher of watchers)watcher.dispose();finishRead?.();}
});

test('repeated task batches do not retain polling work or clients after completion',async()=>{
 let selects=0,clients=0,maxClients=0;let observed!:()=>void;
 const pool={connect:async()=>{clients++;maxClients=Math.max(maxClients,clients);return{query:async(input:{text:string;values?:string[][]})=>{
  if(input.text.startsWith('SELECT')){selects++;observed();return{rows:input.values![0]!.map(id=>({id,status:'running'}))};}return{rows:[]};
 },release(){clients--;}};}} as any;
 for(let batch=0;batch<40;batch++){
  const read=new Promise<void>(resolve=>{observed=resolve;});
  const watchers=Array.from({length:25},(_,i)=>watchTaskCancellation(pool,`batch-${batch}-${i}`,undefined,false,1));
  try{await read;}finally{for(const watcher of watchers)watcher.dispose();}
  // Let COMMIT/release and scheduler completion run before the next lifecycle.
  await Bun.sleep(1);expect(clients).toBe(0);
 }
 const completedReads=selects;await Bun.sleep(10);expect(selects).toBe(completedReads);expect(maxClients).toBe(1);expect(selects).toBe(40);
});
