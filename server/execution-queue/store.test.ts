/** 验证本机队列隔离、同机并发领取、结果复用及中断边界；不调用模型、不连接业务数据库。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalQueue} from './store';
function fixture(run:(a:LocalQueue,b:LocalQueue,root:string)=>unknown){const root=mkdtempSync(join(tmpdir(),'execution-queue-')),a=new LocalQueue(join(root,'A'),'device-a'),b=new LocalQueue(join(root,'B'),'device-b');return Promise.resolve().then(()=>run(a,b,root)).finally(()=>{a.close();b.close();rmSync(root,{recursive:true,force:true});});}
test('two machines keep Agent and API queues independent',()=>fixture((a,b)=>{expect(a.executorId).not.toBe(b.executorId);for(const lane of ['agent','api'] as const){const id=randomUUID();a.intent(id,'step',lane,'answer');a.confirm(id);expect(b.claim(lane)).toBeNull();expect(a.claim(lane)?.id).toBe(id);}expect(b.list()).toHaveLength(0);}));
test('same local directory shares identity and exclusive claims',()=>fixture((a,_b,root)=>{const another=new LocalQueue(join(root,'A'),'device-a');try{expect(another.executorId).toBe(a.executorId);const id=randomUUID();a.intent(id,'step','agent','authoring');a.confirm(id);expect(a.claim('agent')?.id).toBe(id);expect(another.claim('agent')).toBeNull();}finally{another.close();}}));
test('unconfirmed intent cannot execute; request identity cannot change',()=>fixture(a=>{const id=randomUUID();a.intent(id,'step','api','answer');expect(a.claim('api')).toBeNull();expect(()=>a.intent(id,'step','agent','answer')).toThrow();a.confirm(id);expect(a.claim('api')?.id).toBe(id);}));
test('local cancel prevents claim and invalidates heartbeat',()=>fixture(a=>{const id=randomUUID();a.intent(id,'step','api','answer');a.confirm(id);const job=a.claim('api')!;a.cancel(id);expect(a.heartbeat(id,job.lease!)).toBe(false);expect(a.claim('api')).toBeNull();}));
test('stale lease cannot complete a task',()=>fixture(a=>{const id=randomUUID();a.intent(id,'step','agent','authoring');a.confirm(id);const job=a.claim('agent')!;expect(a.finish(id,randomUUID(),'committed')).toBe(false);expect(a.finish(id,job.lease!,'committed')).toBe(true);}));
test('result checkpoint reuses exact typed output without another paid call',()=>fixture(async a=>{const id=randomUUID();a.intent(id,'step','api','answer');let calls=0;const output={text:'答案',bytes:Buffer.from('private'),usage:{total:5}};const invoke=async()=>{calls++;return output;};expect(await a.call(id,'answer',invoke)).toEqual(output);expect(await a.call(id,'answer',invoke)).toEqual(output);expect(calls).toBe(1);}));
test('ambiguous started call is never automatically reissued',()=>fixture(async a=>{const id=randomUUID();a.intent(id,'step','api','answer');let calls=0;const fail=async()=>{calls++;throw new Error('unknown response');};await expect(a.call(id,'answer',fail)).rejects.toThrow();await expect(a.call(id,'answer',fail)).rejects.toThrow('需核实');expect(calls).toBe(1);}));
test('corrupt persisted result is rejected',()=>fixture(async a=>{const id=randomUUID();a.intent(id,'step','api','answer');await a.call(id,'answer',async()=>({text:'yes'}));a.db.query('UPDATE calls SET result=? WHERE job_id=?').run(Buffer.from('corrupt'),id);await expect(a.call(id,'answer',async()=>({text:'no'}))).rejects.toThrow('摘要');}));
test('dead process with unknown call becomes needs_review; no cross-machine recovery',()=>fixture((a,b)=>{const id=randomUUID();a.intent(id,'step','api','answer');a.confirm(id);a.claim('api');a.db.query('UPDATE jobs SET pid=? WHERE id=?').run(2147483647,id);a.db.query("INSERT INTO calls VALUES(?,?,'started',NULL,NULL)").run(id,'answer');b.recover();expect(a.get(id)?.state).toBe('running');a.recover();expect(a.get(id)?.state).toBe('needs_review');expect(a.claim('api')).toBeNull();}));

test('copied runtime directory cannot silently become another machine',()=>fixture((a,_b,root)=>{expect(()=>new LocalQueue(join(root,'A'),'different-device')).toThrow('另一台电脑');}));

test('failure checkpoint survives reopening and stays bound to generation',()=>fixture((a,_b,root)=>{
 const id=randomUUID();a.intent(id,'step','api','answer');a.confirm(id);const job=a.claim('api')!;
 const failure={status:'failed' as const,message:'模型调用失败',result:{error_code:'provider_error'}};
 a.saveStepFailure(job,failure);a.saveStepFailure(job,{...failure,message:'不得覆盖原始失败'});
 const reopened=new LocalQueue(join(root,'A'),'device-a');
 try{expect(reopened.stepFailure(job)).toEqual(failure);a.rearm(id,1);expect(a.stepFailure(a.get(id)!)).toBeNull();}finally{reopened.close();}
}));
test('known failed call recovers for settlement; rejected call without terminal remains review',()=>fixture(async a=>{
 for(const recorded of [true,false]){
  const id=randomUUID();a.intent(id,'step','api','answer');a.confirm(id);const job=a.claim('api')!;
  await expect(a.call(id,'0:answer',async()=>{throw new Error('failed');})).rejects.toThrow();
  if(recorded)a.saveStepFailure(job,{status:'failed',message:'failed',result:null});
  a.db.query('UPDATE jobs SET pid=? WHERE id=?').run(2147483647,id);a.recover();
  expect(a.get(id)?.state).toBe(recorded?'result_pending_commit':'needs_review');
 }
}));
test('corrupt failure is quarantined; old generation unknown calls do not poison new results',()=>fixture(async a=>{
 const id=randomUUID();a.intent(id,'step','api','answer');a.confirm(id);const job=a.claim('api')!;
 a.saveStepFailure(job,{status:'failed',message:'failed',result:null});
 a.db.query('UPDATE calls SET result=? WHERE job_id=?').run(Buffer.from('corrupt'),id);
 expect(()=>a.stepFailure(job)).toThrow('摘要');
 a.db.query('UPDATE jobs SET pid=? WHERE id=?').run(2147483647,id);a.recover();expect(a.get(id)?.state).toBe('needs_review');
 a.db.query("INSERT INTO calls VALUES(?,?,'started',NULL,NULL)").run(id,'0:old');
 a.rearm(id,1);expect(a.hasUnknownCall(id)).toBe(false);expect(a.hasResult(id)).toBe(false);
 await a.call(id,'1:new',async()=>({ok:true}));expect(a.hasResult(id)).toBe(true);
}));
