/**
 * 职责：通用任务轮询：控制并发、空闲等待、错误退避和退出信号，不承载业务阶段规则。
 * 关键方法与用途：`runWorkerPool()` 轮询与停止；`createFairQueueHandler()` 公平轮转；`createSharedQueueProbe()` 合并空探测；`watchWorkerBatchInput()` 将临时批次管道EOF转换为仅停止领取的信号。
 * 使用场景：由 `worker.ts` 注册业务 handler；本模块不决定各业务阶段规则。
 */
import {classifyLogError,logEvent,withLogContext} from './logging';
const activeHandlers=new Map<symbol,{component:string;started:number}>();
/** 临时批次的私有stdin关闭时只请求排空；此signal只供领取循环使用，不能传给在途模型。 */
export function watchWorkerBatchInput(input:ReadableStream<Uint8Array>){
  const controller=new AbortController(),reader=input.getReader();let released=false;
  const finished=(async()=>{
    try{while(!(await reader.read()).done){/* 仅EOF表示父执行器结束，不接受命令内容。 */}}
    catch(error){logEvent('worker.batch_control_failed',{level:'error',...classifyLogError(error)});}
    finally{
      controller.abort();released=true;reader.releaseLock();
      logEvent('service.shutdown_requested',{level:'info',reason_code:'batch_input_closed',state:'draining'});
    }
  })();
  return{signal:controller.signal,async close(){if(!released)await reader.cancel();await finished;}};
}
export interface WorkerPoolOptions {
  concurrency: number;
  signal: AbortSignal;
  idleMs: number;
  errorDelayMs?: number;
  beforeDispatch?: () => Promise<boolean>;
  onError?: (error: unknown, worker: number) => void;
  component?: string;
}

/** 合并同一进程的并发探测，只缓存空结果；有任务时仍由各消费者独立领取，绝不共享已领取任务。 */
export function createSharedQueueProbe(probe:()=>Promise<boolean>,emptyMs=3000,now=Date.now){
  let pending:Promise<boolean>|undefined,emptyUntil=0;
  return async()=>{
    if(now()<emptyUntil)return false;
    if(pending)return pending;
    pending=(async()=>{
      try{const available=await Promise.resolve().then(probe);if(!available)emptyUntil=now()+emptyMs;return available;}
      finally{pending=undefined;}
    })();
    return pending;
  };
}

/** 按轮转顺序探测队列；成功消费后从下一类开始，避免持续繁忙的前置队列饿死后续队列。 */
export function createFairQueueHandler(queues:readonly (()=>Promise<boolean>)[],signal?:AbortSignal){
  if(!queues.length)throw new RangeError('at least one worker queue is required');
  let cursor=0;
  return async()=>{
    for(let offset=0;offset<queues.length;offset++){
      if(signal?.aborted)return false;
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

/** worker入口使用的一次性停止请求；宽限结束只报告未完成，不强杀或提前宣布退出。 */
export function createWorkerShutdown(controller:AbortController,graceMs=10000){
  let requested=false,timer:ReturnType<typeof setTimeout>|undefined;
  return{
    request(signal:'SIGINT'|'SIGTERM'){
      if(requested)return;
      requested=true;
      logEvent('service.shutdown_requested',{level:'info',signal});
      controller.abort(Object.assign(new Error('worker停止'),{reason_code:'worker_shutdown'}));
      timer=setTimeout(()=>{
        logEvent('service.shutdown_incomplete',{level:'error',reason_code:'shutdown_incomplete',elapsed_ms:graceMs});
        for(const active of activeHandlers.values())logEvent('worker.dispatch.stopping',{level:'error',component:active.component,process_state:'handler_pending',elapsed_ms:Math.round(performance.now()-active.started)});
      },graceMs);
      timer.unref();
    },
    dispose(){clearTimeout(timer);},
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
        const token=Symbol(),component=options.component??'worker_pool';
        activeHandlers.set(token,{component,started:performance.now()});
        try{worked = await withLogContext({component},()=>runOne(worker));}
        finally{activeHandlers.delete(token);}
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
