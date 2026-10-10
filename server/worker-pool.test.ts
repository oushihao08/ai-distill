/** Worker 池调度：验证并发上限、空队列退避、资源不足时暂停派发，以及资源检查期间收到停止信号不会再领取任务。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import { expect, test } from 'bun:test';
import { runWorkerPool } from './worker-pool';

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

test('worker pool backs off when no task is available', async () => {
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
