/**
 * 职责：ALE 出题后第 2 道定制步骤（`ale_calibrate_8plus1`，`agent` 通道，每次子运行固定占 1 个槽位）：
 *       支持正式 `8+1` 并发一起跑模式（默认首轮 `8 路标定 + 3 路示范 = 11 路` 同发，也可显式回退先 8 后 3）与低成本抽测模式（如 `3` 轮或 `5` 轮）、超上限/必败自动早停取消剩余待跑轮次。
 * 主要公开入口：`resolveAleCalibrationPolicy()`、`planAleCalibrationSubRuns()`、`executeAleCalibrationSubRun()`。
 * 边界：仅操作当前工作流沙盒内已通过 `ale_verify_gate` 的题包，绝不修改其他项目或宿主配置。
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  IsolatedRunContext,
  PlannedSubRunSpec,
  RecordedSubRun,
  RepairEvaluationJson,
  SubRunDecision,
  SubRunPlanContext,
} from '../../../server/custom-steps/contract';
import { regradeSavedRuns, runCalibration } from '../scripts/calibrate';
import { materializeAleTaskFromDraft } from '../scripts/delivery';
import { prepareStagedMaterialsForAleDraft } from './verify-gate';

export interface AleCalibrationPolicy {
  preset: 'formal_8plus1' | 'sample_3' | 'sample_5' | 'custom';
  calibration_runs: number;
  min_pass: number;
  max_pass: number;
  demo_required: number;
  demo_max_attempts: number;
  demo_parallel: number;
  concurrent_demo_with_calibration: boolean;
  calibration_model: string;
  demo_model: string;
  reasoning_effort: string;
  timeout_minutes: number;
  early_stop_impossible: boolean;
  is_formal_8plus1: boolean;
}

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/** 解析灵活的标定策略：默认正式 8+1，同时支持 sample_3（3轮过1-2）、sample_5（5轮过1-2）或任意自定义参数。 */
export function resolveAleCalibrationPolicy(options?: Record<string, unknown>): AleCalibrationPolicy {
  const rawPreset = typeof options?.preset === 'string' ? options.preset : undefined;
  const preset: AleCalibrationPolicy['preset'] =
    rawPreset === 'sample_3' || rawPreset === 'sample_5' || rawPreset === 'formal_8plus1'
      ? rawPreset
      : options?.calibration_runs !== undefined
        ? 'custom'
        : 'formal_8plus1';

  const defaultRuns = preset === 'sample_3' ? 3 : preset === 'sample_5' ? 5 : 8;
  const calibrationRuns = clampInt(options?.calibration_runs, defaultRuns, 1, 16);

  const defaultMinPass = 1;
  const defaultMaxPass =
    calibrationRuns <= 2 ? 1 : calibrationRuns <= 5 ? 2 : Math.max(1, Math.floor(calibrationRuns * 0.375));
  const minPass = clampInt(options?.min_pass, defaultMinPass, 0, calibrationRuns);
  const maxPass = clampInt(options?.max_pass, defaultMaxPass, minPass, calibrationRuns);

  const defaultDemoReq = preset === 'sample_3' || preset === 'sample_5' ? 0 : calibrationRuns === 8 ? 1 : 0;
  const demoRequired = clampInt(options?.demo_required, defaultDemoReq, 0, 3);
  const demoMaxAttempts = clampInt(options?.demo_max_attempts, Math.max(demoRequired, 6), Math.max(1, demoRequired), 10);
  const demoParallel = clampInt(options?.demo_parallel, demoRequired > 0 ? 3 : 1, 1, 6);
  const concurrentDemoWithCalibration =
    demoRequired > 0
      ? typeof options?.concurrent_demo_with_calibration === 'boolean'
        ? options.concurrent_demo_with_calibration
        : true
      : false;

  const calibrationModel =
    typeof options?.calibration_model === 'string' && options.calibration_model.trim()
      ? options.calibration_model.trim()
      : 'gpt-6.1-sol';
  const demoModel =
    typeof options?.demo_model === 'string' && options.demo_model.trim()
      ? options.demo_model.trim()
      : 'gpt-5.6-sol';
  const reasoningEffort =
    typeof options?.reasoning_effort === 'string' && options.reasoning_effort.trim()
      ? options.reasoning_effort.trim()
      : 'max';
  const timeoutMinutes = clampInt(options?.timeout_minutes, 45, 5, 180);
  const isFormal8Plus1 =
    calibrationRuns === 8 && minPass === 1 && maxPass === 3 && demoRequired >= 1 && reasoningEffort === 'max';
  const earlyStopImpossible =
    typeof options?.early_stop_impossible === 'boolean' ? options.early_stop_impossible : !isFormal8Plus1;

  return {
    preset,
    calibration_runs: calibrationRuns,
    min_pass: minPass,
    max_pass: maxPass,
    demo_required: demoRequired,
    demo_max_attempts: demoMaxAttempts,
    demo_parallel: demoParallel,
    concurrent_demo_with_calibration: concurrentDemoWithCalibration,
    calibration_model: calibrationModel,
    demo_model: demoModel,
    reasoning_effort: reasoningEffort,
    timeout_minutes: timeoutMinutes,
    early_stop_impossible: earlyStopImpossible,
    is_formal_8plus1: isFormal8Plus1,
  };
}

/**
 * 纯状态机：根据当前已完成/运行中的单槽位子任务，决定下一步动作（补入队、等待、早停止损、成功或失败）。
 * 注意：单次标定运行中“被测模型未解出题（run_success=false）”属于有效观测（sub_run.status === 'succeeded'，result.run_success === false）；
 * 只有基建/CLI 崩溃才会使 sub_run.status === 'failed'。
 */
export function planAleCalibrationSubRuns(ctx: SubRunPlanContext): SubRunDecision {
  const policy = resolveAleCalibrationPolicy(ctx.options);
  const relevant = ctx.sub_runs.filter((r) => r.status !== 'skipped' && r.status !== 'cancelled');

  const calRuns = relevant.filter((r) => r.sub_run_key.startsWith('cal_run_'));
  const demoRuns = relevant.filter((r) => r.sub_run_key.startsWith('demo_run_'));

  const completedCal = calRuns.filter((r) => r.status === 'succeeded');
  const activeCal = calRuns.filter((r) => r.status === 'waiting' || r.status === 'running');
  const calPassCount = completedCal.filter((r) => r.result?.run_success === true).length;
  const calFailCount = completedCal.length - calPassCount;

  const completedDemo = demoRuns.filter((r) => r.status === 'succeeded');
  const activeDemo = demoRuns.filter((r) => r.status === 'waiting' || r.status === 'running');
  const demoPassCount = completedDemo.filter((r) => r.result?.run_success === true).length;

  const baseSummary = {
    mode: policy.is_formal_8plus1 ? 'formal_8plus1' : 'configurable_sampling',
    policy,
    calibration_completed: completedCal.length,
    calibration_total: policy.calibration_runs,
    calibration_pass_count: calPassCount,
    calibration_fail_count: calFailCount,
    demo_completed: completedDemo.length,
    demo_pass_count: demoPassCount,
  };

  // 0. 任一子任务发生基建/环境故障 -> 立即中止整步并取消所有尚在 waiting 的标定与示范子任务
  const infraFailed = relevant.find((r) => r.status === 'failed');
  if (infraFailed) {
    const reason = `子任务 ${infraFailed.sub_run_key} 发生执行或环境故障：${infraFailed.error ?? '未知错误'}`;
    return {
      action: 'early_stop_failed',
      reason,
      progress_label: `故障中止（${infraFailed.sub_run_key}）`,
      cancel_waiting_sub_runs: true,
      summary: { ...baseSummary, infra_failed_sub_run: infraFailed.sub_run_key },
      repair_evaluation: buildAleCalibrationRepairEvaluation({ sub_runs: relevant, policy, reason }),
    };
  }

  // 1. 过易早停：一旦已成功次数超出 max_pass，立即熔断取消未开始的排队子任务（同时撤掉未启动的 cal_run 与 demo_run）
  if (calPassCount > policy.max_pass) {
    const reason = `已完成 ${completedCal.length}/${policy.calibration_runs} 轮中已有 ${calPassCount} 轮成功，超出允许上限 ${policy.max_pass}（题目偏简单），触发早停止损`;
    return {
      action: 'early_stop_failed',
      reason,
      progress_label: `早停淘汰：${calPassCount}/${completedCal.length} 成功（超上限 ${policy.max_pass}）`,
      cancel_waiting_sub_runs: true,
      summary: baseSummary,
      repair_evaluation: buildAleCalibrationRepairEvaluation({ sub_runs: completedCal, policy, reason }),
    };
  }

  // 2. 抽测或显式开启必败早停模式下，若剩余轮次全对也已无法达到 min_pass，提前止损并撤掉未启动子任务
  const maxPossiblePasses = calPassCount + (policy.calibration_runs - completedCal.length);
  if (policy.early_stop_impossible && maxPossiblePasses < policy.min_pass && completedCal.length < policy.calibration_runs) {
    const reason = `已完成 ${completedCal.length}/${policy.calibration_runs} 轮仅成功 ${calPassCount} 轮，剩余轮次即使全过也无法达到下限 ${policy.min_pass}，触发早停止损`;
    return {
      action: 'early_stop_failed',
      reason,
      progress_label: `早停淘汰：${calPassCount}/${completedCal.length} 成功（已无望达标）`,
      cancel_waiting_sub_runs: true,
      summary: baseSummary,
      repair_evaluation: buildAleCalibrationRepairEvaluation({ sub_runs: completedCal, policy, reason }),
    };
  }

  // 3. 第 1 阶段（N 次难度标定）尚未跑满：计算待入队的 cal_run_XX；
  //    若开启 concurrent_demo_with_calibration 且 demo_required > 0，首轮同步规划第一波 demo_run_01..demo_parallel 一并入队。
  //    若示范轨迹已提前达标（demoPassCount >= demo_required），不再补发新的 demo_run，且严禁提前判整体成功，继续等待标定全部完成。
  if (completedCal.length < policy.calibration_runs) {
    const existingCalKeys = new Set(calRuns.map((r) => r.sub_run_key));
    const nextSpecs: PlannedSubRunSpec[] = [];
    for (let i = 1; i <= policy.calibration_runs; i += 1) {
      const key = `cal_run_${String(i).padStart(2, '0')}`;
      if (!existingCalKeys.has(key)) {
        nextSpecs.push({
          sub_run_key: key,
          input: { phase: 'calibration', run_index: i, model: policy.calibration_model },
        });
      }
    }

    const firstDemoWave = Math.min(policy.demo_parallel, policy.demo_max_attempts);
    if (policy.concurrent_demo_with_calibration && policy.demo_required > 0 && demoPassCount < policy.demo_required) {
      const existingDemoKeys = new Set(demoRuns.map((r) => r.sub_run_key));
      for (let k = 1; k <= firstDemoWave; k += 1) {
        const key = `demo_run_${String(k).padStart(2, '0')}`;
        if (!existingDemoKeys.has(key)) {
          nextSpecs.push({
            sub_run_key: key,
            input: { phase: 'clean_trajectory', run_index: k, model: policy.demo_model },
          });
        }
      }
    }

    const demoNote =
      policy.concurrent_demo_with_calibration && policy.demo_required > 0
        ? demoPassCount >= policy.demo_required
          ? `；示范已过 ${demoPassCount} 条，等待标定完成`
          : completedDemo.length >= firstDemoWave && activeDemo.length === 0
            ? `；首波示范 0/${completedDemo.length}，待标定过线后补发`
            : `；并发示范 ${firstDemoWave} 路`
        : '';
    const label = `标定进行中 ${completedCal.length}/${policy.calibration_runs}（当前成功 ${calPassCount}，目标 ${policy.min_pass}–${policy.max_pass}${demoNote}）`;
    if (nextSpecs.length > 0) {
      return { action: 'enqueue', next_sub_runs: nextSpecs, progress_label: label, summary: baseSummary };
    }
    return {
      action: 'wait',
      progress_label: `${label}，等待 ${activeCal.length} 个运行中标定槽位完成`,
      summary: baseSummary,
    };
  }

  // 4. 第 1 阶段全部完成：核验是否落在 [min_pass, max_pass] 区间；未达标立即止损并取消所有 waiting 的排队子任务
  if (calPassCount < policy.min_pass || calPassCount > policy.max_pass) {
    const reason = `标定未达标：完成 ${policy.calibration_runs} 轮，成功 ${calPassCount} 轮，不在目标区间 [${policy.min_pass}, ${policy.max_pass}] 内`;
    return {
      action: 'early_stop_failed',
      reason,
      progress_label:
        activeDemo.length > 0
          ? `未达标：${calPassCount}/${policy.calibration_runs} 成功（取消剩余示范任务）`
          : `未达标：${calPassCount}/${policy.calibration_runs} 成功`,
      cancel_waiting_sub_runs: true,
      summary: baseSummary,
      repair_evaluation: buildAleCalibrationRepairEvaluation({ sub_runs: completedCal, policy, reason }),
    };
  }

  // 5. 若无需采集额外示范轨迹（如 3 轮/5 轮快速抽测模式 demo_required=0），直接判定通过！
  if (policy.demo_required === 0) {
    return {
      action: 'succeeded',
      progress_label: `抽测达标：${calPassCount}/${policy.calibration_runs} 成功`,
      cancel_waiting_sub_runs: true,
      summary: {
        ...baseSummary,
        qualification_status: policy.is_formal_8plus1 ? 'formal_qualified' : 'sampling_qualified',
      },
    };
  }

  // 6. 第 2 阶段：标定已过线，闭环核算示范轨迹：
  //    (a) 已达 demo_required -> 立即 succeeded 并取消多余 waiting 示范任务；
  //    (b) 当前波次仍有运行/排队的 demo_run -> wait 等待本波跑完；
  //    (c) 当前波次全部未过且总尝试 < demo_max_attempts -> 按波补发最多 demo_parallel 路；
  //    (d) demo_max_attempts 耗尽仍未达标 -> failed。
  if (demoPassCount >= policy.demo_required) {
    return {
      action: 'succeeded',
      progress_label: `全部达标：标定 ${calPassCount}/${policy.calibration_runs} + 示范成功 ${demoPassCount} 条`,
      cancel_waiting_sub_runs: true,
      summary: {
        ...baseSummary,
        qualification_status: policy.is_formal_8plus1 ? 'formal_qualified' : 'custom_qualified',
      },
    };
  }

  if (activeDemo.length > 0) {
    return {
      action: 'wait',
      progress_label: `标定已过（${calPassCount}/${policy.calibration_runs}），等待当前波次示范轨迹完成（运行/排队中 ${activeDemo.length} 路，已派发 ${demoRuns.length}/${policy.demo_max_attempts} 次）`,
      summary: baseSummary,
    };
  }

  const remainingAllowed = Math.max(0, policy.demo_max_attempts - demoRuns.length);
  const nextWaveCount = Math.min(policy.demo_parallel, remainingAllowed);
  if (nextWaveCount > 0) {
    const existingDemoKeys = new Set(demoRuns.map((r) => r.sub_run_key));
    const nextDemoSpecs: PlannedSubRunSpec[] = [];
    for (let idx = 1; idx <= policy.demo_max_attempts && nextDemoSpecs.length < nextWaveCount; idx += 1) {
      const key = `demo_run_${String(idx).padStart(2, '0')}`;
      if (!existingDemoKeys.has(key)) {
        nextDemoSpecs.push({
          sub_run_key: key,
          input: { phase: 'clean_trajectory', run_index: idx, model: policy.demo_model },
        });
      }
    }
    if (nextDemoSpecs.length > 0) {
      const waveLabel = demoRuns.length === 0 ? '并发派发' : '补发下一波';
      return {
        action: 'enqueue',
        next_sub_runs: nextDemoSpecs,
        progress_label: `标定已过（${calPassCount}/${policy.calibration_runs}），${waveLabel} ${nextDemoSpecs.length} 路示范轨迹（总第 ${demoRuns.length + 1}–${demoRuns.length + nextDemoSpecs.length}/${policy.demo_max_attempts} 次）`,
        summary: baseSummary,
      };
    }
  }

  const demoFailReason = `标定已通过（${calPassCount}/${policy.calibration_runs}），但示范模型 ${policy.demo_model} 尝试 ${completedDemo.length} 次仅成功 ${demoPassCount} 条（要求至少 ${policy.demo_required} 条）`;
  return {
    action: 'failed',
    reason: demoFailReason,
    progress_label: `示范轨迹未达标（${demoPassCount}/${completedDemo.length}，要求 ${policy.demo_required}）`,
    summary: baseSummary,
    repair_evaluation: buildAleCalibrationRepairEvaluation({
      sub_runs: [...completedCal, ...completedDemo],
      policy,
      reason: demoFailReason,
    }),
  };
}

const inflightStagedDirs = new Map<string, Promise<string>>();

async function resolveStagedTaskDir(ctx: IsolatedRunContext): Promise<string> {
  const stagedTasksBase = join(ctx.project_workflow_dir, 'staged', 'tasks');
  if (existsSync(stagedTasksBase)) {
    const dirs = await readdir(stagedTasksBase, { withFileTypes: true });
    const first = dirs.find((d: { isDirectory(): boolean; name: string }) => d.isDirectory());
    if (first) return join(stagedTasksBase, first.name);
  }
  const existing = inflightStagedDirs.get(ctx.project_workflow_dir);
  if (existing) return existing;

  const taskPromise = (async () => {
    const inputMaterials = await prepareStagedMaterialsForAleDraft(ctx.question_draft, ctx.attachments);
    const built = await materializeAleTaskFromDraft({
      draft: ctx.question_draft,
      taskIdFallback: `ALE-${ctx.workflow_id.slice(0, 8).toUpperCase()}`,
      inputMaterials,
      outputParentDir: join(ctx.project_workflow_dir, 'staged'),
      executeDynamic: false,
    });
    return built.task_dir;
  })().finally(() => {
    inflightStagedDirs.delete(ctx.project_workflow_dir);
  });

  inflightStagedDirs.set(ctx.project_workflow_dir, taskPromise);
  return taskPromise;
}

/** 执行单个 1 槽位原子子运行（调用本机隔离 Codex CLI 跑 1 次并离线调用 grade.py 评分；若显式传入 regrade_only=true 则秒级离线重评已保存产物）。 */
export async function executeAleCalibrationSubRun(ctx: IsolatedRunContext): Promise<Record<string, unknown>> {
  const policy = resolveAleCalibrationPolicy(ctx.run_config);
  const isDemo = ctx.sub_run_key.startsWith('demo_run_');
  const targetModel = isDemo ? policy.demo_model : policy.calibration_model;
  const role = isDemo ? 'clean_trajectory' : 'calibration_8x';
  const taskDir = await resolveStagedTaskDir(ctx);

  if (ctx.run_config.regrade_only === true) {
    const savedArtifactsDir = join(taskDir, 'runs', targetModel, ctx.sub_run_key, 'artifacts');
    if (isDemo && !existsSync(savedArtifactsDir)) {
      return {
        passed: true,
        mode: 'regrade_only',
        sub_run_key: ctx.sub_run_key,
        phase: role,
        model: targetModel,
        reasoning_effort: policy.reasoning_effort,
        run_success: false,
        normalized_score: null,
        failed_items: [],
        missing_saved_artifacts: true,
      };
    }
    const regraded = await regradeSavedRuns(taskDir, targetModel, ctx.sub_run_key);
    const hit = regraded.runs[0];
    if (!hit) throw new Error(`未找到可供离线重评的已存产物: ${ctx.sub_run_key}`);
    return {
      passed: true,
      mode: 'regrade_only',
      sub_run_key: ctx.sub_run_key,
      phase: role,
      model: targetModel,
      reasoning_effort: policy.reasoning_effort,
      run_success: hit.success,
      normalized_score: hit.normalized_score,
      failed_items: hit.failed_items ?? [],
      run_dir: hit.run_dir,
    };
  }

  const out = await runCalibration({
    taskDir,
    runs: 1,
    parallel: 1,
    model: targetModel,
    reasoningEffort: policy.reasoning_effort,
    role,
    runPrefix: isDemo ? 'demo_run_' : 'cal_run_',
    exactRunId: ctx.sub_run_key,
    timeoutMinutes: policy.timeout_minutes,
    dryRun: false,
    force: false,
  });

  const single = out.runs[0];
  if (!single) {
    throw new Error(`未获得子任务 ${ctx.sub_run_key} 的运行结果`);
  }

  return {
    passed: true,
    sub_run_key: ctx.sub_run_key,
    phase: role,
    model: targetModel,
    reasoning_effort: policy.reasoning_effort,
    run_success: single.success,
    normalized_score: single.normalized_score,
    failed_items: single.failed_items ?? [],
    model_turns: single.model_turns,
    tool_calls: single.tool_calls,
    total_tokens: single.total_tokens,
    termination_status: single.termination_status,
    run_dir: single.run_dir,
  };
}

export function buildAleCalibrationRepairEvaluation(params: {
  sub_runs: ReadonlyArray<RecordedSubRun>;
  decision?: SubRunDecision;
  policy?: AleCalibrationPolicy;
  reason?: string | null;
}): RepairEvaluationJson {
  const infraFailedRun = params.sub_runs.find(
    (r) => r.status === 'failed' && (r.sub_run_key.startsWith('cal_run_') || r.sub_run_key.startsWith('demo_run_')),
  );
  const calRuns = params.sub_runs.filter((r) => r.sub_run_key.startsWith('cal_run_') && r.status === 'succeeded');
  const demoRuns = params.sub_runs.filter((r) => r.sub_run_key.startsWith('demo_run_') && r.status === 'succeeded');
  const policy = params.policy ?? resolveAleCalibrationPolicy(calRuns[0]?.config ?? demoRuns[0]?.config ?? infraFailedRun?.config);
  const passCount = calRuns.filter((r) => r.result?.run_success === true).length;
  const totalRuns = calRuns.length;

  if (infraFailedRun) {
    return {
      schema_version: 'custom_repair_eval_v1',
      verdict: 'manual_override',
      recommended_scope: 'grader_only_regrade',
      pass_count: passCount,
      total_runs: totalRuns,
      target_pass_range: [policy.min_pass, policy.max_pass],
      failed_criteria_hotspots: [],
      action_items: [
        `排查并修复子任务 ${infraFailedRun.sub_run_key} 的执行或环境故障（${infraFailedRun.error ?? '未知错误'}），无需修改题面，恢复环境后重跑`,
      ],
      ...(params.reason ? { notes: params.reason } : {}),
      generated_at: new Date().toISOString(),
      updated_by: 'auto_diagnostic',
    };
  }

  const calBandPassed =
    totalRuns >= policy.calibration_runs && passCount >= policy.min_pass && passCount <= policy.max_pass;
  const diagnosticSourceRuns = calBandPassed && demoRuns.length > 0 ? demoRuns : calRuns;
  const diagnosticDenom = diagnosticSourceRuns.length;

  const failCounts = new Map<string, { count: number; samples: unknown[] }>();
  for (const run of diagnosticSourceRuns) {
    const failedItems = Array.isArray(run.result?.failed_items)
      ? (run.result!.failed_items as Array<{ criterion_id?: unknown; observed?: unknown }>)
      : [];
    for (const item of failedItems) {
      const cid = String(item?.criterion_id ?? 'unknown');
      const cur = failCounts.get(cid) ?? { count: 0, samples: [] };
      cur.count += 1;
      if (cur.samples.length < 3 && item?.observed !== undefined) cur.samples.push(item.observed);
      failCounts.set(cid, cur);
    }
  }

  const hotspots = [...failCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([criterion_id, info]) => ({
      criterion_id,
      fail_rate: diagnosticDenom > 0 ? Number((info.count / diagnosticDenom).toFixed(3)) : 0,
      observed_samples: info.samples,
    }));

  const tooEasy = passCount > policy.max_pass;
  const hasUniversalFail = diagnosticDenom >= 2 && hotspots.some((h) => h.fail_rate === 1);

  const verdict: RepairEvaluationJson['verdict'] = tooEasy
    ? 'too_easy_tighten'
    : hasUniversalFail
      ? 'needs_grader_patch'
      : 'too_hard_relax';

  const recommendedScope: RepairEvaluationJson['recommended_scope'] = tooEasy
    ? 'incremental_question_patch'
    : hasUniversalFail
      ? 'grader_only_regrade'
      : 'incremental_question_patch';

  const actions: string[] = [];
  if (tooEasy) {
    actions.push(
      `当前 ${passCount}/${totalRuns} 轮通过（超出上限 ${policy.max_pass}）：在现有题包基础上增加 1–2 处跨表隐蔽勾稽或收紧关键门控，无需重写整题`,
    );
  } else if (calBandPassed) {
    const topDemoIds = hotspots.slice(0, 3).map((h) => h.criterion_id).join(', ');
    actions.push(
      `标定已达标（${passCount}/${totalRuns}），但示范模型 ${policy.demo_model} 连续 ${demoRuns.length} 次未达标：核查示范高频失分项 [${topDemoIds}] 是否存在判分容差过严或口径歧义`,
    );
  } else if (hasUniversalFail) {
    const universalIds = hotspots.filter((h) => h.fail_rate === 1).map((h) => h.criterion_id);
    actions.push(
      `发现全轮次 100% 失分项 [${universalIds.join(', ')}]：优先核查 grade.py 是否存在同义页码/区间正则误杀、标答真值漏页或非核心项一票否决；若题面未改，修补 grade.py 后可直接秒级离线重评已有产物（免重跑模型）`,
    );
  } else {
    actions.push(
      `当前 ${passCount}/${totalRuns} 轮通过（低于下限 ${policy.min_pass}）：基于现有题包明确热点失分项 [${hotspots
        .slice(0, 3)
        .map((h) => h.criterion_id)
        .join(', ')}] 的口径约定或调整 70/30 门控权重后局部重测`,
    );
  }

  return {
    schema_version: 'custom_repair_eval_v1',
    verdict,
    recommended_scope: recommendedScope,
    pass_count: passCount,
    total_runs: totalRuns,
    target_pass_range: [policy.min_pass, policy.max_pass],
    failed_criteria_hotspots: hotspots,
    action_items: actions,
    ...(params.reason ? { notes: params.reason } : {}),
    generated_at: new Date().toISOString(),
    updated_by: 'auto_diagnostic',
  };
}
