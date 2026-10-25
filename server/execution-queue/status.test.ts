/** 本机/他机步骤状态投影；临时SQLite和合成归属，不修改云端业务或调用模型。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalQueue} from './store';
import {projectStepExecution,projectStepExecutions} from './status';
test('same cloud attempt is local on A and foreign on B without importing work',()=>{
 const root=mkdtempSync(join(tmpdir(),'queue-status-')),a=new LocalQueue(join(root,'A'),'a'),b=new LocalQueue(join(root,'B'),'b'),id=randomUUID();
 try{
  a.intent(id,'step','agent','authoring');a.confirm(id);const attempt={id,status:'running',executor_id:a.executorId,generation:0};
  expect(projectStepExecution(attempt,a)).toMatchObject({scope:'local',state:'queued',active:true,label:'本机排队中'});
  expect(projectStepExecution(attempt,b)).toMatchObject({source:'shared_attempt',scope:'other_executor',state:'running',active:false});expect(b.list()).toEqual([]);
  const job=a.claim('agent')!;a.finish(id,job.lease!,'needs_review');
  expect(projectStepExecution(attempt,a)).toMatchObject({state:'needs_review',active:false});expect(a.get(id)?.state).toBe('needs_review');
  expect(projectStepExecution({...attempt,generation:1},a)?.state).toBe('generation_mismatch');
  expect(projectStepExecution({...attempt,id:randomUUID()},a)?.state).toBe('missing');
  expect(projectStepExecution({...attempt,executor_id:null},b)?.scope).toBe('unowned');
 }finally{a.close();b.close();rmSync(root,{recursive:true,force:true});}
});
test('all model attempts are projected and reads do not convert pending commits or unknown calls to new work',()=>{
 const root=mkdtempSync(join(tmpdir(),'queue-status-many-')),q=new LocalQueue(root,'a');
 try{
  const attempts=Array.from({length:3},()=>{const id=randomUUID();q.intent(id,'step','api','score');q.confirm(id);return{id,status:'running',executor_id:q.executorId,generation:0};});
  const job=q.claim('api')!;q.finish(job.id,job.lease!,'result_pending_commit');
  const before=q.list();const projected=projectStepExecutions(attempts,q)!;
  expect(projected).toHaveLength(3);expect(projected.filter(task=>task.active)).toHaveLength(2);
  expect(projected.find(task=>task.attempt_id===job.id)?.label).toBe('结果已保存，待同步');
  expect(q.list()).toEqual(before);expect(JSON.stringify(projected)).not.toContain('lease');
  expect(projectStepExecutions([],q)).toEqual([]);expect(projectStepExecution(null,q)).toBeUndefined();
 }finally{q.close();rmSync(root,{recursive:true,force:true});}
});
