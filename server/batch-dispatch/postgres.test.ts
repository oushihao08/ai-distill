// 可选隔离集成：仅接受新建的 Unix socket 专用空库；四阶段使用真实入队与业务读回，合成模型回包和交付回执。
import { test, expect } from 'bun:test';
import { Pool } from 'pg';
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createLibraryPackage, createLibraryRevision } from '../material-library/service';
import { insertLibraryTextBlob } from '../material-library/storage';
import { enqueueLibraryJob, claimLibraryJob, finishLibraryJob } from '../material-library/jobs';
import { runNextLibraryJob } from '../material-library/runner';
import {
  localQueue,
  withLocalQueueRoot,
  withLocalExecution,
  reconcileRegistrations
} from '../execution-queue/runtime';
import { businessBackend } from './backend';
import { BatchStore } from './store';
import { BatchScheduler } from './scheduler';
import { registerBatchRoutes } from './routes';
import { runCommand } from '../../cli/commands';
import { ApiClient } from '../../cli/client';
const socket = process.env.DISPATCH_TEST_SOCKET;
test.skipIf(!socket)(
  '隔离 PostgreSQL、HTTP、CLI、SQLite 和四步真实业务绑定',
  async () => {
    if (!socket?.startsWith('/tmp/dispatch-verify.') || socket.includes('..'))
      throw Error('需要本次隔离测试的 Unix socket 目录');
    const root = await mkdtemp(join(tmpdir(), 'dispatch-pg-')),
      q = localQueue(root),
      uuid = () => crypto.randomUUID();
    const pool = new Pool({
      host: socket,
      port: 58379,
      database: 'dispatch_verify',
      user: 'postgres',
      application_name: 'ai-distill-executor:' + q.executorId
    });
    const oldMode = process.env.EXECUTION_QUEUE_MODE;
    process.env.EXECUTION_QUEUE_MODE = 'local';
    let server: ReturnType<typeof Bun.serve> | undefined,
      schema = false;
    try {
      expect(
        (await pool.query("SELECT current_database() AS db,to_regnamespace('ai_distill') AS existing")).rows[0]
      ).toEqual({ db: 'dispatch_verify', existing: null });
      await pool.query('CREATE SCHEMA ai_distill');
      schema = true;
      await pool.query(
        'CREATE TABLE ai_distill.schema_migrations(name text primary key,applied_at timestamptz default now())'
      );
      for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
        await pool.query(await readFile(join('migrations', name), 'utf8'));
        await pool.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)', [name]);
      }
      const project = uuid(),
        dir = join(root, 'project'),
        model = { model: 'gpt-6.2-sol', reasoning_effort: 'medium' },
        text = '合成资料：订单货款100元。';
      await mkdir(join(dir, 'skill'), { recursive: true });
      await writeFile(
        join(dir, 'skill', 'SKILL.md'),
        '---\nname: fixture\ndescription: 测试材料。\n---\n按材料出题\n'
      );
      await pool.query('INSERT INTO ai_distill.project_groups(id,name) VALUES($1,$2)', [project, '本机批次验证']);
      await pool.query(
        'INSERT INTO ai_distill.projects(id,name,workspace_path,local_skill_path,project_group_id,parent_name,phase_name) VALUES($1,$2,$3,$4,$1,$2,$2)',
        [project, '本机批次验证', dir, join(dir, 'skill')]
      );
      const pkg = await createLibraryPackage(pool, { name: '调度合成材料' }),
        rev = await createLibraryRevision(pool, root, pkg.id, Number(pkg.lock_version), uuid(), [
          { original_name: '订单.txt', bytes: new TextEncoder().encode(text) }
        ]);
      let extraction = '';
      for (const kind of ['intake', 'extract']) {
        const j = await withLocalQueueRoot(root, () =>
          enqueueLibraryJob(pool, pkg.id, rev.id, { kind, request_key: uuid(), execution_target: 'local' }, root)
        );
        await reconcileRegistrations(pool, q);
        const job = q.claim('internal', [j.id])!;
        await withLocalExecution(q, job, () =>
          runNextLibraryJob(pool, root, 'internal', 'local', new AbortController().signal, job.id)
        );
        q.finish(job.id, job.lease!, 'committed');
        extraction = j.id;
      }
      const app = new Hono();
      registerBatchRoutes(app, pool, root);
      let scopeReads = 0;
      app.get('/scope.json', (c) => {
        scopeReads++;
        return c.json(manifest);
      });
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
      const client = new ApiClient('http://127.0.0.1:' + server.port),
        id = uuid(),
        material = { project_id: project, package_id: pkg.id, revision_id: rev.id, ...model };
      const manifest: Record<string, unknown> = {
        id,
        version: 1,
        tasks: [
          { id: 'r', type: 'redact', owner: '测试员', input: { ...material, extraction_job_id: extraction } },
          { id: 'p', type: 'prepare', input: { ...material, redaction_from: 'r' } },
          {
            id: 'a',
            type: 'author',
            input: {
              project_id: project,
              load_package_id: pkg.id,
              title: '订单货款核验',
              material_from: 'p',
              ...model
            }
          },
          {
            id: 'd',
            type: 'deliver',
            input: {
              project_id: project,
              author_from: 'a',
              mode: 'draft',
              base_token: 'testbase000001',
              table_id: 'tbl00000001'
            }
          }
        ]
      };
      const path = join(root, 'scope.json');
      await writeFile(path, JSON.stringify(manifest));
      for (const cmd of ['preview', 'start', 'start']) {
        const out = await runCommand(['dispatch', cmd, '--file', path], client);
        expect(out.outcome).toBe('complete');
      }
      expect(
        (
          await runCommand(
            ['dispatch', 'start', '--url', 'http://127.0.0.1:' + server.port + '/scope.json'],
            client
          )
        ).outcome
      ).toBe('complete');
      expect(scopeReads).toBe(1);
      const s = new BatchStore(q.db),
        backend = businessBackend(pool, q, 2, 1);
      const realDeliver = backend.deliver;
      let delivered = 0;
      backend.deliver = async (e, parent) => {
        expect(parent?.author_attempt_id).toBeTruthy();
        delivered++;
        return { ...parent, receipt: { record_id: 'fixture' } };
      };
      const scheduler = new BatchScheduler(s, backend);
      await scheduler.wake();
      const hash = (v: string) => createHash('sha256').update(v).digest('hex');
      let redaction = '',
        prep = '',
        workflow = '';
      for (const stage of ['r', 'p', 'a']) {
        const entry = s.show(id).items.find((x) => x.id === stage)!;
        if (entry.state !== 'submitted') throw Error(stage + ' ' + entry.state + ' ' + entry.error);
        const job = q.claim('agent', [entry.job!])!;
        expect(job.id).toBe(entry.job!);
        if (stage !== 'a') {
          await withLocalExecution(q, job, async () => {
            const j = await claimLibraryJob(pool, 'agent', 'local', job.id);
            if (!j) throw new Error('无法领取隔离任务');
            if (stage === 'r') {
              redaction = uuid();
              const file = (
                await pool.query('SELECT id FROM ai_distill.library_files WHERE revision_id=$1', [rev.id])
              ).rows[0].id;
              const index = {
                format: 'redacted-index-v2',
                redacted_sha256: hash(text),
                pages: [{ material_id: file, page: 1 }],
                materials: [
                  {
                    material_id: file,
                    markdown: text,
                    document: {
                      format: 'redacted-structure-v1',
                      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'paragraph', text }] }]
                    }
                  }
                ]
              };
              await finishLibraryJob(pool, j.id, j.lease_token, {}, async (db) => {
                const md = await insertLibraryTextBlob(db, text, 'text/plain'),
                  ix = await insertLibraryTextBlob(db, JSON.stringify(index), 'application/json');
                await db.query(
                  'INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                  [
                    redaction,
                    pkg.id,
                    rev.id,
                    extraction,
                    j.id,
                    md.id,
                    ix.id,
                    j.input_digest,
                    hash(text),
                    JSON.stringify({ usable_for_question: true, material_processing_mode: 'aliases' })
                  ]
                );
              });
            } else {
              prep = j.id;
              expect(j.input_snapshot.redaction_id).toBe(redaction);
              await finishLibraryJob(pool, j.id, j.lease_token, { preparation_id: j.id }, async (db) => {
                await db.query(
                  'INSERT INTO ai_distill.library_preparations(id,job_id,package_id,revision_id,extraction_job_id,redaction_id,project_id,source_digest,result) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8)',
                  [
                    j.id,
                    pkg.id,
                    rev.id,
                    extraction,
                    redaction,
                    project,
                    hash(text),
                    JSON.stringify({
                      format: 'material-preparation-v2',
                      package_summary: text,
                      documents: [
                        {
                          id: 'doc1',
                          title: '订单',
                          block_ids: ['u1p1b1'],
                          summary: text,
                          document_type: '订单',
                          tags: [],
                          notes: ''
                        }
                      ],
                      combinations: [],
                      warnings: []
                    })
                  ]
                );
              });
            }
          });
        } else {
          const a = (
            await pool.query('SELECT workflow_id,input FROM ai_distill.step_attempts WHERE id=$1', [job.id])
          ).rows[0];
          workflow = a.workflow_id;
          expect(a.input.material_scope.preparation_id).toBe(prep);
          expect(a.input.material_origin.redaction_id).toBe(redaction);
          await pool.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2 WHERE id=$1", [
            job.id,
            JSON.stringify({ question_version: 'v1', rubric_version: 'v1' })
          ]);
        }
        if (stage !== 'a') {
          await scheduler.wake();
          expect(q.get(job.id)?.state).toBe('running');
          expect(s.show(id).items.find((item) => item.id === (stage === 'r' ? 'p' : 'a'))?.state).toBe(
            'submitted'
          );
        }
        q.finish(job.id, job.lease!, 'committed');
        await scheduler.wake();
      }
      await scheduler.close();
      await scheduler.wake();
      await scheduler.close();
      const status = await runCommand(['dispatch', 'show', '--batch', id], client);
      const summary = (await runCommand(['dispatch', 'show', '--batch', id, '--summary'], client)).data;
      expect(summary.by_stage).toEqual({
        redact: { succeeded: 1 },
        prepare: { succeeded: 1 },
        author: { succeeded: 1 },
        deliver: { succeeded: 1 }
      });
      expect(summary.items).toBeUndefined();
      expect(status.data.counts).toEqual({ succeeded: 4 });
      expect(delivered).toBe(1);
      expect(
        (await runCommand(['dispatch', 'events', '--batch', id], client)).data.events.some(
          (e: any) => e.task === 'p' && e.state === 'running'
        )
      ).toBe(true);
      const e = s.show(id).items.find((x) => x.id === 'd')!;
      await expect(realDeliver(e, { workflow_id: workflow, author_attempt_id: uuid() })).rejects.toThrow(
        '未取得成功回执'
      );
    } finally {
      server?.stop(true);
      if (schema) await pool.query('DROP SCHEMA ai_distill CASCADE');
      await pool.end();
      if (oldMode === undefined) delete process.env.EXECUTION_QUEUE_MODE;
      else process.env.EXECUTION_QUEUE_MODE = oldMode;
      await rm(root, { recursive: true, force: true });
    }
  },
  60000
);
