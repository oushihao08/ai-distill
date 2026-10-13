/** 验证普通外部调用的单次执行、关联 ID 传递及错误原样传播。 */
import {expect,test} from 'bun:test';
import{configureLogger,logEvent,withLogContext}from'./logging';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';

const modulePromise=import('./external-call').catch(()=>undefined);

test('runs a normal external call once and supplies a call id',async()=>{
 const module=await modulePromise;
 expect(typeof module?.runExternalCall).toBe('function');
 let calls=0;
 const result=await module!.runExternalCall({attempt_id:'attempt-1',operation:'answer'},async(callId:string)=>{
  calls++;
  expect(callId).toMatch(/^[0-9a-f-]{36}$/);
  return {usage:{input_tokens:3}};
 });
 expect(calls).toBe(1);
 expect(result).toEqual({usage:{input_tokens:3}});
});

test('propagates the original external-call error',async()=>{
 const module=await modulePromise;
 expect(typeof module?.runExternalCall).toBe('function');
 const failure=new Error('provider failed');
 await expect(module!.runExternalCall({attempt_id:'attempt-2',operation:'score'},async()=>{throw failure;})).rejects.toBe(failure);
});

test('keeps concurrent call logging contexts separate',async()=>{
 const root=await mkdtemp(join(tmpdir(),'external-call-context-'));
 const logger=configureLogger({root,service:'worker'});
 try{
  const module=await modulePromise;
  expect(typeof module?.runExternalCall).toBe('function');
  await Promise.all([
   module!.runExternalCall({attempt_id:'attempt-a',operation:'answer'},async()=>{await new Promise(resolve=>setTimeout(resolve,5));throw new Error('answer failed');}),
   module!.runExternalCall({attempt_id:'attempt-b',operation:'score'},async()=>{await new Promise(resolve=>setTimeout(resolve,1));throw new Error('score failed');}),
  ].map(promise=>promise.catch(()=>undefined)));
  await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory);
  const records=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).flatMap(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  const failures=records.filter(record=>record.event==='call.failed');
  expect(failures).toHaveLength(2);
  expect(failures.map(record=>[record.attempt_id,record.operation]).sort()).toEqual([['attempt-a','answer'],['attempt-b','score']]);
  expect(new Set(failures.map(record=>record.call_id)).size).toBe(2);
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('restores the parent logging context after an external call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'external-call-parent-context-'));
 const logger=configureLogger({root,service:'worker'});
 try{
  const module=await modulePromise;
  await withLogContext({attempt_id:'parent-attempt',operation:'parent-operation'},async()=>{
   await module!.runExternalCall({attempt_id:'child-attempt',operation:'child-operation'},async()=>({}));
   logEvent('diagnostic.after_external_call',{level:'error'});
  });
  await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory);
  const records=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).flatMap(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  expect(records.find(record=>record.event==='diagnostic.after_external_call')).toMatchObject({attempt_id:'parent-attempt',operation:'parent-operation'});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('restores the outer call context after a nested external call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'external-call-nested-context-'));
 const logger=configureLogger({root,service:'worker'});
 try{
  const module=await modulePromise;
  await module!.runExternalCall({attempt_id:'outer-attempt',operation:'outer-operation'},async outerCallId=>{
   await module!.runExternalCall({attempt_id:'inner-attempt',operation:'inner-operation'},async()=>({}));
   logEvent('diagnostic.after_nested_call',{level:'error'});
   return{usage:{input_tokens:1},call_id:outerCallId};
  });
  await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory);
  const records=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).flatMap(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  expect(records.find(record=>record.event==='diagnostic.after_nested_call')).toMatchObject({attempt_id:'outer-attempt',operation:'outer-operation'});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});
