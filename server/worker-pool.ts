export interface WorkerPoolOptions {
  concurrency: number;
  signal: AbortSignal;
  idleMs: number;
  errorDelayMs?: number;
  beforeDispatch?: () => Promise<boolean>;
  onError?: (error: unknown, worker: number) => void;
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

export async function runWorkerPool(
  runOne: (worker: number) => Promise<boolean>,
  options: WorkerPoolOptions,
) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('worker concurrency must be a positive integer');
  }
  const loops = Array.from({ length: options.concurrency }, async (_, worker) => {
    while (!options.signal.aborted) {
      let worked = false;
      let failed = false;
      try {
        if (options.beforeDispatch && !await options.beforeDispatch()) {
          await delay(options.idleMs, options.signal);
          continue;
        }
        if (options.signal.aborted) break;
        worked = await runOne(worker);
      } catch (error) {
        failed = true;
        options.onError?.(error, worker);
      }
      if (!worked || failed) {
        await delay(failed ? (options.errorDelayMs ?? 5000) : options.idleMs, options.signal);
      }
    }
  });
  await Promise.all(loops);
}
