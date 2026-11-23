// 本机批次与分项状态；同一个 SQLite 文件供 API 与 Worker 读写，不跨执行节点认领。
import type { Database } from 'bun:sqlite';
import { HTTPException } from 'hono/http-exception';
import { canonicalJson } from '../../shared/workflow-config';
import type { Manifest, Task } from './manifest';
export const batchSchema = `
 CREATE TABLE IF NOT EXISTS dispatch_batches(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,agent_limit INTEGER);
 CREATE TABLE IF NOT EXISTS dispatch_tasks(batch TEXT NOT NULL,id TEXT NOT NULL,token TEXT NOT NULL UNIQUE,job TEXT,state TEXT NOT NULL,
 result TEXT,error TEXT,started INTEGER,ready INTEGER,finished INTEGER,PRIMARY KEY(batch,id));
 CREATE INDEX IF NOT EXISTS dispatch_jobs ON dispatch_tasks(job);
 CREATE INDEX IF NOT EXISTS dispatch_states ON dispatch_batches(state);
 CREATE TABLE IF NOT EXISTS dispatch_commits(job TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS dispatch_limits(batch TEXT PRIMARY KEY,limits TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS dispatch_events(seq INTEGER PRIMARY KEY,batch TEXT NOT NULL,task TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS dispatch_history ON dispatch_events(batch,seq);
 CREATE INDEX IF NOT EXISTS dispatch_task_running ON dispatch_events(batch,task,at) WHERE state='running';
 CREATE TRIGGER IF NOT EXISTS dispatch_created AFTER INSERT ON dispatch_tasks
 BEGIN INSERT INTO dispatch_events(batch,task,state,at) VALUES(NEW.batch,NEW.id,NEW.state,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
 CREATE TRIGGER IF NOT EXISTS dispatch_ready AFTER UPDATE OF ready ON dispatch_tasks WHEN OLD.ready IS NULL AND NEW.ready IS NOT NULL
 BEGIN INSERT INTO dispatch_events(batch,task,state,at) VALUES(NEW.batch,NEW.id,'ready',NEW.ready); END;
 CREATE TRIGGER IF NOT EXISTS dispatch_transition AFTER UPDATE OF state ON dispatch_tasks WHEN OLD.state<>NEW.state
 BEGIN INSERT INTO dispatch_events(batch,task,state,at) VALUES(NEW.batch,NEW.id,NEW.state,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
 CREATE TABLE IF NOT EXISTS dispatch_leader(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL);`;
export type State =
  | 'pending'
  | 'dispatching'
  | 'submitted'
  | 'delivering'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'blocked'
  | 'stopped';
export type Result = {
  package_id?: string;
  revision_id?: string;
  redaction_id?: string | null;
  preparation_id?: string;
  extraction_job_id?: string;
  workflow_id?: string;
  author_attempt_id?: string;
  question_version?: string;
  receipt?: unknown;
};
export type Entry = {
  batch: string;
  id: string;
  token: string;
  job: string | null;
  state: State;
  result: Result | null;
  error: string | null;
  started: number | null;
  ready: number | null;
  finished: number | null;
  running_at: number | null;
  task: Task;
};
export class BatchStore {
  constructor(readonly db: Database) {
    db.exec(batchSchema);
  }
  start(m: Manifest) {
    return this.db
      .transaction(() => {
        const prev = this.db.query('SELECT manifest FROM dispatch_batches WHERE id=?').get(m.id) as {
          manifest: string;
        } | null;
        if (prev) {
          if (canonicalJson(JSON.parse(prev.manifest)) !== canonicalJson(m))
            throw new HTTPException(409, { message: '批次 ID 已对应另一份清单' });
          return this.show(m.id);
        }
        this.db
          .query("INSERT INTO dispatch_batches VALUES(?,?,'active',?,?)")
          .run(m.id, JSON.stringify(m), Date.now(), m.limits.agent ?? null);
        const ins = this.db.query("INSERT INTO dispatch_tasks(batch,id,token,state) VALUES(?,?,?,'pending')");
        for (const task of m.tasks) ins.run(m.id, task.id, crypto.randomUUID());
        return this.show(m.id);
      })
      .immediate();
  }
  list(active = false) {
    return this.db
      .query(
        'SELECT id,state,created FROM dispatch_batches ' +
          (active ? "WHERE state IN ('active','stopping') " : '') +
          'ORDER BY created DESC'
      )
      .all() as { id: string; state: string; created: number }[];
  }
  show(id: string) {
    const b = this.db.query('SELECT state,manifest FROM dispatch_batches WHERE id=?').get(id) as {
      state: string;
      manifest: string;
    } | null;
    if (!b) throw new HTTPException(404, { message: '本机没有此批次' });
    const manifest = JSON.parse(b.manifest) as Manifest,
      byId = new Map(manifest.tasks.map((t) => [t.id, t]));
    const items = (
      this.db
        .query(
          `SELECT t.*,(SELECT min(e.at) FROM dispatch_events e WHERE e.batch=t.batch AND e.task=t.id AND e.state='running') AS running_at FROM dispatch_tasks t WHERE t.batch=? ORDER BY t.rowid`
        )
        .all(id) as (Omit<Entry, 'result' | 'task'> & { result: string | null })[]
    ).map((row) => ({
      ...row,
      task: byId.get(row.id)!,
      result: row.result ? (JSON.parse(row.result) as Result) : null
    }));
    const override = this.db.query('SELECT limits FROM dispatch_limits WHERE batch=?').get(id) as {
      limits: string;
    } | null;
    return {
      id,
      state: b.state,
      limits: override ? (JSON.parse(override.limits) as Manifest['limits']) : manifest.limits,
      items
    };
  }
  configure(id: string, limits: Manifest['limits']) {
    this.db
      .transaction(() => {
        if (!this.db.query("SELECT 1 FROM dispatch_batches WHERE id=? AND state='active'").get(id))
          throw new HTTPException(409, { message: '只可调整本机活动批次' });
        this.db.query('INSERT OR REPLACE INTO dispatch_limits VALUES(?,?)').run(id, JSON.stringify(limits));
        this.db.query('UPDATE dispatch_batches SET agent_limit=? WHERE id=?').run(limits.agent ?? null, id);
      })
      .immediate();
  }
  stop(id: string) {
    return this.db
      .transaction(() => {
        this.db.query("UPDATE dispatch_batches SET state='stopping' WHERE id=? AND state='active'").run(id);
        this.db
          .query("UPDATE dispatch_tasks SET state='stopped',finished=? WHERE batch=? AND state='pending'")
          .run(Date.now(), id);
        this.settle(id);
        return this.show(id);
      })
      .immediate();
  }
  settle(id: string) {
    this.db
      .query(
        `UPDATE dispatch_batches SET state=CASE WHEN state='stopping' THEN 'stopped'
   WHEN EXISTS(SELECT 1 FROM dispatch_tasks WHERE batch=?1 AND state!='succeeded') THEN 'incomplete' ELSE 'succeeded' END
   WHERE id=?1 AND state IN ('active','stopping') AND NOT EXISTS(SELECT 1 FROM dispatch_tasks WHERE batch=?1 AND state IN ('pending','dispatching','submitted','delivering'))`
      )
      .run(id);
  }
  update(e: Entry, state: State, opts: { job?: string; result?: Result; error?: string } = {}) {
    const terminal = ['succeeded', 'failed', 'unknown', 'blocked', 'stopped'].includes(state);
    return (
      this.db
        .query(
          `UPDATE dispatch_tasks SET state=?,job=COALESCE(?,job),result=COALESCE(?,result),error=?,
   started=CASE WHEN ? IN ('dispatching','delivering') THEN COALESCE(started,?) ELSE started END,finished=? WHERE batch=? AND id=? AND state=?`
        )
        .run(
          state,
          opts.job ?? null,
          opts.result ? JSON.stringify(opts.result) : null,
          opts.error ?? null,
          state,
          Date.now(),
          terminal ? Date.now() : null,
          e.batch,
          e.id,
          e.state
        ).changes > 0
    );
  }
  elect(token: string) {
    return this.db
      .transaction(() => {
        const row = this.db.query('SELECT pid,token FROM dispatch_leader WHERE id=1').get() as {
          pid: number;
          token: string;
        } | null;
        if (row?.token === token) return true;
        if (row) {
          try {
            process.kill(row.pid, 0);
            return false;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
          }
        }
        this.db.query('INSERT OR REPLACE INTO dispatch_leader VALUES(1,?,?)').run(process.pid, token);
        return true;
      })
      .immediate();
  }
}
