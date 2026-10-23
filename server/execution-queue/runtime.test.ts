/** 验证领取条件、双写确认及本地结果保护；SQL替身不代表真实PG验收，真实脚本另列。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {LocalQueue} from './store';
import {withLocalExecution,localClaimSql,localWaitingSql,reconcileRegistrations,deferLocalPublication,PendingLocalCommit,synchronizeCancellation} from './runtime';
async function fixture(run:(q:LocalQueue)=>Promise<void>){const before=process.env.EXECUTION_QUEUE_MODE;process.env.EXECUTION_QUEUE_MODE='local';const root=mkdtempSync(join(tmpdir(),'queue-runtime-')),q=new LocalQueue(root,'test-device');try{await run(q);}finally{q.close();rmSync(root,{recursive:true,force:true});if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;}}
test('local mode cannot claim any cloud task without a local lease context',()=>fixture(async()=>{expect(localClaimSql('a')).toContain('FALSE');expect(localClaimSql('a',true)).toContain('FALSE');}));
test('local context restricts claim to exact validated ID and disables stale recovery',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);const j=q.claim('api')!;await withLocalExecution(q,j,async()=>{expect(localClaimSql('a')).toContain(id);expect(localClaimSql('a',true)).toContain('FALSE');expect(localWaitingSql('a')).toContain("'running'");expect(()=>localClaimSql('a;DROP')).toThrow();});}));
test('only acknowledged own registrations become executable',()=>fixture(async q=>{const own=randomUUID(),foreign=randomUUID(),unknown=randomUUID();for(const id of [own,foreign,unknown])q.intent(id,'step','api','answer');const pool={query:async()=>({rows:[{job_id:own,executor_id:q.executorId},{job_id:foreign,executor_id:randomUUID()}]})} as unknown as Pool;await reconcileRegistrations(pool,q);expect(q.get(own)?.state).toBe('queued');expect(q.get(foreign)?.state).toBe('cancelled');expect(q.get(foreign)?.cancel_synced).toBe(1);expect(q.get(unknown)?.state).toBe('pending_registration');}));
test('saved result turns transient publication error into pending commit, not new model attempt',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);const j=q.claim('api')!;await withLocalExecution(q,j,async()=>{await q.call(id,'answer',async()=>({text:'result'}));expect(()=>deferLocalPublication(Object.assign(new Error('connection lost'),{code:'ECONNRESET'}))).toThrow(PendingLocalCommit);expect(()=>deferLocalPublication(Object.assign(new Error('invalid constraint'),{code:'23514'}))).not.toThrow();});}));
test('cancel remains durable when cloud is disconnected',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);q.cancel(id);const pool={connect:async()=>{throw Object.assign(new Error('offline'),{code:'ECONNRESET'});}} as unknown as Pool;await expect(synchronizeCancellation(pool,q,id)).rejects.toThrow('offline');expect(q.get(id)?.cancel_requested).toBe(1);expect(q.get(id)?.cancel_synced).toBe(0);expect(q.claim('api')).toBeNull();}));
test('unconfirmed or foreign registration does not block other local cancellation work',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.cancel(id);const queries:string[]=[];const pool={connect:async()=>({query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;queries.push(sql);return{rows:[]};},release(){}})} as unknown as Pool;await synchronizeCancellation(pool,q,id);expect(queries).toContain('ROLLBACK');expect(q.get(id)?.cancel_synced).toBe(0);}));
test('late cancellation preserves an already published success',()=>fixture(async q=>{const id=randomUUID();q.intent(id,'step','api','answer');q.confirm(id);q.cancel(id);const queries:string[]=[];const pool={connect:async()=>({query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;queries.push(sql);return{rows:sql.includes('SELECT executor_id')?[{executor_id:q.executorId}]:sql.includes('SELECT status')?[{status:'succeeded'}]:[]};},release(){}})} as unknown as Pool;await synchronizeCancellation(pool,q,id);expect(q.get(id)?.state).toBe('committed');expect(q.get(id)?.cancel_synced).toBe(1);expect(queries.some(sql=>sql.startsWith('UPDATE'))).toBe(false);}));

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
