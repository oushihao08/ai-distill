import {test,expect} from 'bun:test';
import {planWorkflow,planBatch} from './planner';
const steps=[{ordinal:1,display_position:1,enabled:true,status:'succeeded'}, {ordinal:9,display_position:2,enabled:false,status:'waiting'}, {ordinal:3,display_position:3,enabled:true,status:'waiting'}];
test('uses enabled project order and does not mistake unqueued waiting for active work',()=>{
 expect(planWorkflow(steps,[])).toEqual({kind:'dispatch',ordinal:3,position:3});
 expect(planWorkflow(steps,[3])).toEqual({kind:'wait',position:3});
});
test('failure blocks only its workflow; completed workflows do not redispatch',()=>{
 expect(planWorkflow([{...steps[0]!,status:'failed'}],[])).toEqual({kind:'blocked',ordinal:1,position:1,reason:'step_failed'});
 expect(planWorkflow([steps[0]!],[])).toEqual({kind:'done'});
});
test('logical ingestion waits on its internal PDF extraction attempt',()=>{
 expect(planWorkflow([{ordinal:1,display_position:1,enabled:true,status:'waiting'}],[2])).toEqual({kind:'wait',position:1});
});
test('horizontal advances independently; vertical waits for active earlier stage but excludes blocked subset',()=>{
 const plans=[{id:'a',plan:{kind:'wait' as const,position:1}},{id:'b',plan:{kind:'dispatch' as const,ordinal:3,position:3}},{id:'c',plan:{kind:'blocked' as const,ordinal:1,position:1,reason:'step_failed'}}];
 expect(planBatch('horizontal',plans)).toEqual(['b']);
 expect(planBatch('vertical',plans)).toEqual([]);
 expect(planBatch('vertical',plans.slice(1))).toEqual(['b']);
});
