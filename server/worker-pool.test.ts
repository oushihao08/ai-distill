/** 验证 worker 池并发/空闲间隔/停止与公平轮转；任务处理器和资源门禁均为测试回调，不连接数据库或调用外部服务。 */
import { expect, test } from 'bun:test';
import { createFairQueueHandler,createSharedQueueProbe,createWorkerShutdown,runWorkerPool } from './worker-pool';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('isolated worker receives SIGTERM, drains cooperative work and persists stopped after request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-signal-'));
 const moduleUrl=new URL('./worker-pool.ts',import.meta.url).href,loggerUrl=new URL('./logging.ts',import.meta.url).href;
 const source=`import {createWorkerShutdown,runWorkerPool} from ${JSON.stringify(moduleUrl)};import {configureLogger} from ${JSON.stringify(loggerUrl)};const logger=configureLogger({root:${JSON.stringify(root)},service:'worker'}),c=new AbortController(),shutdown=createWorkerShutdown(c);process.on('SIGTERM',()=>shutdown.request('SIGTERM'));await runWorkerPool(async()=>{console.log('ready');await new Promise(resolve=>c.signal.addEventListener('abort',resolve,{once:true}));return true;},{concurrency:1,signal:c.signal,idleMs:1});shutdown.dispose();logger.log('service.stopped',{level:'info'});await logger.close();`;
 const child=Bun.spawn([process.execPath,'-e',source],{stdout:'pipe',stderr:'pipe'}),reader=child.stdout.getReader();
 try{
  const ready=await reader.read();expect(new TextDecoder().decode(ready.value)).toContain('ready');child.kill('SIGTERM');expect(await child.exited).toBe(0);
  const directory=join(root,'logs',new Date().toISOString().slice(0,10)),files=await readdir(directory);
  const records=(await readFile(join(directory,files[0]),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.map(x=>x.event)).toEqual(['service.shutdown_requested','service.stopped']);
 }finally{child.kill();await child.exited;await reader.cancel();await rm(root,{recursive:true,force:true});}
},3000);

test('stop during fair queue lookup prevents probing the next queue',async()=>{
 const controller=new AbortController();let second=0;
 const dispatch=createFairQueueHandler([async()=>{controller.abort();return false;},async()=>{second++;return true;}],controller.signal);
 expect(await dispatch()).toBe(false);expect(second).toBe(0);
});

test('shutdown preserves its first reason and is idempotent',()=>{
 const controller=new AbortController(),shutdown=createWorkerShutdown(controller,1000);
 try{shutdown.request('SIGTERM');const reason=controller.signal.reason;shutdown.request('SIGINT');expect(controller.signal.reason).toBe(reason);expect(reason.reason_code).toBe('worker_shutdown');}
 finally{shutdown.dispose();}
});

test('worker pool runs up to the configured concurrency and drains on abort', async () => {
  const controller = new AbortController();
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const running = runWorkerPool(async () => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return true;
  }, { concurrency: 2, signal: controller.signal, idleMs: 1 });

  while (started < 2) await Bun.sleep(1);
  expect(maxActive).toBe(2);
  controller.abort();
  release();
  await running;
  expect(active).toBe(0);
  expect(started).toBe(2);
});

test('worker pool waits the configured idle interval when no task is available', async () => {
  const controller = new AbortController();
  let calls = 0;
  const running = runWorkerPool(async () => {
    calls += 1;
    if (calls === 2) controller.abort();
    return false;
  }, { concurrency: 1, signal: controller.signal, idleMs: 5 });
  await running;
  expect(calls).toBe(2);
});
test('dispatch guard pauses new work and resumes when resources recover',async()=>{
 const controller=new AbortController();let gates=0,calls=0;
 await runWorkerPool(async()=>{calls++;controller.abort();return true;},{concurrency:1,signal:controller.signal,idleMs:1,beforeDispatch:async()=>++gates>=3});
 expect(gates).toBe(3);expect(calls).toBe(1);
});
test('abort during resource check cannot claim a new job',async()=>{
 const controller=new AbortController();let calls=0;
 await runWorkerPool(async()=>{calls++;return false;},{concurrency:1,signal:controller.signal,idleMs:1,beforeDispatch:async()=>{controller.abort();return true;}});
 expect(calls).toBe(0);
});

test('worker pool preserves the configured polling interval for newly queued work',async()=>{
 const controller=new AbortController();let calls=0;
 const running=runWorkerPool(async()=>{calls++;return false;},{concurrency:1,signal:controller.signal,idleMs:10});
 await Bun.sleep(56);controller.abort();await running;
 expect(calls).toBeGreaterThanOrEqual(5);
});

test('fair queue dispatch rotates after every successful task',async()=>{
 const order:string[]=[];
 const dispatch=createFairQueueHandler(['skill','redaction','authoring','score'].map(name=>async()=>{order.push(name);return true;}));
 for(let index=0;index<8;index++)expect(await dispatch()).toBe(true);
 expect(order).toEqual(['skill','redaction','authoring','score','skill','redaction','authoring','score']);
});

test('fair queue dispatch advances even when every queue is empty',async()=>{
 const order:string[]=[];
 const dispatch=createFairQueueHandler(['skill','redaction','authoring','score'].map(name=>async()=>{order.push(name);return false;}));
 expect(await dispatch()).toBe(false);expect(await dispatch()).toBe(false);
 expect(order).toEqual(['skill','redaction','authoring','score','redaction','authoring','score','skill']);
});


test('shared empty probe collapses concurrent lookups and expires within the polling interval',async()=>{
 let calls=0,clock=0,available=false;
 const probe=createSharedQueueProbe(async()=>{calls++;await Bun.sleep(2);return available;},3000,()=>clock);
 expect(await Promise.all(Array.from({length:8},()=>probe()))).toEqual(Array(8).fill(false));expect(calls).toBe(1);
 clock=2999;expect(await probe()).toBe(false);expect(calls).toBe(1);
 clock=3000;available=true;expect(await probe()).toBe(true);expect(calls).toBe(2);
 expect(await probe()).toBe(true);expect(calls).toBe(3);
});
test('probe failures are not cached and retry can recover',async()=>{
 let calls=0;const probe=createSharedQueueProbe(()=>{if(++calls===1)throw new Error('lookup failed');return Promise.resolve(true);});
 await expect(probe()).rejects.toThrow('lookup failed');expect(await probe()).toBe(true);expect(calls).toBe(2);
});
test('shared positive availability does not share claimed jobs or serialize execution',async()=>{
 let probes=0,next=0,active=0,peak=0;const seen:number[]=[];
 const probe=createSharedQueueProbe(async()=>{probes++;await Bun.sleep(1);return true;});
 await Promise.all(Array.from({length:4},async()=>{if(await probe()){const id=++next;seen.push(id);peak=Math.max(peak,++active);await Bun.sleep(5);active--;}}));
 expect(probes).toBe(1);expect(new Set(seen).size).toBe(4);expect(peak).toBe(4);
});
