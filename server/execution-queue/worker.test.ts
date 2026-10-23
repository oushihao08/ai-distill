/** 临时SQLite、SQL替身与独立随机端口HTTP服务：验证慢对账不阻塞其他通道，不连接业务库或调用模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {Hono} from 'hono';
import {localQueue} from './runtime';
import {runLocalQueueWorker} from './worker';
import {registerExecutionQueueRoutes} from './routes';

test('slow registration does not block already registered work; isolated HTTP reports review status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'queue-worker-isolated-')),q=localQueue(root),before=process.env.EXECUTION_QUEUE_MODE;
 const controller=new AbortController();let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 let worker:Promise<void>|undefined,server:ReturnType<typeof Bun.serve>|undefined;
 try{
  process.env.EXECUTION_QUEUE_MODE='local';
  q.intent(randomUUID(),'step','agent','authoring');
  const ready=randomUUID();q.intent(ready,'step','api','invalid-test-route');q.confirm(ready);
  const pool={query:async(input:string|{text:string})=>{const sql=typeof input==='string'?input:input.text;
   if(sql.includes('to_regclass'))return{rows:[{available:true,app:`ai-distill-executor:${q.executorId}`}]};
   if(sql.includes('job_id=ANY')){await blocked;return{rows:[]};}
   if(sql.includes('SELECT j.status'))return{rows:[{status:'running'}]};
   if(sql.startsWith('SELECT j.id,'))return{rows:[{id:ready,job:{}}]};
   if(sql.includes('to_jsonb'))return{rows:[{job:{}}]};
   throw new Error('Unexpected test SQL');
  }} as unknown as Pool;
  worker=runLocalQueueWorker(pool,root,controller.signal,{agent:1,llmApi:1},async()=>true,'api');
  const deadline=Date.now()+2000;
  while(q.get(ready)?.state!=='needs_review'&&Date.now()<deadline)await Bun.sleep(10);
  expect(q.get(ready)?.state).toBe('needs_review');
  const app=new Hono();registerExecutionQueueRoutes(app,pool,root);
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch});
  const response=await fetch(`http://127.0.0.1:${server.port}/api/system/execution-queue`);
  expect(response.status).toBe(200);const payload=await response.json() as {items:Record<string,unknown>[]};
  const item=payload.items.find(i=>i.id===ready)!;expect(item.state).toBe('needs_review');expect(item.updated_at).toBeNumber();expect(item).not.toHaveProperty('lease');expect(item).not.toHaveProperty('error');
 }finally{controller.abort();release();if(worker)await worker;server?.stop(true);q.close();if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;await rm(root,{recursive:true,force:true});}
});

test('explicit workflow scope is enforced before claim; other queued tasks remain untouched',async()=>{
 const root=await mkdtemp(join(tmpdir(),'queue-scoped-')),q=localQueue(root),before=process.env.EXECUTION_QUEUE_MODE;
 const c=new AbortController(),scope=randomUUID(),own=randomUUID(),other=randomUUID();let worker:Promise<void>|undefined;
 try{
  process.env.EXECUTION_QUEUE_MODE='local';
  for(const id of [other,own]){q.intent(id,'step','api','invalid-test-route');q.confirm(id);}
  const pool={query:async(input:string|{text:string})=>{
   const sql=typeof input==='string'?input:input.text;
   if(sql.includes('to_regclass'))return{rows:[{available:true,app:`ai-distill-executor:${q.executorId}`}]};
   if(sql.startsWith('SELECT j.id,'))return{rows:[{id:other,job:{workflow_id:randomUUID(),ordinal:5}},{id:own,job:{workflow_id:scope,ordinal:5}}]};
   if(sql.includes('SELECT j.status'))return{rows:[{status:'running'}]};
   if(sql.includes('to_jsonb'))return{rows:[{job:{}}]};
   return{rows:[]};
  }} as unknown as Pool;
  worker=runLocalQueueWorker(pool,root,c.signal,{agent:1,llmApi:1},async()=>true,'all',[scope]);
  const deadline=Date.now()+1500;while(q.get(own)?.state!=='needs_review'&&Date.now()<deadline)await Bun.sleep(10);
  expect(q.get(own)?.state).toBe('needs_review');expect(q.get(other)?.state).toBe('queued');expect(q.get(other)?.pid).toBeNull();
 }finally{c.abort();if(worker)await worker;q.close();if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;await rm(root,{recursive:true,force:true});}
});

test('local worker modes preserve hook, executor target and scoped step affinity',async()=>{
 const {canRunLocalTask}=await import('./worker');
 const job={kind:'step',lane:'api',route:'answer'} as any;
 expect(canRunLocalTask('api',job,{input:{hooks:{}}},'local')).toBe(false);
 expect(canRunLocalTask('local',job,{input:{hooks:{}}},'local')).toBe(true);
 expect(canRunLocalTask('local',job,{},'local')).toBe(false);
 expect(canRunLocalTask('materials',job,{},'server')).toBe(false);
 expect(canRunLocalTask('server',job,{execution_target:'server'},'server')).toBe(true);
 expect(canRunLocalTask('server',{...job,route:'score'},{execution_target:'server'},'server')).toBe(false);
 expect(canRunLocalTask('api',job,{execution_target:'server'},'local')).toBe(false);
 expect(canRunLocalTask('api',{...job,route:'publish',lane:'internal'},{},'local')).toBe(false);
 expect(canRunLocalTask('local',{...job,route:'publish',lane:'internal'},{workflow_id:'own',ordinal:8},'local',['own'])).toBe(true);
});
