/**
 * 被测对象：`server/custom-steps/jobs.ts` 及与 `LocalQueue`、`inputDigest`、归档门控的协同。
 * 验证边界：
 * 1. 沙盒目录符号链接越界拦截；
 * 2. 豆包/Work 的出题 `inputDigest` 100% 字节级零变化，归档/重出题零额外 SQL 查询；
 * 3. 单槽位子运行滑窗节流（并发窗口=2 时绝不一次占满全部槽位）、早停自动撤单与归档门控拦截。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputDigest } from '../authoring/jobs';
import { localQueue, withLocalExecution, withLocalQueueRoot } from '../execution-queue/runtime';
import {
  assertBeforePublishCustomStepsReady,
  computeAuthoringSourceDigest,
  enqueueCustomStep,
  invalidateDownstreamCustomSteps,
  prepareCagedDirectories,
  runNextCustomStep,
} from './jobs';
import { CustomStepRegistry, defineProjectCustomSteps } from './registry';

interface FakeCustomRunRow {
  id: string;
  workflow_id: string;
  project_id: string;
  project_key: string;
  step_key: string;
  anchor_ordinal: number;
  placement: string;
  step_order: number;
  sub_run_key: string;
  lane: 'internal' | 'agent' | 'api';
  execution_target: string;
  status: string;
  source_digest: string;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  started_at: Date;
  heartbeat_at: Date | null;
  finished_at: Date | null;
}

function createFakeCustomStepPool(seed: {
  workflowId: string;
  projectId: string;
  parentName: string;
  authorAttempt: { id: string; status: string; input: Record<string, unknown>; result: Record<string, unknown> };
}) {
  const runs: FakeCustomRunRow[] = [];
  const dispatches = new Map<string, { executor_id: string; generation: number; kind: string }>();

  const query = async (rawSql: any, params: any[] = []) => {
    const sql = typeof rawSql === 'string' ? rawSql : String(rawSql.text ?? '');

    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(sql.trim())) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("to_regclass('ai_distill.custom_step_runs')")) {
      return { rows: [{ available: true }], rowCount: 1 };
    }
    if (
      sql.includes('FROM ai_distill.workflows w') &&
      sql.includes('JOIN ai_distill.projects p') &&
      !sql.includes('FROM ai_distill.custom_step_runs')
    ) {
      if (params[0] !== seed.workflowId) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: seed.workflowId,
            project_id: seed.projectId,
            project_name: `${seed.parentName} - 第一期`,
            parent_name: seed.parentName,
            material_backend: 'legacy',
            has_library_snapshot: false,
            archived_at: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM ai_distill.workflows') && sql.includes('FOR UPDATE NOWAIT')) {
      return params[0] === seed.workflowId ? { rows: [{ id: seed.workflowId }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM ai_distill.steps') && sql.includes('ordinal=8')) {
      return { rows: [{ status: 'waiting' }], rowCount: 1 };
    }
    if (sql.includes('FROM ai_distill.step_attempts') && sql.includes('ordinal=4')) {
      return { rows: [seed.authorAttempt], rowCount: 1 };
    }
    if (sql.includes('FROM ai_distill.steps') && sql.includes('ordinal=4')) {
      return { rows: [{ status: 'succeeded' }], rowCount: 1 };
    }
    if (sql.includes('FROM ai_distill.question_library_sources')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM ai_distill.step_attempts') && sql.includes('ordinal=9')) {
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111', input: { materials: [{ original_name: '附件1.txt' }] } }], rowCount: 1 };
    }
    if (sql.includes('FROM ai_distill.materials')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM ai_distill.artifacts')) {
      const content = '测试输入材料正文';
      return {
        rows: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            kind: 'redacted_markdown',
            attempt_id: '11111111-1111-4111-8111-111111111111',
            sha256: createHash('sha256').update(content).digest('hex'),
            content,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO ai_distill.execution_dispatches')) {
      const [jobId, kind, executorId] = params;
      if (!dispatches.has(jobId)) dispatches.set(jobId, { executor_id: executorId, generation: 0, kind });
      return { rows: [{ executor_id: dispatches.get(jobId)!.executor_id }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO ai_distill.custom_step_runs')) {
      const [
        id,
        workflowId,
        projectId,
        projectKey,
        stepKey,
        anchorOrdinal,
        placement,
        stepOrder,
        subRunKey,
        lane,
        sourceDigest,
        inputJson,
        configJson,
      ] = params;
      runs.push({
        id,
        workflow_id: workflowId,
        project_id: projectId,
        project_key: projectKey,
        step_key: stepKey,
        anchor_ordinal: anchorOrdinal,
        placement,
        step_order: stepOrder,
        sub_run_key: subRunKey,
        lane,
        execution_target: 'local',
        status: 'waiting',
        source_digest: sourceDigest,
        input: JSON.parse(inputJson),
        config: JSON.parse(configJson),
        result: null,
        error: null,
        started_at: new Date(),
        heartbeat_at: null,
        finished_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM ai_distill.custom_step_runs r') && sql.includes('FOR UPDATE OF r SKIP LOCKED')) {
      const idMatch = sql.match(/r\.id='([0-9a-f-]+)'::uuid/i);
      const targetId = idMatch?.[1];
      const found = runs.find((r) => r.id === targetId && (r.status === 'waiting' || r.status === 'running'));
      if (!found) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            ...found,
            project_name: `${seed.parentName} - 第一期`,
            parent_name: seed.parentName,
            workspace_path: null,
            material_root: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      (sql.includes('SELECT id, step_key, sub_run_key, status') ||
        sql.includes('SELECT id, sub_run_key, status')) &&
      sql.includes('FROM ai_distill.custom_step_runs')
    ) {
      const [wfId, arg2, arg3] = params;
      let filtered = runs.filter((r) => r.workflow_id === wfId);
      if (sql.includes('step_key = $2 AND source_digest = $3')) {
        filtered = filtered.filter((r) => r.step_key === arg2 && r.source_digest === arg3);
      } else {
        filtered = filtered.filter((r) => r.source_digest === arg2);
        if (Array.isArray(arg3)) filtered = filtered.filter((r) => arg3.includes(r.step_key));
        else if (typeof arg3 === 'string') filtered = filtered.filter((r) => r.step_key === arg3);
      }
      return { rows: filtered, rowCount: filtered.length };
    }
    if ((sql.includes("SET status = 'running'") || sql.includes("SET status='running'")) && sql.includes('ai_distill.custom_step_runs')) {
      const found = runs.find((r) => r.id === params[0]);
      if (found) {
        found.status = 'running';
        found.heartbeat_at = new Date();
      }
      return { rows: [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('SET status = $2, result = $3, error = $4') && sql.includes('ai_distill.custom_step_runs')) {
      const [id, status, resultJson, errText, repairJson] = params;
      const found = runs.find((r) => r.id === id) as any;
      if (found) {
        found.status = status;
        found.result = typeof resultJson === 'string' ? JSON.parse(resultJson) : null;
        found.error = errText ?? null;
        if (typeof repairJson === 'string') found.repair_evaluation = JSON.parse(repairJson);
        found.finished_at = new Date();
      }
      return { rows: [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('SET repair_evaluation = $2::jsonb') && sql.includes('ai_distill.custom_step_runs')) {
      const [id, repairJson] = params;
      const found = runs.find((r) => r.id === id) as any;
      if (found && typeof repairJson === 'string') found.repair_evaluation = JSON.parse(repairJson);
      return { rows: [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('SELECT id') && sql.includes('FROM ai_distill.custom_step_runs') && sql.includes('LIMIT 1')) {
      const [wfId, stepKey] = params;
      const found = runs.find((r) => r.workflow_id === wfId && r.step_key === stepKey);
      return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET status = 'cancelled'") && sql.includes('RETURNING id')) {
      const [wfId, stepKey, digest, reason] = params;
      const cancelledIds: { id: string }[] = [];
      for (const r of runs) {
        if (r.workflow_id === wfId && r.step_key === stepKey && r.source_digest === digest && r.status === 'waiting') {
          r.status = 'cancelled';
          r.error = typeof reason === 'string' ? reason : '已取消';
          r.finished_at = new Date();
          cancelledIds.push({ id: r.id });
        }
      }
      return { rows: cancelledIds, rowCount: cancelledIds.length };
    }
    if (sql.includes("SET status = 'skipped'") && sql.includes('anchor_ordinal >=')) {
      const [wfId, fromOrdinal] = params;
      const skippedIds: { id: string }[] = [];
      for (const r of runs) {
        if (
          r.workflow_id === wfId &&
          r.anchor_ordinal >= fromOrdinal &&
          (r.status === 'waiting' || r.status === 'running')
        ) {
          r.status = 'skipped';
          r.finished_at = new Date();
          skippedIds.push({ id: r.id });
        }
      }
      return { rows: skippedIds, rowCount: skippedIds.length };
    }
    if (sql.includes('UPDATE ai_distill.custom_step_runs AS j SET')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT job_id FROM ai_distill.execution_dispatches')) {
      const ids: string[] = params[0] ?? [];
      return { rows: ids.filter((id) => dispatches.has(id)).map((job_id) => ({ job_id })), rowCount: ids.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const client = {
    query,
    release: () => {},
  };

  return {
    pool: {
      query,
      connect: async () => client,
    } as any,
    runs,
  };
}

describe('Custom Steps 沙盒、单槽位滑窗队列与零干扰回归 (T3)', () => {
  let prevQueueMode: string | undefined;
  let tempRoot: string;

  beforeEach(() => {
    prevQueueMode = process.env.EXECUTION_QUEUE_MODE;
    process.env.EXECUTION_QUEUE_MODE = 'local';
    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'custom-steps-test-')));
  });

  afterEach(() => {
    if (prevQueueMode === undefined) delete process.env.EXECUTION_QUEUE_MODE;
    else process.env.EXECUTION_QUEUE_MODE = prevQueueMode;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('沙盒目录守卫：正常创建隔离目录，拦截非法段与符号链接越界', async () => {
    const wfId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const { sandboxDir } = await prepareCagedDirectories(tempRoot, wfId, 'ALE', 'ale_verify_gate', runId);
    expect(sandboxDir.startsWith(tempRoot)).toBe(true);

    await expect(prepareCagedDirectories(tempRoot, wfId, '../escape', 'step', runId)).rejects.toThrow(/非法沙盒路径段/);

    // 构造符号链接逃逸尝试
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-escape-')));
    try {
      const wf2 = crypto.randomUUID();
      const parentDir = join(tempRoot, wf2, 'custom-steps');
      mkdirSync(parentDir, { recursive: true });
      symlinkSync(outside, join(parentDir, 'ALE'));
      await expect(prepareCagedDirectories(tempRoot, wf2, 'ALE', 'ale_verify_gate', runId)).rejects.toThrow(/符号链接越界/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('老项目零影响：豆包与 Work 的 inputDigest 字节级完全不变，门控与失效函数 0 次 SQL 查询', async () => {
    const baseFrozen = {
      title: '测试合同审查',
      project_name: '豆包高经济价值 - 第八期',
      materials: [{ id: 'm1', sha256: '1'.repeat(64) }],
      project_prompt: {
        workspace_path: '/tmp/ws',
        skill_path: '/tmp/ws/skill',
        source_digest: '2'.repeat(64),
        files: [{ path: 'SKILL.md', sha256: '3'.repeat(64), size_bytes: 120 }],
      },
    };
    const digestWithoutCustom = inputDigest(baseFrozen);
    const digestWithUndefinedCustom = inputDigest({ ...baseFrozen, custom_before_gates: undefined });
    expect(digestWithUndefinedCustom).toBe(digestWithoutCustom);

    const reg = new CustomStepRegistry();
    reg.registerProject(
      'ALE',
      defineProjectCustomSteps('ALE', [
        {
          step_key: 'ale_gate',
          name: 'ALE门禁',
          description: 'desc',
          anchor: { ordinal: 4, placement: 'after', order: 1 },
          mode: 'queued_single',
          lane: 'internal',
          blocks_downstream_ordinal: 8,
          executeRun: async () => ({ ok: true }),
        },
      ]),
    );

    const throwingDb = {
      query: async () => {
        throw new Error('老项目绝不应触发任何 custom_step_runs 查询');
      },
    };

    for (const project of ['豆包高经济价值', 'Work法律全场景', '豆包高经济价值 - 第八期', 'Work法律全场景 - 第二期']) {
      await expect(
        assertBeforePublishCustomStepsReady(throwingDb, reg, project, crypto.randomUUID(), 'dig'),
      ).resolves.toBeUndefined();
      await expect(
        invalidateDownstreamCustomSteps(throwingDb, tempRoot, reg, project, crypto.randomUUID(), 4),
      ).resolves.toBeUndefined();
    }
  });

  test('单槽位滑窗队列 + 早停自动撤单 + 归档门控与重出题失效全链路', async () => {
    const workflowId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const authorAttempt = {
      id: crypto.randomUUID(),
      status: 'succeeded',
      input: { digest: 'in-1' },
      result: {
        question: '请核算工程变更总价',
        question_version: 'qv-1',
        rubric: [{ id: 'C01' }],
        rubric_version: 'rv-1',
        attachment_ids: [],
      },
    };
    const digest = computeAuthoringSourceDigest(authorAttempt);
    const fake = createFakeCustomStepPool({
      workflowId,
      projectId,
      parentName: 'ALE',
      authorAttempt,
    });

    const reg = new CustomStepRegistry();
    reg.registerProject(
      'ALE',
      defineProjectCustomSteps('ALE', [
        {
          step_key: 'ale_verify_mock',
          name: 'ALE 反例硬筛',
          description: '0 槽硬筛',
          anchor: { ordinal: 4, placement: 'after', order: 1 },
          mode: 'queued_single',
          lane: 'internal',
          blocks_downstream_ordinal: 8,
          executeRun: async () => ({ verified: true }),
        },
        {
          step_key: 'ale_cal_mock',
          name: 'ALE 抽测标定',
          description: '单槽子运行标定',
          anchor: { ordinal: 4, placement: 'after', order: 2 },
          mode: 'queued_subruns',
          lane: 'agent',
          max_parallel_subruns: 2,
          blocks_downstream_ordinal: 8,
          allow_explicit_pilot_skip: true,
          planSubRuns: ({ sub_runs }) => {
            const keys = ['cal_run_01', 'cal_run_02', 'cal_run_03', 'cal_run_04'];
            const passes = sub_runs.filter((r) => r.status === 'succeeded' && r.result?.run_success === true).length;
            if (passes > 2) {
              return {
                action: 'early_stop_failed',
                progress_label: '通过过多早停',
                reason: '3连过超过上限2，自动早停',
                cancel_waiting_sub_runs: true,
              };
            }
            const existingSet = new Set(sub_runs.map((r) => r.sub_run_key));
            const missing = keys.filter((k) => !existingSet.has(k)).map((sub_run_key) => ({ sub_run_key }));
            if (missing.length > 0) {
              return { action: 'enqueue', progress_label: `进度 ${sub_runs.length}/4`, next_sub_runs: missing };
            }
            if (sub_runs.some((r) => r.status === 'waiting' || r.status === 'running')) {
              return { action: 'wait', progress_label: '等待运行结束' };
            }
            return { action: 'succeeded', progress_label: '完成', summary: { passes } };
          },
          // 模拟前 3 次全过 -> 第 3 次结算后应自动早停并撤掉第 4 次排队！
          executeRun: async () => ({ run_success: true, weighted_score: 0.95 }),
        },
      ]),
    );

    const q = localQueue(tempRoot);

    // 1. 未跑前置步骤前，归档被拦截（409），且不能跳过第 1 步直接跑第 2 步
    await expect(assertBeforePublishCustomStepsReady(fake.pool, reg, 'ALE', workflowId, digest)).rejects.toThrow(/ALE 反例硬筛/);
    await expect(
      withLocalQueueRoot(tempRoot, () => enqueueCustomStep(fake.pool, tempRoot, reg, workflowId, 'ale_cal_mock')),
    ).rejects.toThrow(/须先通过前置定制步骤：ALE 反例硬筛/);

    // 2. 派发并执行第 1 步（internal 通道）
    const step1 = await withLocalQueueRoot(tempRoot, () =>
      enqueueCustomStep(fake.pool, tempRoot, reg, workflowId, 'ale_verify_mock'),
    );
    expect(step1.enqueued_ids).toHaveLength(1);
    q.confirm(step1.enqueued_ids[0]!, 4);
    const job1 = q.claim('internal');
    expect(job1?.id).toBe(step1.enqueued_ids[0]);
    await withLocalExecution(q, job1!, () =>
      runNextCustomStep(fake.pool, tempRoot, reg, new AbortController().signal),
    );
    q.finish(job1!.id, job1!.lease!, 'committed');

    // 此时若显式开启 pilot_skip_optional，可放行试包；默认严格模式仍拦截未完成标定
    await expect(assertBeforePublishCustomStepsReady(fake.pool, reg, 'ALE', workflowId, digest)).rejects.toThrow(/ALE 抽测标定/);
    await expect(
      assertBeforePublishCustomStepsReady(fake.pool, reg, 'ALE', workflowId, digest, { pilot_skip_optional: true }),
    ).resolves.toBeUndefined();

    // 3. 派发第 2 步（总共 4 轮，但 max_parallel_subruns=2 -> 初始只允许入队 2 个单槽位任务！）
    const step2 = await withLocalQueueRoot(tempRoot, () =>
      enqueueCustomStep(fake.pool, tempRoot, reg, workflowId, 'ale_cal_mock'),
    );
    expect(step2.enqueued_ids).toHaveLength(2);
    expect(fake.runs.filter((r) => r.step_key === 'ale_cal_mock').map((r) => r.sub_run_key)).toEqual([
      'cal_run_01',
      'cal_run_02',
    ]);

    // 确认并顺序消费 cal_run_01 -> 结算后自动补位入队 cal_run_03（保持滑窗 <= 2）
    for (const id of step2.enqueued_ids) q.confirm(id, 4);
    const subJob1 = q.claim('agent')!;
    await withLocalExecution(q, subJob1, () =>
      runNextCustomStep(fake.pool, tempRoot, reg, new AbortController().signal),
    );
    q.finish(subJob1.id, subJob1.lease!, 'committed');

    const run3Row = fake.runs.find((r) => r.sub_run_key === 'cal_run_03');
    expect(run3Row).toBeDefined();
    q.confirm(run3Row!.id, 4);

    // 消费 cal_run_02 -> 自动补位入队 cal_run_04
    const subJob2 = q.claim('agent')!;
    await withLocalExecution(q, subJob2, () =>
      runNextCustomStep(fake.pool, tempRoot, reg, new AbortController().signal),
    );
    q.finish(subJob2.id, subJob2.lease!, 'committed');

    const run4Row = fake.runs.find((r) => r.sub_run_key === 'cal_run_04');
    expect(run4Row?.status).toBe('waiting');
    q.confirm(run4Row!.id, 4);

    // 消费 cal_run_03（第 3 次通过 > 上限 2）-> 触发早停，自动将排队中的 cal_run_04 取消！
    const subJob3 = q.claim('agent')!;
    await withLocalExecution(q, subJob3, () =>
      runNextCustomStep(fake.pool, tempRoot, reg, new AbortController().signal),
    );
    q.finish(subJob3.id, subJob3.lease!, 'committed');

    expect(run4Row?.status).toBe('cancelled');
    expect(q.get(run4Row!.id)?.cancel_requested).toBe(1);

    // 4. 验证上游重新出题时，invalidateDownstreamCustomSteps 自动清理残余状态
    fake.runs.push({
      ...run4Row!,
      id: crypto.randomUUID(),
      sub_run_key: 'cal_run_99',
      status: 'waiting',
    });
    await invalidateDownstreamCustomSteps(fake.pool, tempRoot, reg, 'ALE', workflowId, 4);
    expect(fake.runs.find((r) => r.sub_run_key === 'cal_run_99')?.status).toBe('skipped');
  });
});
