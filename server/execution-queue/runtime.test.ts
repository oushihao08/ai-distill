/** 验证领取条件、双写确认及本地结果保护；SQL替身不代表真实PG验收，真实脚本另列。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {LocalQueue,QueueCapacityError} from './store';
import {withLocalExecution,localClaimSql,localWaitingSql,reconcileRegistrations,deferLocalPublication,PendingLocalCommit,synchronizeCancellation,synchronizeLocalCancellations,registerLocalJobs,localQueueLimits} from './runtime';
async function fixture(run:(q:LocalQueue)=>Promise<void>){const before=process.env.EXECUTION_QUEUE_MODE;process.env.EXECUTION_QUEUE_MODE='local';const root=mkdtempSync(join(tmpdir(),'queue-runtime-')),q=new LocalQueue(root,'test-device');try{await run(q);}finally{q.close();rmSync(root,{recursive:true,force:true});if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;}}
test('multi-model admission rejects the complete group before creating cloud dispatch ownership',()=>fixture(async q=>{
 const id=randomUUID();q.intent(id,'step','agent','authoring');q.confirm(id);const context=q.claim('agent')!;
 const limit=localQueueLimits(q).agent,entries=Array.from({length:limit+1},()=>({id:randomUUID(),kind:'step' as const,lane:'agent' as const,route:'score'}));
 let writes=0;const db={query:async()=>{writes++;return{rows:[{executor_id:q.executorId}]};}} as never;
 await expect(withLocalExecution(q,context,()=>registerLocalJobs(db,entries))).rejects.toBeInstanceOf(QueueCapacityError);
 expect(writes).toBe(0);expect(entries.every(item=>q.get(item.id)===null)).toBe(true);
}));
test('registration reserves only new jobs and confirms them within local waiting capacity',()=>fixture(async q=>{
 const id=randomUUID();q.intent(id,'step','agent','authoring');q.confirm(id);const context=q.claim('agent')!;
 const limit=localQueueLimits(q).agent,entries=Array.from({length:limit},()=>({id:randomUUID(),kind:'step' as const,lane:'agent' as const,route:'score'}));
 const db={query:async()=>({rows:[{executor_id:q.executorId}]})} as never;
 await withLocalExecution(q,context,()=>registerLocalJobs(db,entries));
 expect(q.capacity('agent',limit).reserved).toBe(limit);
 const pool={query:async()=>({rows:entries.map(entry=>({job_id:entry.id,executor_id:q.executorId,generation:0}))})} as unknown as Pool;
 await reconcileRegistrations(pool,q);expect(q.capacity('agent',limit)).toMatchObject({running:1,queued:limit,reserved:0});
 await withLocalExecution(q,context,()=>registerLocalJobs(db,entries));expect(q.capacity('agent',limit).waiting).toBe(limit);
}));
test('local mode cannot claim any cloud task without a local lease context',()=>fixture(async()=>{expect(localClaimSql('a')).toContain('FALSE');expect(localClaimSql('a',true)).toContain('FALSE');}));
test('local context restricts claim to exact validated ID and disables stale recovery',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);const j=q.claim('api')!;await withLocalExecution(q,j,async()=>{expect(localClaimSql('a')).toContain(id);expect(localClaimSql('a',true)).toContain('FALSE');expect(localWaitingSql('a')).toContain("'running'");expect(()=>localClaimSql('a;DROP')).toThrow();});}));
test('only acknowledged own registrations become executable',()=>fixture(async q=>{const own=randomUUID(),foreign=randomUUID(),unknown=randomUUID();for(const id of [own,foreign,unknown])q.intent(id,'step','api','answer');const pool={query:async()=>({rows:[{job_id:own,executor_id:q.executorId},{job_id:foreign,executor_id:randomUUID()}]})} as unknown as Pool;await reconcileRegistrations(pool,q);expect(q.get(own)?.state).toBe('queued');expect(q.get(foreign)?.state).toBe('cancelled');expect(q.get(foreign)?.cancel_synced).toBe(1);expect(q.get(unknown)?.state).toBe('pending_registration');}));
test('saved result turns transient publication error into pending commit, not new model attempt',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);const j=q.claim('api')!;await withLocalExecution(q,j,async()=>{await q.call(id,'answer',async()=>({text:'result'}));expect(()=>deferLocalPublication(Object.assign(new Error('connection lost'),{code:'ECONNRESET'}))).toThrow(PendingLocalCommit);expect(()=>deferLocalPublication(Object.assign(new Error('invalid constraint'),{code:'23514'}))).not.toThrow();});}));
test('cancel remains durable when cloud is disconnected',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);q.cancel(id);const pool={connect:async()=>{throw Object.assign(new Error('offline'),{code:'ECONNRESET'});}} as unknown as Pool;await expect(synchronizeCancellation(pool,q,id)).rejects.toThrow('offline');expect(q.get(id)?.cancel_requested).toBe(1);expect(q.get(id)?.cancel_synced).toBe(0);expect(q.claim('api')).toBeNull();}));
test('unconfirmed or foreign registration does not block other local cancellation work',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.cancel(id);const queries:string[]=[];const pool={connect:async()=>({query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;queries.push(sql);return{rows:[]};},release(){}})} as unknown as Pool;await synchronizeCancellation(pool,q,id);expect(queries).toContain('ROLLBACK');expect(q.get(id)?.cancel_synced).toBe(0);}));
test('late cancellation preserves an already published success',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);q.cancel(id);const queries:string[]=[];const pool={connect:async()=>({query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;queries.push(sql);return{rows:sql.includes('SELECT executor_id')?[{executor_id:q.executorId}]:sql.includes('SELECT status')?[{status:'succeeded'}]:[]};},release(){}})} as unknown as Pool;await synchronizeCancellation(pool,q,id);expect(q.get(id)?.state).toBe('committed');expect(q.get(id)?.cancel_synced).toBe(1);expect(queries.some(sql=>sql.startsWith('UPDATE'))).toBe(false);}));

test('unregistered cancellation backlog uses one owner read per bounded round without opening transactions',()=>fixture(async q=>{
 const ids=Array.from({length:39},()=>randomUUID());for(const id of ids){q.intent(id,'step','api','answer');q.cancel(id);}
 const originalList=q.list.bind(q);q.list=()=>{throw new Error('reconciliation must not materialize history');};
 let reads=0,connections=0;const seen=new Set<string>();
 const pool={query:async(query:{text:string;query_timeout:number},args:string[][])=>{
  reads++;expect(query.text).toContain('execution_dispatches');expect(query.query_timeout).toBe(15000);
  expect(args[0]!.length).toBeLessThanOrEqual(20);for(const id of args[0]!)seen.add(id);return{rows:[]};
 },connect:async()=>{connections++;throw new Error('unregistered cancellation must not start a transaction');}} as unknown as Pool;
 await synchronizeLocalCancellations(pool,q);await synchronizeLocalCancellations(pool,q);
 expect(reads).toBe(2);expect(connections).toBe(0);expect(seen.size).toBe(39);
 expect(originalList().every(j=>j.state==='cancelled'&&j.cancel_requested===1&&j.cancel_synced===0)).toBe(true);
}));

test('batch cancellation preflight preserves missing owners and transactional checks, and isolates failures',()=>fixture(async q=>{
 const missing=randomUUID(),failed=randomUUID(),own=randomUUID(),foreign=randomUUID();
 for(const id of [missing,failed,own,foreign]){q.intent(id,'step','api','answer');q.cancel(id);}
 let fail=true;const checked:string[]=[],released:unknown[]=[],foreignOwner=randomUUID();
 const pool={query:async()=>({rows:[{job_id:failed},{job_id:own},{job_id:foreign}]}),connect:async()=>({query:async(input:string|{text:string},args?:string[])=>{
  const sql=typeof input==='string'?input:input.text;
  if(sql.startsWith('SELECT executor_id')){const id=args![0]!;checked.push(id);if(id===failed&&fail)throw new Error('synthetic connection interruption');return{rows:[{executor_id:id===foreign?foreignOwner:q.executorId}]};}
  return{rows:sql.startsWith('SELECT status')?[{status:'succeeded'}]:[]};
 },release:(error?:Error)=>released.push(error)})} as unknown as Pool;
 await synchronizeLocalCancellations(pool,q);
 expect(checked).toContain(failed);expect(checked).toContain(own);expect(checked).not.toContain(missing);expect(checked).toContain(foreign);
 expect(q.get(missing)?.cancel_synced).toBe(0);expect(q.get(failed)?.cancel_synced).toBe(0);
 expect(q.get(own)?.state).toBe('committed');expect(q.get(own)?.cancel_synced).toBe(1);expect(q.get(foreign)?.cancel_synced).toBe(1);
 expect(released.some(error=>error instanceof Error)).toBe(true);
 fail=false;await synchronizeLocalCancellations(pool,q);expect(q.get(failed)?.state).toBe('committed');
}));

test('late registration is picked up in a later cancellation round and an owner disappearing after preflight stays unconfirmed',()=>fixture(async q=>{
 const id=randomUUID();q.intent(id,'step','api','answer');q.cancel(id);
 let registered=false,ownerPresent=false,connections=0;
 const pool={query:async()=>({rows:registered?[{job_id:id}]:[]}),connect:async()=>{
  connections++;
  return{query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;return{rows:sql.startsWith('SELECT executor_id')?ownerPresent?[{executor_id:q.executorId}]:[]:sql.startsWith('SELECT status')?[{status:'failed'}]:[]};},release(){}};
 }} as unknown as Pool;
 await synchronizeLocalCancellations(pool,q);expect(connections).toBe(0);expect(q.get(id)?.cancel_synced).toBe(0);
 registered=true;
 await synchronizeLocalCancellations(pool,q);expect(connections).toBe(1);expect(q.get(id)?.cancel_synced).toBe(0);
 ownerPresent=true;
 await synchronizeLocalCancellations(pool,q);expect(q.get(id)?.state).toBe('failed');expect(q.get(id)?.cancel_synced).toBe(1);
}));

test('finished reconciliation settles failures and continues past an unavailable item with bounded batches',()=>fixture(async q=>{
 const {reconcileFinishedJobs}=await import('./runtime');
 const ids=Array.from({length:25},()=>randomUUID());for(const id of ids){q.intent(id,'step','api','answer');q.resolve(id,'needs_review');}
 let reads=0;const seen=new Set<string>();
 const pool={query:async(_sql:string,args:string[])=>{reads++;seen.add(args[0]!);if(args[0]===ids[0])throw new Error('synthetic failure');return{rows:[{status:'failed'}]};}} as unknown as Pool;
 await reconcileFinishedJobs(pool,q);expect(reads).toBe(20);
 await reconcileFinishedJobs(pool,q);expect(seen.size).toBe(25);
 expect(q.list().filter(j=>j.state==='failed')).toHaveLength(24);expect(q.get(ids[0]!)?.state).toBe('needs_review');
}));

test('only transient persistence errors qualify for automatic settlement retry',async()=>{
 const {isTransientCommitFailure}=await import('./runtime');
 for(const code of ['ECONNRESET','57P01','40001','40P01','55P03'])expect(isTransientCommitFailure(Object.assign(new Error('synthetic'),{code}))).toBe(true);
 expect(isTransientCommitFailure(new Error('Query read timeout'))).toBe(true);
 for(const code of ['23503','23514','42703'])expect(isTransientCommitFailure(Object.assign(new Error('synthetic'),{code}))).toBe(false);
 expect(isTransientCommitFailure(new Error('invalid checkpoint'))).toBe(false);
});

test('known rollback releases only its uncommitted admission; committed ownership and failed proof retain capacity',()=>fixture(async q=>{
 const {releaseRolledBackRegistrations,forgetLocalRegistrations}=await import('./runtime');
 const contextId=randomUUID();q.intent(contextId,'step','agent','authoring');q.confirm(contextId);const context=q.claim('agent')!;
 const a=randomUUID(),b=randomUUID();let proofFails=false,registered=true;
 const db={query:async(sql:string)=>{if(sql.startsWith('INSERT'))return{rows:[{executor_id:q.executorId}]};if(proofFails)throw new Error('synthetic proof unavailable');return{rows:registered?[{job_id:b}]:[]};}} as any;
 await withLocalExecution(q,context,()=>registerLocalJobs(db,[{id:a,kind:'step',lane:'api',route:'answer'},{id:b,kind:'step',lane:'api',route:'answer'}]));
 expect(q.capacity('api',8).reserved).toBe(2);proofFails=true;await releaseRolledBackRegistrations(db);expect(q.capacity('api',8).reserved).toBe(2);
 proofFails=false;await releaseRolledBackRegistrations(db);expect(q.capacity('api',8).reserved).toBe(1);expect(q.get(a)?.state).toBe('pending_registration');
 registered=false;await releaseRolledBackRegistrations(db);expect(q.capacity('api',8).reserved).toBe(1);forgetLocalRegistrations(db);
}));

test('waiting limit uses the live consumer setting until restart, not a newly saved configuration',()=>fixture(async q=>{
 const {saveWorkerConcurrencySettings,getAgentConcurrencyGate,closeAgentConcurrencyGate}=await import('../concurrency');
 const beforeAgent=process.env.AGENT_CONCURRENCY,beforeApi=process.env.LLM_API_CONCURRENCY;delete process.env.AGENT_CONCURRENCY;delete process.env.LLM_API_CONCURRENCY;
 try{saveWorkerConcurrencySettings(q.root,{agent:4,llmApi:4});getAgentConcurrencyGate(q.root,2);expect(localQueueLimits(q).agent).toBe(2);closeAgentConcurrencyGate(q.root);expect(localQueueLimits(q).agent).toBe(2);const {Database}=await import('bun:sqlite');const registry=new Database(join(q.root,'.concurrency','agent-slots.sqlite3'));try{registry.query('DELETE FROM agent_concurrency_owners').run();}finally{registry.close();}expect(localQueueLimits(q).agent).toBe(4);}
 finally{closeAgentConcurrencyGate(q.root);if(beforeAgent===undefined)delete process.env.AGENT_CONCURRENCY;else process.env.AGENT_CONCURRENCY=beforeAgent;if(beforeApi===undefined)delete process.env.LLM_API_CONCURRENCY;else process.env.LLM_API_CONCURRENCY=beforeApi;}
}));

test('cancelling a local advice task records a skipped outcome without updating original workflow steps',()=>fixture(async q=>{
 const id=randomUUID();q.intent(id,'advice','agent','advice');q.confirm(id);q.cancel(id);const queries:string[]=[];
 const pool={connect:async()=>({query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;queries.push(sql);return{rows:sql.startsWith('SELECT executor_id')?[{executor_id:q.executorId}]:sql.startsWith('SELECT status')?[{status:'waiting'}]:[]};},release(){}})} as unknown as Pool;
 await synchronizeCancellation(pool,q,id);expect(q.get(id)?.cancel_synced).toBe(1);
 expect(queries.some(sql=>sql.startsWith('UPDATE ai_distill.revision_advice_attempts')&&sql.includes("status='skipped'")&&sql.includes('用户取消返修建议'))).toBe(true);
 expect(queries.some(sql=>sql.startsWith('UPDATE ai_distill.steps'))).toBe(false);
}));
