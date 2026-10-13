/** 验证所有稳定 ordinal 都只派发到对应的业务入口，未知序号不会退化为归档。 */
import {expect,test} from 'bun:test';

const modulePromise=import('./step-dispatch').catch(()=>undefined);

test('dispatches each workflow ordinal to its matching handler',async()=>{
 const module=await modulePromise;
 expect(typeof module?.dispatchWorkflowStep).toBe('function');
 const called:number[]=[];
 const handlers={
  1:async()=>{called.push(1);return 'intake';},
  2:async()=>{called.push(2);return 'extract';},
  4:async()=>{called.push(4);return 'author';},
  5:async()=>{called.push(5);return 'answer';},
  6:async()=>{called.push(6);return 'score';},
  7:async()=>{called.push(7);return 'accept';},
  8:async()=>{called.push(8);return 'publish';},
  9:async()=>{called.push(9);return 'redact';},
 };
 for(const [ordinal,expected] of [[1,'intake'],[2,'extract'],[4,'author'],[5,'answer'],[6,'score'],[7,'accept'],[8,'publish'],[9,'redact']] as const){
  expect(await module!.dispatchWorkflowStep(ordinal,handlers)).toBe(expected);
 }
 expect(called).toEqual([1,2,4,5,6,7,8,9]);
});

test('rejects an unsupported ordinal without calling a handler',async()=>{
 const module=await modulePromise;
 expect(typeof module?.dispatchWorkflowStep).toBe('function');
 const called:number[]=[];
 const handlers={1:async()=>{called.push(1);return 'intake';},2:async()=>{called.push(2);return 'extract';},4:async()=>{called.push(4);return 'author';},5:async()=>{called.push(5);return 'answer';},6:async()=>{called.push(6);return 'score';},7:async()=>{called.push(7);return 'accept';},8:async()=>{called.push(8);return 'publish';},9:async()=>{called.push(9);return 'redact';}};
 await expect(module!.dispatchWorkflowStep(3 as never,handlers)).rejects.toThrow();
 expect(called).toEqual([]);
});
