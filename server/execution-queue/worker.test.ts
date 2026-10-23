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
