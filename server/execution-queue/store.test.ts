/** 验证本机队列隔离、同机并发领取、结果复用及中断边界；不调用模型、不连接业务数据库。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalQueue,QueueCapacityError} from './store';
function fixture(run:(a:LocalQueue,b:LocalQueue,root:string)=>unknown){const root=mkdtempSync(join(tmpdir(),'execution-queue-')),a=new LocalQueue(join(root,'A'),'device-a'),b=new LocalQueue(join(root,'B'),'device-b');return Promise.resolve().then(()=>run(a,b,root)).finally(()=>{a.close();b.close();rmSync(root,{recursive:true,force:true});});}
const agentIntent=()=>({id:randomUUID(),kind:'step' as const,lane:'agent' as const,route:'authoring'});
test('waiting capacity is separate from running capacity and admits only the configured queue size',()=>fixture(a=>{
 const first=Array.from({length:4},agentIntent);a.reserveIntents(first,{agent:4});
 expect(a.capacity('agent',4)).toMatchObject({running:0,queued:0,reserved:4,waiting:4,available:0});
 for(const item of first)expect(a.confirm(item.id,4)).toBe(true);
 expect(()=>a.reserveIntents([agentIntent()],{agent:4})).toThrow(QueueCapacityError);
 expect(a.list()).toHaveLength(4);const claimed=a.claim('agent')!;expect(claimed).not.toBeNull();
 a.reserveIntents([agentIntent()],{agent:4});expect(a.capacity('agent',4)).toMatchObject({running:1,queued:3,reserved:1,waiting:4});
}));
test('a multi-model reservation is all or nothing when capacity is insufficient',()=>fixture(a=>{
 const existing=agentIntent();a.reserveIntents([existing],{agent:2});
 const group=[agentIntent(),agentIntent()];expect(()=>a.reserveIntents(group,{agent:2})).toThrow(QueueCapacityError);
 expect(group.map(item=>a.get(item.id))).toEqual([null,null]);expect(a.capacity('agent',2).reserved).toBe(1);
}));
test('mixed lanes do not partially reserve if another lane is full',()=>fixture(a=>{
 const api={...agentIntent(),lane:'api' as const,route:'answer'};a.reserveIntents([api],{api:1});
 const agent=agentIntent(),nextApi={...agentIntent(),lane:'api' as const,route:'answer'};
 expect(()=>a.reserveIntents([agent,nextApi],{agent:4,api:1})).toThrow(QueueCapacityError);
 expect(a.get(agent.id)).toBeNull();expect(a.capacity('agent',4).waiting).toBe(0);
}));
test('reusing and repeating the same intent consumes no additional capacity',()=>fixture(a=>{
 const item=agentIntent();a.reserveIntents([item,item],{agent:1});a.reserveIntents([item],{agent:1});
 expect(a.capacity('agent',1).waiting).toBe(1);a.confirm(item.id,1);a.reserveIntents([item],{agent:1});
 expect(a.capacity('agent',1)).toMatchObject({queued:1,reserved:0,waiting:1});
}));
test('historic unregistered intents are retained without masquerading as admitted waiting jobs',()=>fixture(a=>{
 const history=Array.from({length:5},agentIntent);for(const item of history)a.intent(item.id,item.kind,item.lane,item.route);
 expect(a.capacity('agent',4).waiting).toBe(0);
 const next=Array.from({length:4},agentIntent);a.reserveIntents(next,{agent:4});
 expect(a.confirm(history[0]!.id,4)).toBe(false);expect(a.get(history[0]!.id)?.state).toBe('pending_registration');
 for(const item of next)a.confirm(item.id,4);a.claim('agent');expect(a.confirm(history[0]!.id,4)).toBe(true);
 expect(a.list()).toHaveLength(9);expect(a.capacity('agent',4).waiting).toBe(4);
}));
test('cancelling an admitted intent frees its waiting place without admitting cancelled work',()=>fixture(a=>{
 const item=agentIntent();a.reserveIntents([item],{agent:1});a.cancel(item.id);
 expect(a.capacity('agent',1).available).toBe(1);a.reserveIntents([agentIntent()],{agent:1});
 a.confirm(item.id,1);expect(a.get(item.id)?.state).toBe('cancelled');
}));
test('capacity reservations are shared across local processes and independent across machines',()=>fixture((a,b,root)=>{
 const peer=new LocalQueue(join(root,'A'),'device-a');try{
  a.reserveIntents([agentIntent()],{agent:1});expect(()=>peer.reserveIntents([agentIntent()],{agent:1})).toThrow(QueueCapacityError);
  b.reserveIntents([agentIntent()],{agent:1});expect(b.capacity('agent',1).waiting).toBe(1);
 }finally{peer.close();}
}));
test('invalid capacity or conflicting intent rolls back the complete reservation',()=>fixture(a=>{
 const first=agentIntent();expect(()=>a.reserveIntents([first],{agent:0})).toThrow();expect(a.list()).toHaveLength(0);
 a.reserveIntents([first],{agent:2});const next=agentIntent();
 expect(()=>a.reserveIntents([next,{...first,route:'score'}],{agent:2})).toThrow();expect(a.get(next.id)).toBeNull();
}));
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

test('library failure persists across reopening, recovers known failure, and rejects corrupt or old generations',()=>fixture(async(a,_b,root)=>{
 const id=randomUUID();a.intent(id,'library','api','library:extract');a.confirm(id);const job=a.claim('api')!;
 await expect(a.call(id,'0:extract',async()=>{throw new Error('provider failure');})).rejects.toThrow();
 const failure={status:'failed' as const,code:'provider',message:'safe error',lease_token:randomUUID()};a.saveLibraryFailure(job,failure);
 const reopened=new LocalQueue(join(root,'A'),'device-a');
 try{
  expect(reopened.libraryFailure(job)).toEqual(failure);
  a.db.query('UPDATE jobs SET pid=? WHERE id=?').run(2147483647,id);a.recover();expect(a.get(id)?.state).toBe('result_pending_commit');
  a.rearm(id,1);expect(a.libraryFailure(a.get(id)!)).toBeNull();
  a.db.query("UPDATE calls SET sha256='corrupted' WHERE job_id=? AND state='terminal_failure'").run(id);
  expect(()=>a.libraryFailure(job)).toThrow('摘要不一致');
 }finally{reopened.close();}
}));

test('independent processes race for one bounded waiting pool without partially admitting a model group',()=>fixture(async(a,_b,root)=>{
 const {writeFileSync}=await import('node:fs'),moduleUrl=new URL('./store.ts',import.meta.url).href,barrier=join(root,'start-race');
 const groups=[Array.from({length:3},agentIntent),Array.from({length:3},agentIntent)];
 const children=groups.map(entries=>{
  const code=`import {LocalQueue,QueueCapacityError} from ${JSON.stringify(moduleUrl)};import {existsSync} from 'node:fs';const q=new LocalQueue(${JSON.stringify(a.root)},'device-a');while(!existsSync(${JSON.stringify(barrier)}))await Bun.sleep(5);try{q.reserveIntents(${JSON.stringify(entries)},{agent:4});console.log(JSON.stringify({accepted:true}));}catch(error){if(!(error instanceof QueueCapacityError))throw error;console.log(JSON.stringify({accepted:false}));}finally{q.close();}`;
  return Bun.spawn([process.execPath,'--no-env-file','-e',code],{stdout:'pipe',stderr:'pipe'});
 });
 writeFileSync(barrier,'start');
 const outcomes=await Promise.all(children.map(async child=>{const result=JSON.parse(await new Response(child.stdout).text());expect(await child.exited).toBe(0);return result.accepted;}));
 expect(outcomes.filter(Boolean)).toHaveLength(1);expect(a.capacity('agent',4).waiting).toBe(3);
 for(const [index,entries] of groups.entries())expect(entries.every(entry=>Boolean(a.get(entry.id))===outcomes[index])).toBe(true);
}));

test('periodic projections exclude terminal history and paginate unresolved jobs without starving ties',()=>fixture(a=>{
 const insert=a.db.prepare("INSERT INTO jobs(id,kind,lane,state,route,created_at,updated_at) VALUES(?,'step','agent',?,'authoring',?,?)");
 a.db.transaction(()=>{for(let i=0;i<50000;i++)insert.run(randomUUID(),'committed',i,i);})();
 const unresolved=Array.from({length:45},()=>randomUUID()).sort();
 a.db.transaction(()=>{for(const id of unresolved)insert.run(id,'needs_review',50001,50001);})();
 const queued=randomUUID(),running=randomUUID();a.intent(queued,'step','agent','authoring');a.confirm(queued);a.intent(running,'step','agent','authoring');a.confirm(running);a.claim('agent',[running]);
 expect(a.activeJobs().map(j=>j.id).sort()).toEqual([queued,running].sort());
 expect(a.runningJobs().map(j=>j.id)).toEqual([running]);
 expect(a.monitorJobs()).toHaveLength(47);expect(a.stateCounts('step').committed).toBe(50000);expect(a.stateCounts('library')).toEqual({});
 expect(a.capacity('agent',4)).toMatchObject({running:1,queued:1,reserved:0});
 const seen:string[]=[];let cursor:ReturnType<typeof a.reconciliationPage>[number]|undefined;
 for(let round=0;round<3;round++){const page=a.reconciliationPage('finished',cursor);expect(page.length).toBeLessThanOrEqual(20);seen.push(...page.map(j=>j.id));cursor=page.at(-1);}
 expect(seen).toEqual(unresolved);expect(a.reconciliationPage('finished',cursor)[0]?.id).toBe(unresolved[0]);
 const plan=a.db.query("EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE state='running' ORDER BY created_at,id").all() as {detail:string}[];
 expect(plan.some(row=>row.detail.includes('jobs_state_created'))).toBe(true);
 a.list=()=>{throw new Error('periodic recovery must not materialize history');};expect(()=>a.recover()).not.toThrow();
}));

test('reconciliation keyset survives a removed first page and revisits new earlier rows',()=>fixture(a=>{
 const ids=Array.from({length:42},()=>randomUUID()).sort();
 for(const id of ids){a.intent(id,'step','agent','authoring');a.db.query('UPDATE jobs SET created_at=1 WHERE id=?').run(id);}
 const first=a.reconciliationPage('registration');expect(first).toHaveLength(20);
 for(const row of first)a.confirm(row.id);
 const second=a.reconciliationPage('registration',first.at(-1));expect(second.map(j=>j.id)).toEqual(ids.slice(20,40));
 const tail=a.reconciliationPage('registration',second.at(-1));expect(tail.map(j=>j.id)).toEqual(ids.slice(40));
 const earlier=randomUUID();a.intent(earlier,'step','agent','authoring');a.db.query('UPDATE jobs SET created_at=0 WHERE id=?').run(earlier);
 expect(a.reconciliationPage('registration',tail.at(-1))[0]?.id).toBe(earlier);
 const cancelled=randomUUID();a.intent(cancelled,'step','agent','authoring');a.cancel(cancelled);
 expect(a.reconciliationPage('cancel').map(j=>j.id)).toEqual([cancelled]);a.confirmCancellation(cancelled);expect(a.reconciliationPage('cancel')).toHaveLength(0);
}));


test('old local schema gains compatible fields before periodic indexes without losing history',()=>{
 const root=mkdtempSync(join(tmpdir(),'old-queue-'));mkdirSync(join(root,'runtime'));const db=new Database(join(root,'runtime','queue.sqlite3')),id=randomUUID();
 db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,lane TEXT NOT NULL,state TEXT NOT NULL,route TEXT NOT NULL,lease TEXT,pid INTEGER,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error TEXT)');
 db.query("INSERT INTO jobs(id,kind,lane,state,route,created_at,updated_at) VALUES(?,'step','agent','committed','authoring',1,1)").run(id);db.close();
 let q:LocalQueue|undefined;
 try{q=new LocalQueue(root,'legacy-test-device');expect(q.get(id)).toMatchObject({id,state:'committed',generation:0,cancel_synced:0});expect(q.activeJobs()).toEqual([]);
  const indexes=q.db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as {name:string}[];
  expect(indexes.map(index=>index.name)).toContain('jobs_unsynced_cancel');expect(indexes.map(index=>index.name)).toContain('jobs_state_created');
 }finally{q?.close();rmSync(root,{recursive:true,force:true});}
});
