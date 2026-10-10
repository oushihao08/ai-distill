/** 后台任务取消传播：验证数据库取消会中止当前任务且并发 signal 相互隔离，轮询故障写安全日志，不泄漏原始数据库错误。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {watchTaskCancellation,withTaskSignal,currentTaskSignal} from './task-signal';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{configureLogger}from'./logging';
test('database cancellation aborts in-flight work; concurrent task signals stay isolated',async()=>{
 const watcher=watchTaskCancellation({query:async()=>({rows:[{status:'skipped'}]})} as any,'a',undefined,false,2);
 try{await new Promise(resolve=>watcher.signal.addEventListener('abort',resolve,{once:true}));expect(watcher.signal.aborted).toBe(true);}finally{watcher.dispose();}
 const a=new AbortController(),b=new AbortController();
 expect(await Promise.all([withTaskSignal(a.signal,async()=>{await Bun.sleep(2);return currentTaskSignal()===a.signal;}),withTaskSignal(b.signal,async()=>currentTaskSignal()===b.signal)])).toEqual([true,true]);
 expect(currentTaskSignal()).toBeUndefined();
});

test('database cancellation polling failures are written to structured logs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-cancellation-logs-'));
 const logger=configureLogger({root,service:'worker'});
 let queries=0;
 const watcher=watchTaskCancellation({query:async()=>{if(++queries===1)throw new Error('private database detail');return{rows:[{status:'running'}]};}}as any,'attempt-a',undefined,false,2);
 try{
  await Bun.sleep(12);watcher.dispose();await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory).catch(()=>[]);
  const records=files.length?(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line)):[];
  expect(records).toContainEqual(expect.objectContaining({event:'task.cancellation.poll_failed',component:'task_cancellation',attempt_id:'attempt-a',level:'warn',error_kind:'unknown'}));
  expect(records).toContainEqual(expect.objectContaining({event:'task.cancellation.poll_recovered',component:'task_cancellation',attempt_id:'attempt-a',level:'info'}));
  expect(records.filter(record=>record.event==='task.cancellation.poll_failed')).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain('private database detail');
 }finally{watcher.dispose();await logger.close();await rm(root,{recursive:true,force:true});}
});
