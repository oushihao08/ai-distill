/** 后台任务取消传播：验证数据库取消会中止当前任务且并发 signal 相互隔离，轮询故障写安全日志，不泄漏原始数据库错误。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {watchTaskCancellation,withTaskSignal,currentTaskSignal} from './task-signal';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{configureLogger,withLogContext}from'./logging';

function poolWithQuery(query:(sql:string,values:any[])=>Promise<any>){
 return{connect:async()=>({query,release(){}})} as any;
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
  expect(records).toContainEqual(expect.objectContaining({event:'task.cancellation.poll_failed',component:'task_cancellation',operation:'poll-step-attempts',level:'warn',error_kind:'unknown'}));
  expect(records).toContainEqual(expect.objectContaining({event:'task.cancellation.poll_recovered',component:'task_cancellation',operation:'poll-step-attempts',level:'info'}));
  expect(records.filter(record=>record.event==='task.cancellation.poll_failed')).toHaveLength(1);
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
