// 隔离的本机执行队列与业务替身，逐流程验证调度、范围、恢复、限额与交付副作用。
import { expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { LocalQueue } from '../execution-queue/store';
import { BatchStore, type Entry, type Result } from './store';
import { BatchScheduler, type BatchBackend } from './scheduler';
import { validateManifest, type Task } from './manifest';
import { describe } from './routes';
const project = crypto.randomUUID(),
  pkg = crypto.randomUUID(),
  revision = crypto.randomUUID(),
  ext = crypto.randomUUID(),
  wf = crypto.randomUUID(),
  attempt = crypto.randomUUID();
const task = (id: string, type: Task['type'], input: object) => ({
  id,
  type,
  owner: '张某',
  input: { project_id: project, ...input }
});
const r = task('r', 'redact', { package_id: pkg, revision_id: revision, extraction_job_id: ext });
const p = task('p', 'prepare', { package_id: pkg, revision_id: revision, redaction_from: 'r' });
const a = task('a', 'author', { workflow_id: wf, material_from: 'p' });
const target = { mode: 'draft', base_token: 'testbase000001', table_id: 'tbl00000001' };
const d = task('d', 'deliver', { ...target, author_from: 'a' });
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(tasks: unknown[], limits = { agent: 2, waiting: 2, delivery: 2 }) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
  roots.push(dir);
  const q = new LocalQueue(dir, crypto.randomUUID()),
    s = new BatchStore(q.db),
    id = crypto.randomUUID();
  const start = () => s.start(validateManifest({ version: 1, id, limits, tasks }));
  start();
  const requests = new Map<string, Result | undefined>(),
    delivered: string[] = [];
  const backend: BatchBackend = {
    capacity: () => ({ agent: 4, waiting: q.capacity('agent', 4).available, delivery: 2 }),
    queued: (e) => q.get(e.job!)?.state === 'queued',
    async start(e, parent) {
      requests.set(e.id, parent);
      q.intent(e.token, 'step', 'agent', 'fixture');
      q.confirm(e.token);
      return { id: e.token };
    },
    async check(e) {
      const state = q.get(e.job!)!.state;
      if (state === 'failed') return { state, error: '失败样例' };
      if (state !== 'committed') return { state: 'working' };
      const result =
        e.task.type === 'author'
          ? { workflow_id: wf, author_attempt_id: e.token, question_version: 'v1' }
          : {
              package_id: pkg,
              revision_id: revision,
              redaction_id: 'redaction-result',
              ...(e.task.type === 'prepare' ? { preparation_id: e.token } : {})
            };
      return { state: 'succeeded', result };
    },
    async deliver(e, parent) {
      delivered.push(e.id);
      requests.set(e.id, parent);
      return { receipt: { record_id: 'test' } };
    }
  };
  const worker = new BatchScheduler(s, backend);
  const finish = async (fail = false) => {
    const job = q.claim('agent');
    expect(job).toBeTruthy();
    q.finish(job!.id, job!.lease!, fail ? 'failed' : 'committed');
    await worker.wake();
    return job!.id;
  };
  const drain = async () => {
    for (let n = 0; n < 30; n++) {
      await worker.wake();
      if (!s.list(true).length) return;
      if (q.pending('agent').length) await finish();
    }
    throw new Error('未排空');
  };
  return { q, s, id, backend, worker, finish, drain, start, requests, delivered };
}
for (const [name, tasks] of Object.entries({
  redact: [r],
  prepare: [task('p', 'prepare', { package_id: pkg, revision_id: revision, extraction_job_id: ext })],
  author: [task('a', 'author', { workflow_id: wf })],
  deliver: [task('d', 'deliver', { ...target, workflow_id: wf, author_attempt_id: attempt })],
  full: [d, a, p, r],
  redactAuthor: [r, task('a', 'author', { workflow_id: wf, material_from: 'r' })],
  authorDeliver: [task('a', 'author', { workflow_id: wf }), d]
})) {
  test('独立或组合流程 ' + name, async () => {
    const f = fixture(tasks);
    await f.drain();
    expect(f.s.show(f.id).state).toBe('succeeded');
    expect(f.requests.size).toBe(tasks.length);
    if (name === 'full') {
      expect(f.requests.get('p')?.redaction_id).toBe('redaction-result');
      expect(f.requests.get('a')?.preparation_id).toBeTruthy();
      expect(f.requests.get('d')?.author_attempt_id).toBeTruthy();
      expect(describe(f.s, f.q, f.id).counts).toEqual({ succeeded: 4 });
    }
    await f.worker.close();
    f.q.db.close();
  });
}
test('错误的来源、重复目标、提取和未知字段在入队前拒绝', () => {
  const validate = (tasks: unknown[]) => validateManifest({ version: 1, id: crypto.randomUUID(), tasks });
  for (const items of [
    [p],
    [r, r],
    [{ ...r, type: 'extract' }],
    [{ ...a, error: 'ignored' }],
    [r, { ...p, input: { ...p.input, package_id: wf } }],
    [{ ...r, weight: 0 }]
  ])
    expect(() => validate(items)).toThrow();
});
test('一份材料用于两题，失败阻止相关后继，独立任务继续', async () => {
  const x = task('x', 'author', { workflow_id: crypto.randomUUID() });
  const f = fixture([r, p, a, task('b', 'author', { workflow_id: crypto.randomUUID(), material_from: 'p' }), x]);
  await f.worker.wake();
  const er = f.s.show(f.id).items.find((t) => t.id === 'r')!;
  const leased = f.q.claim('agent', [er.job!])!;
  f.q.finish(leased.id, leased.lease!, 'failed');
  await f.drain();
  expect(describe(f.s, f.q, f.id).counts).toEqual({ failed: 1, blocked: 3, succeeded: 1 });
  f.q.db.close();
});
test('批次重放、重启接续和交付未知不重写', async () => {
  const f = fixture([r, p]);
  await f.worker.wake();
  f.start();
  expect(f.s.list()).toHaveLength(1);
  const job = f.q.claim('agent')!;
  f.q.finish(job.id, job.lease!, 'committed');
  await f.worker.close();
  const recovered = new BatchScheduler(f.s, f.backend);
  await recovered.wake();
  expect(f.s.show(f.id).items.find((x) => x.id === 'p')?.state).toBe('submitted');
  expect(f.requests.size).toBe(2);
  await recovered.close();
  f.q.db.close();
  const d0 = fixture([task('d', 'deliver', { ...target, workflow_id: wf, author_attempt_id: attempt })]);
  const item = d0.s.show(d0.id).items[0]!;
  d0.s.update(item, 'delivering');
  await d0.worker.wake();
  expect(d0.s.show(d0.id).items[0]?.state).toBe('unknown');
  expect(d0.delivered).toHaveLength(0);
  d0.q.db.close();
});
test('权重与槽位在原子领取时生效，可预排且停止后不再续派', async () => {
  const items = Array.from({ length: 6 }, (_, n) => ({
    ...task('a' + n, 'author', { workflow_id: crypto.randomUUID() }),
    weight: n === 4 ? 3 : 1
  }));
  const f = fixture(items, { agent: 1, waiting: 2, delivery: 1 });
  await f.worker.wake();
  expect([...f.requests.keys()][0]).toBe('a4');
  expect(f.q.pending('agent')).toHaveLength(2);
  const j = f.q.claim('agent')!;
  expect(f.q.claim('agent')).toBeNull();
  await f.worker.wake();
  expect(f.q.pending('agent')).toHaveLength(2);
  f.s.stop(f.id);
  f.q.finish(j.id, j.lease!, 'committed');
  await f.drain();
  expect(f.s.show(f.id).state).toBe('stopped');
  expect(f.requests.size).toBe(3);
  f.q.db.close();
});
test('送达回执失败可查询原因且不自动再次提交', async () => {
  const f = fixture([task('d', 'deliver', { ...target, workflow_id: wf, author_attempt_id: attempt })]);
  let tries = 0;
  f.backend.deliver = async () => {
    tries++;
    throw new HTTPException(409, { message: '版本过期' });
  };
  await f.drain();
  expect(f.s.show(f.id).items[0]?.error).toBe('版本过期');
  expect(tries).toBe(1);
  f.q.db.close();
});
test('活跃批次下调运行上限时排空、上调时补满，清单重放保留调整', async () => {
  const f = fixture(
    Array.from({ length: 8 }, (_, n) => task('a' + n, 'author', { workflow_id: crypto.randomUUID() })),
    { agent: 3, waiting: 4, delivery: 1 }
  );
  await f.worker.wake();
  const busy = [f.q.claim('agent')!, f.q.claim('agent')!];
  f.s.configure(f.id, { agent: 1, waiting: 1, delivery: 1 });
  f.start();
  expect(f.s.show(f.id).limits.agent).toBe(1);
  expect(f.q.claim('agent')).toBeNull();
  f.q.finish(busy[0]!.id, busy[0]!.lease!, 'committed');
  expect(f.q.claim('agent')).toBeNull();
  f.s.configure(f.id, { agent: 4, waiting: 4, delivery: 1 });
  await f.worker.wake();
  expect(f.q.claim('agent')).toBeTruthy();
  await f.worker.close();
  f.q.db.close();
});
test('两名调度者竞争只派一次、清单重放不会扩大授权', async () => {
  const f = fixture([r, p]),
    second = new BatchScheduler(f.s, f.backend);
  await Promise.all([f.worker.wake(), second.wake()]);
  expect(f.q.list()).toHaveLength(1);
  const changed = validateManifest({ version: 1, id: f.id, tasks: [r] });
  expect(() => f.s.start(changed)).toThrow('另一份');
  await second.close();
  await f.worker.close();
  f.q.db.close();
});
test('两个上游分支的同阶段优先级由剩余工时与任务权重决定', async () => {
  const f = fixture([task('author', 'author', { workflow_id: wf }), { ...r, expected_minutes: 35 }], {
    agent: 1,
    waiting: 1,
    delivery: 1
  });
  await f.worker.wake();
  expect([...f.requests.keys()]).toEqual(['r']);
  await f.worker.close();
  f.q.db.close();
});
test('连续领取和依赖放行的延迟独立采样', async () => {
  const { runWorkerPool } = await import('../worker-pool');
  const tasks = Array.from({ length: 40 }, (_, n) => [
    task('a' + n, 'author', { workflow_id: crypto.randomUUID() }),
    task('d' + n, 'deliver', { ...target, author_from: 'a' + n })
  ]).flat();
  const f = fixture(tasks, { agent: 1, waiting: 2, delivery: 1 }),
    stop = new AbortController();
  let idle = new AbortController(),
    lastEnd = 0;
  const gaps: number[] = [],
    links: number[] = [],
    end = new Map<string, number>();
  const wake = () => {
    const old = idle;
    idle = new AbortController();
    old.abort();
  };
  const w = new BatchScheduler(f.s, f.backend, () => {
    wake();
    void w.wake();
  });
  const deliver = f.backend.deliver;
  f.backend.deliver = async (e, parent) => {
    links.push(performance.now() - end.get(e.task.input.author_from!)!);
    return deliver(e, parent);
  };
  const guard = setTimeout(() => stop.abort(), 5000);
  try {
    const run = runWorkerPool(
      async () => {
        const job = f.q.claim('agent');
        if (!job) return false;
        const now = performance.now();
        if (lastEnd) gaps.push(now - lastEnd);
        await w.wake();
        await Bun.sleep(1);
        lastEnd = performance.now();
        end.set(f.s.show(f.id).items.find((t) => t.job === job.id)!.id, lastEnd);
        f.q.finish(job.id, job.lease!, 'committed');
        await w.wake();
        if (end.size === 40) stop.abort();
        return true;
      },
      { component: 'fixture', idleWake: () => idle.signal, idleMs: 3000, concurrency: 1, signal: stop.signal }
    );
    await w.wake();
    await run;
    await w.wake();
    await w.close();
    expect(f.s.show(f.id).state).toBe('succeeded');
    expect(gaps.length).toBe(39);
    expect(links.length).toBe(40);
    const p95 = (a: number[]) => a.sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1]!;
    const timings = { release_to_claim_ms: p95(gaps), commit_to_delivery_ms: p95(links) };
    console.log('合成验收 P95', JSON.stringify(timings));
    expect(Math.max(...Object.values(timings))).toBeLessThan(2000);
  } finally {
    stop.abort();
    clearTimeout(guard);
    f.q.db.close();
  }
});
test('另一个进程在交付中退出后，接管者保留待核状态并继续其他题', async () => {
  const f = fixture([
    task('a', 'author', { workflow_id: wf }),
    task('d', 'deliver', { ...target, workflow_id: wf, author_attempt_id: attempt })
  ]);
  const { spawnSync } = await import('node:child_process');
  const code = `import {Database} from 'bun:sqlite';import {BatchStore} from ${JSON.stringify(import.meta.resolve('./store'))};
 const s=new BatchStore(new Database(process.argv[1]));if(!s.elect('previous-process'))process.exit(1);
 s.update(s.show(process.argv[2]).items.find(t=>t.id==='d'),'delivering');process.exit(23);`;
  const child = spawnSync(process.execPath, ['-e', code, join(f.q.root, 'runtime/queue.sqlite3'), f.id], {
    encoding: 'utf8'
  });
  expect(child.status).toBe(23);
  await f.drain();
  expect(describe(f.s, f.q, f.id).counts).toEqual({ succeeded: 1, unknown: 1 });
  expect(f.delivered).toHaveLength(0);
  await f.worker.close();
  f.q.db.close();
});
