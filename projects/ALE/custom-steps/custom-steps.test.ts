/**
 * 被测对象：`projects/ALE/custom-steps/`（前置输入哈希锁、Rubric 防误杀与防剧透/M10 门控、灵活 3/5/8+3 并发标定编排器）。
 * 验证边界：各档位（sample_3 / sample_5 / formal_8plus1 / custom）的 8+3 同发、两波回退、早停撤单、示范先过等待标定完结及首波全败自动补发第二波。
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_ALLOWED_PARALLEL_SUBRUNS,
  validateRepairEvaluationJson,
  type RecordedSubRun,
} from '../../../server/custom-steps/contract';
import { buildAleCalibrationRepairEvaluation, planAleCalibrationSubRuns, resolveAleCalibrationPolicy } from './calibrate-8plus1';
import { ALE_CUSTOM_STEPS } from './index';
import { runAlePreAuthoringLock } from './pre-authoring-lock';
import { auditAleAntiSpoilerDesign, auditAleRubricGateBalance } from './verify-gate';

function mockSubRun(
  subRunKey: string,
  status: RecordedSubRun['status'],
  runSuccess?: boolean,
  config: Record<string, unknown> = {},
): RecordedSubRun {
  return {
    id: crypto.randomUUID(),
    sub_run_key: subRunKey,
    status,
    config,
    result:
      runSuccess === undefined
        ? null
        : {
            run_success: runSuccess,
            weighted_score: runSuccess ? 0.92 : 0.68,
            all_key_gates_passed: runSuccess,
          },
    error: status === 'failed' ? 'boom' : null,
    started_at: new Date().toISOString(),
    finished_at: status === 'waiting' || status === 'running' ? null : new Date().toISOString(),
  };
}

describe('ALE 定制步骤单元验证 (T2)', () => {
  test('ale_pre_authoring_lock：锁定 environment/input/附件N.txt 与 SHA-256（兼容仅哈希摘要输入与全文输入），拒绝空材料', () => {
    expect(() =>
      runAlePreAuthoringLock({
        project_id: 'p1',
        project_key: 'ALE',
        workflow_id: 'wf1',
        materials: [],
      }),
    ).toThrow(/未绑定任何有效来源材料/);

    const sha = 'a'.repeat(64);
    const out = runAlePreAuthoringLock({
      project_id: 'p1',
      project_key: 'ALE',
      workflow_id: 'wf1',
      materials: [{ id: 'raw-1', sha256: 'b'.repeat(64) }],
      model_materials: [{ id: 'mod-1', sha256: sha }],
    });
    expect(out?.frozen_metadata).toMatchObject({
      locked_environment_inputs: [
        {
          index: 1,
          authoring_attachment_name: '附件1.txt',
          environment_input_path: 'environment/input/附件1.txt',
          material_id: 'mod-1',
          sha256: sha,
        },
      ],
    });
  });

  test('auditAleRubricGateBalance：拦截 ≥4 项时 100% 全设 is_key_gate=true 的误杀配置，放行 70/30 分层', () => {
    const allKeyGates = Array.from({ length: 8 }, (_, idx) => ({
      id: `C0${idx + 1}`,
      weight: 0.125,
      is_key_gate: true,
    }));
    const bad = auditAleRubricGateBalance({ pass_threshold: 0.85, criteria: allKeyGates });
    expect(bad.passed).toBe(false);
    expect(bad.warning_or_error).toMatch(/全部被设为 is_key_gate=true/);

    const overrideOk = auditAleRubricGateBalance({ pass_threshold: 0.85, criteria: allKeyGates }, true);
    expect(overrideOk.passed).toBe(true);

    const balancedCriteria = [
      { id: 'C01', weight: 0.18, is_key_gate: true },
      { id: 'C02', weight: 0.18, is_key_gate: true },
      { id: 'C03', weight: 0.17, is_key_gate: true },
      { id: 'C04', weight: 0.17, is_key_gate: true },
      { id: 'C05', weight: 0.1, is_key_gate: false },
      { id: 'C06', weight: 0.1, is_key_gate: false },
      { id: 'C07', weight: 0.1, is_key_gate: false },
    ];
    const good = auditAleRubricGateBalance({ pass_threshold: 0.85, criteria: balancedCriteria });
    expect(good.passed).toBe(true);
    expect(good.key_gates).toBe(4);
    expect(good.total).toBe(7);
  });

  test('sample_3 / sample_5 抽测档位：demo_required=0 自动不发 demo_run，超上限或必败时早停撤单', () => {
    const policy = resolveAleCalibrationPolicy({ preset: 'sample_3' });
    expect(policy).toMatchObject({
      preset: 'sample_3',
      calibration_runs: 3,
      min_pass: 1,
      max_pass: 2,
      demo_required: 0,
      concurrent_demo_with_calibration: false,
    });

    const policy5 = resolveAleCalibrationPolicy({ preset: 'sample_5' });
    expect(policy5).toMatchObject({
      preset: 'sample_5',
      calibration_runs: 5,
      min_pass: 1,
      max_pass: 2,
      demo_required: 0,
      concurrent_demo_with_calibration: false,
    });

    // 初始规划 3 个单槽位子任务，绝不夹带 demo_run
    const init = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf1',
      source_digest: 'dig1',
      sub_runs: [],
      options: { preset: 'sample_3' },
    });
    expect(init.action).toBe('enqueue');
    if (init.action === 'enqueue') {
      expect(init.next_sub_runs.map((item) => item.sub_run_key)).toEqual(['cal_run_01', 'cal_run_02', 'cal_run_03']);
    }

    // 3 轮全过 -> 超过上限 2 -> early_stop_failed
    const tooEasy = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf1',
      source_digest: 'dig1',
      options: { preset: 'sample_3' },
      sub_runs: [
        mockSubRun('cal_run_01', 'succeeded', true, { preset: 'sample_3' }),
        mockSubRun('cal_run_02', 'succeeded', true, { preset: 'sample_3' }),
        mockSubRun('cal_run_03', 'succeeded', true, { preset: 'sample_3' }),
      ],
    });
    expect(tooEasy.action).toBe('early_stop_failed');
    if (tooEasy.action === 'early_stop_failed') {
      expect(tooEasy.cancel_waiting_sub_runs).toBe(true);
    }

    // 3 轮过 1 轮（33.3%）-> 直接 succeeded，不触发 demo_run
    const goldilocks = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf1',
      source_digest: 'dig1',
      options: { preset: 'sample_3' },
      sub_runs: [
        mockSubRun('cal_run_01', 'succeeded', true, { preset: 'sample_3' }),
        mockSubRun('cal_run_02', 'succeeded', false, { preset: 'sample_3' }),
        mockSubRun('cal_run_03', 'succeeded', false, { preset: 'sample_3' }),
      ],
    });
    expect(goldilocks.action).toBe('succeeded');
  });

  test('formal_8plus1 默认 8+3=11 并发同发，且支持 concurrent_demo_with_calibration=false 显式退回两波模式', () => {
    const calStepDef = ALE_CUSTOM_STEPS.find((s) => s.step_key === 'ale_calibrate_8plus1');
    expect(calStepDef).toBeDefined();
    expect(calStepDef!.max_parallel_subruns).toBeGreaterThanOrEqual(11);
    expect(calStepDef!.max_parallel_subruns).toBeLessThanOrEqual(MAX_ALLOWED_PARALLEL_SUBRUNS);

    const defaultPolicy = resolveAleCalibrationPolicy();
    expect(defaultPolicy).toMatchObject({
      preset: 'formal_8plus1',
      calibration_runs: 8,
      min_pass: 1,
      max_pass: 3,
      demo_required: 1,
      demo_parallel: 3,
      demo_max_attempts: 6,
      concurrent_demo_with_calibration: true,
    });

    // 默认首轮直接同发 cal_run_01..08 + demo_run_01..03 共 11 路
    const initConcurrent = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-8p3',
      source_digest: 'dig-8p3',
      sub_runs: [],
      options: { preset: 'formal_8plus1' },
    });
    expect(initConcurrent.action).toBe('enqueue');
    if (initConcurrent.action === 'enqueue') {
      expect(initConcurrent.next_sub_runs).toHaveLength(11);
      expect(initConcurrent.next_sub_runs.map((item) => item.sub_run_key)).toEqual([
        'cal_run_01',
        'cal_run_02',
        'cal_run_03',
        'cal_run_04',
        'cal_run_05',
        'cal_run_06',
        'cal_run_07',
        'cal_run_08',
        'demo_run_01',
        'demo_run_02',
        'demo_run_03',
      ]);
      expect(initConcurrent.next_sub_runs[0]?.input).toMatchObject({
        phase: 'calibration',
        run_index: 1,
        model: 'gpt-6.1-sol',
      });
      expect(initConcurrent.next_sub_runs[8]?.input).toMatchObject({
        phase: 'clean_trajectory',
        run_index: 1,
        model: 'gpt-5.6-sol',
      });
    }

    // 显式传 concurrent_demo_with_calibration=false：退回「先 8 后 3」两波模式
    const twoWaveOpts = { preset: 'formal_8plus1', concurrent_demo_with_calibration: false };
    expect(resolveAleCalibrationPolicy(twoWaveOpts).concurrent_demo_with_calibration).toBe(false);

    const initTwoWave = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-2wave',
      source_digest: 'dig-2wave',
      sub_runs: [],
      options: twoWaveOpts,
    });
    expect(initTwoWave.action).toBe('enqueue');
    if (initTwoWave.action === 'enqueue') {
      expect(initTwoWave.next_sub_runs.map((item) => item.sub_run_key)).toEqual([
        'cal_run_01',
        'cal_run_02',
        'cal_run_03',
        'cal_run_04',
        'cal_run_05',
        'cal_run_06',
        'cal_run_07',
        'cal_run_08',
      ]);
    }

    const passedCalRuns = Array.from({ length: 8 }, (_, idx) =>
      mockSubRun(`cal_run_0${idx + 1}`, 'succeeded', idx < 2, twoWaveOpts),
    );
    const wave2Demo = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-2wave',
      source_digest: 'dig-2wave',
      sub_runs: passedCalRuns,
      options: twoWaveOpts,
    });
    expect(wave2Demo.action).toBe('enqueue');
    if (wave2Demo.action === 'enqueue') {
      expect(wave2Demo.next_sub_runs.map((item) => item.sub_run_key)).toEqual([
        'demo_run_01',
        'demo_run_02',
        'demo_run_03',
      ]);
    }
  });

  test('formal_8plus1 早停与故障撤单闭环：基建失败、4 连过超上限、必败无望或 0/8 未过线均撤掉排队 cal_run 与 demo_run', () => {
    // 1. 基建故障（如 CLI 异常）-> 立即 early_stop_failed 且 cancel_waiting_sub_runs=true
    const infraCrash = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-err',
      source_digest: 'dig-err',
      options: { preset: 'formal_8plus1' },
      sub_runs: [
        mockSubRun('cal_run_01', 'failed', undefined, { preset: 'formal_8plus1' }),
        mockSubRun('cal_run_02', 'waiting', undefined, { preset: 'formal_8plus1' }),
        mockSubRun('demo_run_01', 'waiting', undefined, { preset: 'formal_8plus1' }),
      ],
    });
    expect(infraCrash.action).toBe('early_stop_failed');
    if (infraCrash.action === 'early_stop_failed') {
      expect(infraCrash.cancel_waiting_sub_runs).toBe(true);
      expect(infraCrash.repair_evaluation?.verdict).toBe('manual_override');
    }

    // 2. 4 连过超上限 -> 立即熔断并取消排队中的第 5..8 轮与 demo_run_01..03
    const tooEasyEarlyStop = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf2',
      source_digest: 'dig2',
      options: { preset: 'formal_8plus1' },
      sub_runs: [
        mockSubRun('cal_run_01', 'succeeded', true, { preset: 'formal_8plus1' }),
        mockSubRun('cal_run_02', 'succeeded', true, { preset: 'formal_8plus1' }),
        mockSubRun('cal_run_03', 'succeeded', true, { preset: 'formal_8plus1' }),
        mockSubRun('cal_run_04', 'succeeded', true, { preset: 'formal_8plus1' }),
        mockSubRun('cal_run_05', 'waiting', undefined, { preset: 'formal_8plus1' }),
        mockSubRun('cal_run_06', 'waiting', undefined, { preset: 'formal_8plus1' }),
        mockSubRun('demo_run_01', 'running', undefined, { preset: 'formal_8plus1' }),
        mockSubRun('demo_run_02', 'waiting', undefined, { preset: 'formal_8plus1' }),
      ],
    });
    expect(tooEasyEarlyStop.action).toBe('early_stop_failed');
    if (tooEasyEarlyStop.action === 'early_stop_failed') {
      expect(tooEasyEarlyStop.cancel_waiting_sub_runs).toBe(true);
    }

    // 3. 显式开启 early_stop_impossible 且剩余轮次全对亦无望达到 min_pass=2 -> 提前止损撤单
    const impossibleOpts = { preset: 'formal_8plus1', min_pass: 2, early_stop_impossible: true };
    const impossibleStop = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-imp',
      source_digest: 'dig-imp',
      options: impossibleOpts,
      sub_runs: [
        ...Array.from({ length: 7 }, (_, idx) => mockSubRun(`cal_run_0${idx + 1}`, 'succeeded', false, impossibleOpts)),
        mockSubRun('cal_run_08', 'waiting', undefined, impossibleOpts),
        mockSubRun('demo_run_01', 'waiting', undefined, impossibleOpts),
      ],
    });
    expect(impossibleStop.action).toBe('early_stop_failed');
    if (impossibleStop.action === 'early_stop_failed') {
      expect(impossibleStop.cancel_waiting_sub_runs).toBe(true);
    }

    // 4. 8 轮全部跑完但 0/8 未过线（并发示范仍在 waiting/running）-> 立即 early_stop_failed 并撤掉剩余 demo_run
    const zeroOfEight = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-zero',
      source_digest: 'dig-zero',
      options: { preset: 'formal_8plus1' },
      sub_runs: [
        ...Array.from({ length: 8 }, (_, idx) =>
          mockSubRun(`cal_run_0${idx + 1}`, 'succeeded', false, { preset: 'formal_8plus1' }),
        ),
        mockSubRun('demo_run_01', 'succeeded', true, { preset: 'formal_8plus1' }),
        mockSubRun('demo_run_02', 'waiting', undefined, { preset: 'formal_8plus1' }),
      ],
    });
    expect(zeroOfEight.action).toBe('early_stop_failed');
    if (zeroOfEight.action === 'early_stop_failed') {
      expect(zeroOfEight.cancel_waiting_sub_runs).toBe(true);
    }
  });

  test('formal_8plus1 并发顺序与补发闭环：demo_run 先过须等 8 轮标定完结才判成功；首波 3 路 demo 全败自动补发第二波直至耗尽', () => {
    const opts = { preset: 'formal_8plus1' };

    // 1. demo_run_01 已提前成功，但标定仅完成 5/8（3 路仍在 running）：绝不提前判 succeeded，返回 wait 且不再补发新 demo_run
    const demoDoneFirst = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-order',
      source_digest: 'dig-order',
      options: opts,
      sub_runs: [
        mockSubRun('cal_run_01', 'succeeded', true, opts),
        mockSubRun('cal_run_02', 'succeeded', false, opts),
        mockSubRun('cal_run_03', 'succeeded', true, opts),
        mockSubRun('cal_run_04', 'succeeded', false, opts),
        mockSubRun('cal_run_05', 'succeeded', false, opts),
        mockSubRun('cal_run_06', 'running', undefined, opts),
        mockSubRun('cal_run_07', 'running', undefined, opts),
        mockSubRun('cal_run_08', 'running', undefined, opts),
        mockSubRun('demo_run_01', 'succeeded', true, opts),
      ],
    });
    expect(demoDoneFirst.action).toBe('wait');

    // 一旦剩余标定完成且落在 [1, 3]（2/8），立即判定 succeeded 并取消排队中的多余 demo_run
    const calRunsQualified = Array.from({ length: 8 }, (_, idx) =>
      mockSubRun(`cal_run_0${idx + 1}`, 'succeeded', idx < 2, opts),
    );
    const allQualified = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-order',
      source_digest: 'dig-order',
      options: opts,
      sub_runs: [
        ...calRunsQualified,
        mockSubRun('demo_run_01', 'succeeded', true, opts),
        mockSubRun('demo_run_02', 'waiting', undefined, opts),
      ],
    });
    expect(allQualified.action).toBe('succeeded');
    if (allQualified.action === 'succeeded') {
      expect(allQualified.cancel_waiting_sub_runs).toBe(true);
      expect(allQualified.summary).toMatchObject({
        mode: 'formal_8plus1',
        calibration_pass_count: 2,
        demo_pass_count: 1,
        qualification_status: 'formal_qualified',
      });
    }

    // 2. 8 轮标定已过线（2/8），首波 demo_run_01 失败但 demo_run_02/03 仍在跑 -> 返回 wait 等待首波跑完，不抢跑第二波
    const wave1StillRunning = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-wave',
      source_digest: 'dig-wave',
      options: opts,
      sub_runs: [
        ...calRunsQualified,
        mockSubRun('demo_run_01', 'succeeded', false, opts),
        mockSubRun('demo_run_02', 'running', undefined, opts),
        mockSubRun('demo_run_03', 'waiting', undefined, opts),
      ],
    });
    expect(wave1StillRunning.action).toBe('wait');

    // 3. 首波 3 路 demo_run_01..03 全部未通过（0/3）-> 自动补发第二波 demo_run_04..06
    const wave1Failed = [1, 2, 3].map((k) => mockSubRun(`demo_run_0${k}`, 'succeeded', false, opts));
    const enqueueWave2 = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-wave',
      source_digest: 'dig-wave',
      options: opts,
      sub_runs: [...calRunsQualified, ...wave1Failed],
    });
    expect(enqueueWave2.action).toBe('enqueue');
    if (enqueueWave2.action === 'enqueue') {
      expect(enqueueWave2.next_sub_runs.map((e) => e.sub_run_key)).toEqual([
        'demo_run_04',
        'demo_run_05',
        'demo_run_06',
      ]);
    }

    // 4. 若第二波 demo_run_04..06 也全部失败（耗尽 demo_max_attempts=6）-> 返回 failed 并附带诊断评价
    const wave2Failed = [4, 5, 6].map((k) => mockSubRun(`demo_run_0${k}`, 'succeeded', false, opts));
    const exhausted = planAleCalibrationSubRuns({
      project_key: 'ALE',
      workflow_id: 'wf-wave',
      source_digest: 'dig-wave',
      options: opts,
      sub_runs: [...calRunsQualified, ...wave1Failed, ...wave2Failed],
    });
    expect(exhausted.action).toBe('failed');
    if (exhausted.action === 'failed') {
      expect(exhausted.reason).toMatch(/尝试 6 次仅成功 0 条/);
      expect(exhausted.repair_evaluation?.action_items[0]).toMatch(/标定已达标（2\/8）/);
    }
  });

  test('auditAleAntiSpoilerDesign：拦截 >16 个固定过程字段剧透与缺失 M10 表层诱饵反例，放行黑盒终点设计', () => {
    const wideSpoilerDoc =
      '工作簿列依次为 `项目、截点、到账、一般天数、加倍天数、期初本金A、期初本金B、期初费用、期初已定息、期初一般息A、期初一般息B、期初加倍息、本段一般息A、本段一般息B、本段加倍息、B口径差、分前总额、期末总额`。';
    const badWide = auditAleAntiSpoilerDesign(wideSpoilerDoc, { variants: [] });
    expect(badWide.passed).toBe(false);
    expect(badWide.issues.join(' | ')).toMatch(/超过 16 个终点键上限/);
    expect(badWide.issues.join(' | ')).toMatch(/shallow_decoy_trap/);

    const cleanEndpointDoc =
      '工作簿汇总表仅需列出 `核定有效本金、基准日一般利息、迟延加倍债务利息、已证实第三方追索上限、基准日可入账净敞口、压力情景未清余额` 六项终点指标。';
    const good = auditAleAntiSpoilerDesign(cleanEndpointDoc, {
      variants: [{ id: 'M10_shallow_decoy_trap', kind: 'shallow_decoy_trap' }],
    });
    expect(good.passed).toBe(true);
    expect(good.issues).toEqual([]);
  });

  test('结构化返修评价 JSON（repair_evaluation）：强制 JSON 对象校验，自动聚合失分热点并推荐免重跑重评', () => {
    expect(() => validateRepairEvaluationJson('纯文本返修建议' as any)).toThrow(/必须是 JSON 对象/);
    expect(() => validateRepairEvaluationJson(['数组'] as any)).toThrow(/必须是 JSON 对象/);

    const failedRuns: RecordedSubRun[] = ['cal_run_01', 'cal_run_02', 'cal_run_03'].map((k) => ({
      id: crypto.randomUUID(),
      sub_run_key: k,
      status: 'succeeded',
      config: { preset: 'sample_3' },
      result: {
        run_success: false,
        normalized_score: 0.48,
        failed_items: [
          { criterion_id: 'C06_RESP', observed: ['M1', 'M2'] },
          ...(k === 'cal_run_01' ? [{ criterion_id: 'C03_C', observed: ['C_D'] }] : []),
        ],
      },
      error: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }));

    const evalJson = buildAleCalibrationRepairEvaluation({ sub_runs: failedRuns });
    expect(evalJson.schema_version).toBe('custom_repair_eval_v1');
    expect(evalJson.verdict).toBe('needs_grader_patch');
    expect(evalJson.recommended_scope).toBe('grader_only_regrade');
    expect(evalJson.failed_criteria_hotspots[0]).toMatchObject({
      criterion_id: 'C06_RESP',
      fail_rate: 1,
    });
    expect(validateRepairEvaluationJson(evalJson).action_items.length).toBeGreaterThan(0);
  });
});
