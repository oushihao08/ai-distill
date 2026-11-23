// Worker 内的批次调度循环。持久状态决定后继，通知仅用于缩短等待。
import { HTTPException } from 'hono/http-exception';
import { isTransientCommitFailure } from '../execution-queue/runtime';
import { channel, dependency } from './manifest';
import { BatchStore, type Entry, type Result } from './store';
export class DeliveryReceiptError extends Error {
  constructor(
    message: string,
    readonly state: 'failed' | 'unknown',
    readonly result: Result
  ) {
    super(message);
  }
}
export interface BatchBackend {
  capacity(): { agent: number; waiting: number; delivery: number };
  start(e: Entry, parent?: Result): Promise<{ id: string }>;
  check(
    e: Entry
  ): Promise<{ state: 'working' | 'succeeded' | 'failed' | 'unknown'; result?: Result; error?: string }>;
  deliver(e: Entry, parent?: Result): Promise<Result>;
  queued(e: Entry): boolean;
}
type Batch = ReturnType<BatchStore['show']>;
function score(e: Entry, b: Batch, now: number, slots: number) {
  const loads = new Map<string, number>();
  let total = 0,
    occupied = 0;
  for (const r of b.items) {
    if (
      channel(r.task) !== channel(e.task) ||
      !['pending', 'dispatching', 'submitted', 'delivering'].includes(r.state)
    )
      continue;
    const runStart = r.task.type === 'deliver' ? r.started : r.running_at;
    const elapsed = runStart ? Math.max(0, now - runStart) / 60000 : 0;
    const work = r.task.weight * Math.max(r.task.expected_minutes * 0.05, r.task.expected_minutes - elapsed);
    total += work;
    loads.set(r.task.type, (loads.get(r.task.type) ?? 0) + work);
    if (r.task.type === e.task.type && r.state !== 'pending') occupied++;
  }
  return (slots * (loads.get(e.task.type) ?? 0)) / (total || 1) - occupied;
}
const failed = new Set(['blocked', 'failed', 'unknown', 'stopped']);
export class BatchScheduler {
  private deliveries = new Map<string, Promise<void>>();
  private retryAfter = new Map<string, number>();
  private owner = crypto.randomUUID();
  private busy?: Promise<void>;
  private dirty = false;
  constructor(
    readonly store: BatchStore,
    readonly backend: BatchBackend,
    readonly wakeWorkers: () => void = () => {},
    readonly signal?: AbortSignal
  ) {}
  wake() {
    this.dirty = true;
    if (!this.busy)
      this.busy = Promise.resolve()
        .then(async () => {
          while (this.dirty) {
            this.dirty = false;
            await this.tick();
          }
        })
        .finally(() => {
          this.busy = undefined;
        });
    return this.busy;
  }
  async close() {
    await this.busy;
    await Promise.allSettled(this.deliveries.values());
    await this.busy;
    this.store.db.query('DELETE FROM dispatch_leader WHERE token=?').run(this.owner);
  }
  private async tick() {
    if (this.signal?.aborted) return;
    const batches = this.store.list(true);
    if (!batches.length || !this.store.elect(this.owner)) return;
    // 一次循环只核实本机尚待确认的业务回执；运行中的执行不搬运结果。
    for (const b of batches) {
      for (const e of this.store.show(b.id).items) {
        if (e.state === 'delivering' && !this.deliveries.has(e.token)) {
          this.store.update(e, 'unknown', { error: '交付进程已中断，须按原目标回读核对' });
          continue;
        }
        if (e.state === 'dispatching') {
          if (!this.signal?.aborted && (this.retryAfter.get(e.token) ?? 0) <= Date.now())
            await this.submit(e, this.parent(e));
          continue;
        }
        if (e.state !== 'submitted') continue;
        const s = await this.backend.check(e);
        if (s.state !== 'working') this.store.update(e, s.state, { result: s.result, error: s.error });
      }
    }
    while (!this.signal?.aborted) {
      const capacity = this.backend.capacity(),
        candidate: { e: Entry; b: Batch; deficit: number; parent?: Result }[] = [];
      let changed = false;
      for (const { id } of batches) {
        const b = this.store.show(id),
          byId = new Map(b.items.map((t) => [t.id, t]));
        const occupied = b.items.filter((r) => ['dispatching', 'submitted', 'delivering'].includes(r.state));
        const activeAgent = occupied.filter((r) => channel(r.task) === 'agent');
        const waitingAgent = activeAgent.filter((r) => this.backend.queued(r)).length;
        const newlyReady: Entry[] = [];
        for (const e of b.items) {
          if (e.state !== 'pending') continue;
          const dep = dependency(e.task),
            parent = dep ? byId.get(dep) : undefined;
          if (parent && failed.has(parent.state)) {
            changed = this.store.update(e, 'blocked', { error: '上游 ' + dep + ' ' + parent.state }) || changed;
            continue;
          }
          if (parent && parent.state !== 'succeeded') continue;
          if (e.ready === null) {
            e.ready = Date.now();
            newlyReady.push(e);
          }
          if (b.state !== 'active') continue;
          const delivery = e.task.type === 'deliver',
            slots = delivery
              ? Math.min(capacity.delivery, b.limits.delivery)
              : Math.min(capacity.agent, b.limits.agent ?? capacity.agent);
          const waiting = b.limits.waiting ?? slots;
          if (
            delivery
              ? this.deliveries.size >= capacity.delivery || occupied.length - activeAgent.length >= slots
              : capacity.waiting <= 0 || activeAgent.length >= slots + waiting || waitingAgent >= waiting
          )
            continue;
          candidate.push({ e, b, deficit: 0, parent: parent?.result ?? undefined });
        }
        if (newlyReady.length) {
          this.store.db
            .transaction(() => {
              const mark = this.store.db.query(
                "UPDATE dispatch_tasks SET ready=? WHERE token=? AND ready IS NULL AND state='pending'"
              );
              for (const e of newlyReady) mark.run(e.ready, e.token);
            })
            .immediate();
        }
      }
      // 同一阶段的缺口只计算一次；阶段内先取权重高与先就绪项。
      const scores = new Map<string, number>();
      for (const c of candidate) {
        const key = c.b.id + ':' + c.e.task.type;
        if (!scores.has(key))
          scores.set(
            key,
            score(
              c.e,
              c.b,
              Date.now(),
              channel(c.e.task) === 'agent'
                ? Math.min(capacity.agent, c.b.limits.agent ?? capacity.agent)
                : Math.min(capacity.delivery, c.b.limits.delivery)
            )
          );
        c.deficit = scores.get(key)!;
      }
      candidate.sort(
        (a, b) => b.deficit - a.deficit || b.e.task.weight - a.e.task.weight || a.e.ready! - b.e.ready!
      );
      const next = candidate[0];
      if (!next) {
        if (changed) continue;
        break;
      }
      const { e, parent } = next;
      if (e.task.type === 'deliver') {
        if (!this.store.update(e, 'delivering')) continue;
        const row = { ...e, state: 'delivering' as const };
        const work = Promise.resolve()
          .then(() => this.backend.deliver(row, parent))
          .then(
            (result) => {
              this.store.update(row, 'succeeded', { result });
            },
            (err) => {
              this.store.update(
                row,
                err instanceof DeliveryReceiptError
                  ? err.state
                  : err instanceof HTTPException && err.status < 500
                    ? 'failed'
                    : 'unknown',
                {
                  error:
                    err instanceof HTTPException || err instanceof DeliveryReceiptError
                      ? err.message
                      : '交付未取得可核对成功回执，须核对原目标',
                  result: err instanceof DeliveryReceiptError ? err.result : undefined
                }
              );
            }
          )
          .finally(() => {
            this.deliveries.delete(e.token);
            this.wakeWorkers();
          });
        this.deliveries.set(e.token, work);
      } else {
        if (!this.store.update(e, 'dispatching', { job: e.token })) continue;
        if (!(await this.submit({ ...e, state: 'dispatching', job: e.token }, parent))) break;
      }
    }
    for (const b of batches) this.store.settle(b.id);
  }
  private parent(e: Entry) {
    const id = dependency(e.task);
    return id ? (this.store.show(e.batch).items.find((x) => x.id === id)?.result ?? undefined) : undefined;
  }
  private async submit(e: Entry, parent?: Result) {
    try {
      const job = await this.backend.start(e, parent);
      this.retryAfter.delete(e.token);
      this.store.update(e, 'submitted', { job: job.id });
      this.wakeWorkers();
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'local_queue_full') {
        const stopped = this.store.db
          .query("SELECT 1 FROM dispatch_batches WHERE id=? AND state='stopping'")
          .get(e.batch);
        this.store.update(e, stopped ? 'stopped' : 'pending');
        return false;
      }
      if (error instanceof HTTPException && error.status < 500)
        this.store.update(e, 'failed', { error: error.message });
      else if (isTransientCommitFailure(error)) {
        // 原幂等键恢复，不让单项的数据库断连阻塞其他分支。
        this.retryAfter.set(e.token, Date.now() + 5000);
      } else this.store.update(e, 'unknown', { error: '业务派发回执待核实，请按本项请求 ID 核对' });

      return true;
    }
  }
}
