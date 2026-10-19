/** 验证 worker 池并发/空闲间隔/停止与公平轮转；任务处理器和资源门禁均为测试回调，不连接数据库或调用外部服务。 */
import { expect, test } from 'bun:test';
import { createFairQueueHandler,runWorkerPool } from './worker-pool';

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
