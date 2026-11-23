// HTTP 是工作台和 CLI 的统一批次入口；清单启动后不再读取外部文件。
import type { Hono, Context } from 'hono';
import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { localQueueEnabled, localQueue } from '../execution-queue/runtime';
import { BatchStore } from './store';
import { validateManifest, validateLimits, dependency, type Manifest } from './manifest';
import type { LocalQueue } from '../execution-queue/store';
export async function inspectScope(pool: Pool, m: Manifest) {
  const project = new Set<string>(),
    workflow = new Map<string, string>(),
    revisions = new Map<string, string>(),
    links = new Map<string, string>(),
    extracts = new Map<string, string>(),
    redactions = new Map<string, string>(),
    attempts = new Map<string, string>();
  function bind(map: Map<string, string>, id: string, owner: string) {
    if (map.has(id) && map.get(id) !== owner)
      throw new HTTPException(409, { message: '清单包含相互冲突的归属 ' + id });
    map.set(id, owner);
  }
  for (const t of m.tasks) {
    const i = t.input;
    project.add(i.project_id);
    if (i.workflow_id) bind(workflow, i.workflow_id, i.project_id);
    if (i.package_id && i.revision_id) bind(revisions, i.revision_id, i.package_id);
    if (i.link_id) bind(links, i.link_id, i.project_id);
    if (i.extraction_job_id && i.revision_id) bind(extracts, i.extraction_job_id, i.revision_id);
    if (i.redaction_id && i.revision_id) bind(redactions, i.redaction_id, i.revision_id);
    if (i.author_attempt_id && i.workflow_id) bind(attempts, i.author_attempt_id, i.workflow_id);
  }
  const checks: [Map<string, string>, string][] = [
    [
      new Map([...project].map((id) => [id, id])),
      'SELECT id,id AS owner FROM ai_distill.projects WHERE id=ANY($1) AND deleted_at IS NULL'
    ],
    [
      extracts,
      "SELECT id,revision_id AS owner FROM ai_distill.library_jobs WHERE id=ANY($1) AND kind='extract' AND status='succeeded'"
    ],
    [
      redactions,
      "SELECT id,revision_id AS owner FROM ai_distill.library_redactions WHERE id=ANY($1) AND validation_report->>'usable_for_question'='true'"
    ],
    [
      attempts,
      "SELECT id,workflow_id AS owner FROM ai_distill.step_attempts WHERE id=ANY($1) AND ordinal=4 AND status='succeeded'"
    ],
    [workflow, 'SELECT id,project_id AS owner FROM ai_distill.workflows WHERE id=ANY($1) AND deleted_at IS NULL'],
    [
      revisions,
      "SELECT id,package_id AS owner FROM ai_distill.library_revisions WHERE id=ANY($1) AND state='ready'"
    ],
    [
      links,
      'SELECT id,project_id AS owner FROM ai_distill.project_library_packages WHERE id=ANY($1) AND removed_at IS NULL'
    ]
  ];
  for (const [ids, sql] of checks) {
    if (!ids.size) continue;
    const rows = await pool.query(sql, [[...ids.keys()]]);
    for (const row of rows.rows) if (ids.get(row.id) === row.owner) ids.delete(row.id);
    if (ids.size)
      throw new HTTPException(409, {
        message: '清单目标不存在或归属不同：' + [...ids.keys()].slice(0, 5).join('、')
      });
  }
}
export function describe(store: BatchStore, q: LocalQueue, id: string) {
  const b = store.show(id),
    states = new Map(b.items.map((e) => [e.id, e.state])),
    counts: Record<string, number> = {};
  const by_stage: Record<string, Record<string, number>> = {};
  const queueStates = new Map(
    (
      q.db
        .query('SELECT t.id,j.state FROM dispatch_tasks t JOIN jobs j ON j.id=t.job WHERE t.batch=?')
        .all(id) as { id: string; state: string }[]
    ).map((row) => [row.id, row.state])
  );
  const items = b.items.map((e) => {
    const dep = dependency(e.task),
      local = queueStates.get(e.id);
    const state =
      e.state === 'submitted'
        ? local === 'committed'
          ? 'checking_receipt'
          : (local ?? 'checking_receipt')
        : e.state === 'pending'
          ? dep && states.get(dep) !== 'succeeded'
            ? 'waiting_dependency'
            : 'ready'
          : e.state;
    counts[state] = (counts[state] ?? 0) + 1;
    const stage = (by_stage[e.task.type] ??= {});
    stage[state] = (stage[state] ?? 0) + 1;
    return {
      id: e.id,
      type: e.task.type,
      owner: e.task.owner ?? null,
      input: e.task.input,
      weight: e.task.weight,
      expected_minutes: e.task.expected_minutes,
      state,
      batch_task_state: e.state,
      request_id: e.token,
      depends_on: dep ?? null,
      job_id: e.job,
      result: e.result,
      error: e.error,
      ready_at: e.ready,
      dispatched_at: e.started,
      running_at: e.running_at,
      finished_at: e.finished
    };
  });
  return { id: b.id, state: b.state, limits: b.limits, total: items.length, counts, by_stage, items };
}
export function registerBatchRoutes(app: Hono, pool: Pool, root: string) {
  const storage = () => {
    if (!localQueueEnabled()) throw new HTTPException(409, { message: '批次调度需要 local 执行队列' });
    const q = localQueue(root);
    return { q, s: new BatchStore(q.db) };
  };
  const manifest = async (c: Context) => {
    const v = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: '清单 JSON 无效' });
    });
    return validateManifest(v);
  };
  app.post('/api/dispatch-batches/preview', async (c) => {
    const m = await manifest(c);
    await inspectScope(pool, m);
    return c.json({
      manifest: m,
      counts: Object.fromEntries(
        ['redact', 'prepare', 'author', 'deliver'].map((k) => [k, m.tasks.filter((t) => t.type === k).length])
      )
    });
  });
  app.post('/api/dispatch-batches', async (c) => {
    const m = await manifest(c),
      { s, q } = storage();
    if (!s.db.query('SELECT 1 FROM dispatch_batches WHERE id=?').get(m.id)) await inspectScope(pool, m);
    s.start(m);
    return c.json(describe(s, q, m.id), 202);
  });
  app.get('/api/dispatch-batches', (c) => c.json(storage().s.list()));
  app.get('/api/dispatch-batches/:id', (c) => {
    const { s, q } = storage(),
      { items, ...summary } = describe(s, q, c.req.param('id')),
      state = c.req.query('state');
    return c.json(
      c.req.query('summary') === '1'
        ? summary
        : { ...summary, items: state ? items.filter((item) => item.state === state) : items }
    );
  });
  app.put('/api/dispatch-batches/:id/limits', async (c) => {
    const { s, q } = storage(),
      id = c.req.param('id');
    s.configure(id, validateLimits(await c.req.json()));
    return c.json(describe(s, q, id));
  });
  app.post('/api/dispatch-batches/:id/stop', (c) => {
    const { s, q } = storage(),
      id = c.req.param('id');
    s.stop(id);
    return c.json(describe(s, q, id));
  });
  app.get('/api/dispatch-batches/:id/events', (c) => {
    const { s } = storage(),
      id = c.req.param('id'),
      after = Number(c.req.query('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HTTPException(400, { message: 'after 应为非负整数' });
    const events = s.db
      .query('SELECT seq,task,state,at FROM dispatch_events WHERE batch=? AND seq>? ORDER BY seq LIMIT 500')
      .all(id, after) as { seq: number }[];
    return c.json({ id, events, next: events.at(-1)?.seq ?? after });
  });
}
