/**
 * 职责：通用任务轮询：控制并发、空闲等待、错误退避和退出信号，不承载业务阶段规则。
 * 关键方法与用途：`runWorkerPool()` 按并发上限轮询并处理停止信号；`createFairQueueHandler()` 轮转探测多个业务队列。
 * 使用场景：由 `worker.ts` 注册业务 handler；本模块不决定各业务阶段规则。
 */
import {classifyLogError,logEvent,withLogContext} from './logging';
export interface WorkerPoolOptions {
  concurrency: number;
  signal: AbortSignal;
  idleMs: number;
  errorDelayMs?: number;
  beforeDispatch?: () => Promise<boolean>;
  onError?: (error: unknown, worker: number) => void;
  component?: string;
}

/** 按轮转顺序探测队列；成功消费后从下一类开始，避免持续繁忙的前置队列饿死后续队列。 */
export function createFairQueueHandler(queues:readonly (()=>Promise<boolean>)[]){
  if(!queues.length)throw new RangeError('at least one worker queue is required');
  let cursor=0;
  return async()=>{
    for(let offset=0;offset<queues.length;offset++){
      const index=(cursor+offset)%queues.length;
      if(await queues[index]!()){
        cursor=(index+1)%queues.length;
        return true;
      }
    }
    cursor=(cursor+1)%queues.length;
    return false;
  };
}

function delay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 启动指定数量的轮询循环，可在派发前检查资源，并对空队列或失败调用分别退避。
 * AbortSignal 阻止后续循环领取新任务；正在运行的 handler 需由自己的取消信号处理退出。
 */
export async function runWorkerPool(
  runOne: (worker: number) => Promise<boolean>,
  options: WorkerPoolOptions,
) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('worker concurrency must be a positive integer');
  }
  const loops = Array.from({ length: options.concurrency }, async (_, worker) => {
    let previousFailure: string | undefined;
    while (!options.signal.aborted) {
      let worked = false;
      let failed = false;
      try {
        if (options.beforeDispatch && !await options.beforeDispatch()) {
          await delay(options.idleMs, options.signal);
          continue;
        }
        if (options.signal.aborted) break;
        worked = await withLogContext({component:options.component??'worker_pool'},()=>runOne(worker));
        previousFailure=undefined;
      } catch (error) {
        failed = true;
        const classified=classifyLogError(error),signature=JSON.stringify(classified);
        if(signature!==previousFailure){withLogContext({component:options.component??'worker_pool'},()=>logEvent('worker.dispatch.failed',{level:'error',...classified}));previousFailure=signature;}
        options.onError?.(error, worker);
      }
      if (!worked || failed) {
        await delay(failed ? (options.errorDelayMs ?? 5000) : options.idleMs, options.signal);
      }
    }
  });
  await Promise.all(loops);
}
