// 本机常驻 Worker 入口；事件触发即时补位，低频本机读兜底接收 API 进程新建批次与丢失通知。
import type { Pool } from 'pg';
import type { LocalQueue } from '../execution-queue/store';
import { BatchStore } from './store';
import { BatchScheduler } from './scheduler';
import { onLocalBusinessCommit } from '../execution-queue/runtime';
import { businessBackend } from './backend';
import { logEvent, classifyLogError } from '../logging';
export function startBatchWorker(
  pool: Pool,
  q: LocalQueue,
  agent: number,
  onQueued: () => void,
  signal: AbortSignal
) {
  const delivery = Number(process.env.BATCH_DELIVERY_CONCURRENCY ?? 4);
  if (!Number.isInteger(delivery) || delivery < 1 || delivery > 32) throw new RangeError('交付并发须为 1 至 32');
  let stopped = false;
  const wake = () => {
    if (!stopped)
      void scheduler
        .wake()
        .catch((err) =>
          logEvent('worker.dispatch.failed', {
            level: 'error',
            component: 'batch_dispatch',
            ...classifyLogError(err)
          })
        );
  };
  const scheduler = new BatchScheduler(
    new BatchStore(q.db),
    businessBackend(pool, q, agent, delivery),
    () => {
      onQueued();
      wake();
    },
    signal
  );
  const unsubscribe = onLocalBusinessCommit(q, wake);
  const timer = setInterval(wake, 1000);
  timer.unref();
  wake();
  return {
    wake,
    async close() {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
      await scheduler.close();
    }
  };
}
