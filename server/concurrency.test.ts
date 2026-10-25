/**
 * 文件职责：验证 Agent 与模型 API 并发设置及跨 gate 槽位协调。
 * 主要边界：使用临时 SQLite 目录，不读取真实设置，不启动 worker 或外部调用。
 */
import {describe,expect,it} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentConcurrencyGate,readActiveConcurrencyLimit,readConcurrencySettings} from './concurrency';

async function withGates<T>(run:(root:string,first:ReturnType<typeof createAgentConcurrencyGate>,second:ReturnType<typeof createAgentConcurrencyGate>)=>Promise<T>,limit=2){
 const root=await mkdtemp(join(tmpdir(),'ai-distill-agent-concurrency-'));
 const first=createAgentConcurrencyGate(root,limit),second=createAgentConcurrencyGate(root,limit);
 try{return await run(root,first,second);}
 finally{first.close();second.close();await rm(root,{recursive:true,force:true});}
}

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}

it('容量只读上限等待另一个进程的短写锁，保留真实并发上限',async()=>{
 const {mkdir}=await import('node:fs/promises'),root=await mkdtemp(join(tmpdir(),'capacity-read-lock-'));await mkdir(join(root,'.concurrency'));
 const path=join(root,'.concurrency','agent-slots.sqlite3'),db=new Database(path);
 db.exec('CREATE TABLE agent_concurrency_owners(pid INTEGER PRIMARY KEY,token TEXT,concurrency_limit INTEGER)');db.query('INSERT INTO agent_concurrency_owners VALUES(?,?,?)').run(process.pid,'isolated',2);db.close();
 const code="import {Database} from 'bun:sqlite';const d=new Database(Bun.argv.at(-1));d.exec('BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{d.exec('COMMIT');d.close();},150);";
 const child=Bun.spawn([process.execPath,'--no-env-file','-e',code,path],{stdout:'pipe',stderr:'pipe'});
 try{
  const reader=child.stdout.getReader();expect((await reader.read()).done).toBe(false);reader.releaseLock();
  expect(readActiveConcurrencyLimit(root)).toBe(2);expect(await child.exited).toBe(0);
 }finally{await child.exited;await rm(root,{recursive:true,force:true});}
});

describe('worker concurrency settings',()=>{
 it('defaults to two Agent calls and eight model API calls',()=>{
  expect(readConcurrencySettings({})).toEqual({agent:2,llmApi:8});
 });

 it('accepts configured positive limits',()=>{
  expect(readConcurrencySettings({AGENT_CONCURRENCY:'3',LLM_API_CONCURRENCY:'12'})).toEqual({agent:3,llmApi:12});
 });

 it('rejects zero, non-integers, and unsafe limits',()=>{
  for(const value of ['0','1.5','33','many'])expect(()=>readConcurrencySettings({AGENT_CONCURRENCY:value})).toThrow();
  expect(()=>readConcurrencySettings({LLM_API_CONCURRENCY:'0'})).toThrow();
 });
});

describe('shared Agent concurrency gate',()=>{
 it('caps work across separate SQLite connections',async()=>withGates(async(_root,first,second)=>{
  let active=0,peak=0;
  const results=await Promise.all(Array.from({length:5},(_,index)=>(index%2?first:second).run(async()=>{
   active++;peak=Math.max(peak,active);
   await new Promise(resolve=>setTimeout(resolve,5));
   active--;
   return 'done';
  })));
  expect(peak).toBe(2);
  expect(results.every(result=>result.acquired&&result.value==='done')).toBe(true);
 }));

 it('declines a diagnostic call when all slots are occupied',async()=>withGates(async(_root,first,second)=>{
  const held=deferred();
  const active=[first.run(()=>held.promise),second.run(()=>held.promise)];
  let called=false;
  const result=await first.run(async()=>{called=true;},{wait:false});
  expect(result).toEqual({acquired:false});
  expect(called).toBe(false);
  held.resolve();
  await Promise.all(active);
 }));

 it('stops waiting after cancellation',async()=>withGates(async(_root,first,second)=>{
  const held=deferred(),controller=new AbortController();
  const active=first.run(()=>held.promise);
  setTimeout(()=>controller.abort(),10);
  const result=await second.run(async()=>true,{signal:controller.signal,pollMs:2});
  expect(result).toEqual({acquired:false});
  held.resolve();
  await active;
 },1));

 it('releases its slot when the task fails',async()=>withGates(async(_root,first,second)=>{
  await expect(first.run(async()=>{throw new Error('task failed');})).rejects.toThrow('task failed');
  const next=await second.run(async()=>'next',{wait:false});
  expect(next).toEqual({acquired:true,value:'next'});
 },1));

 it('reclaims slots left by a process that exited',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ai-distill-agent-stale-'));
  const gate=createAgentConcurrencyGate(root,1),path=join(root,'.concurrency','agent-slots.sqlite3'),db=new Database(path);
  try{
   db.query('INSERT INTO agent_concurrency_owners(pid,token,concurrency_limit) VALUES(?,?,?)').run(2147483647,'dead-process',1);
   db.query('INSERT INTO agent_concurrency_slots(slot,owner_pid,owner_token,lease_token) VALUES(?,?,?,?)').run(0,2147483647,'dead-process','dead-lease');
   const result=await gate.run(async()=>'recovered',{wait:false});
   expect(result).toEqual({acquired:true,value:'recovered'});
  }finally{db.close();gate.close();await rm(root,{recursive:true,force:true});}
 });

 it('rejects different limits within the same shared storage root',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ai-distill-agent-mismatch-'));
  const gate=createAgentConcurrencyGate(root,2);
  try{expect(()=>createAgentConcurrencyGate(root,3)).toThrow('配置已改变');}
  finally{gate.close();await rm(root,{recursive:true,force:true});}
 });
});
