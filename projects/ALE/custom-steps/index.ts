/**
 * 职责：ALE 主项目专属定制步骤唯一注册清单。
 * 主要公开入口：`ALE_CUSTOM_STEPS`、`registerAleCustomSteps(registry)`。
 * 隔离边界：所有实现均封装于 `projects/ALE/` 内部目录，仅服务 `project_key === "ALE"`，不影响豆包、Work 等其他任何项目。
 */
import { defineProjectCustomSteps, type CustomStepRegistry } from '../../../server/custom-steps/registry';
import {
  buildAleCalibrationRepairEvaluation,
  executeAleCalibrationSubRun,
  planAleCalibrationSubRuns,
} from './calibrate-8plus1';
import { runAlePreAuthoringLock } from './pre-authoring-lock';
import { buildAleVerifyRepairEvaluation, executeAleVerifyGate } from './verify-gate';

export const ALE_PROJECT_KEY = 'ALE';

export const ALE_CUSTOM_STEPS = defineProjectCustomSteps(ALE_PROJECT_KEY, [
  {
    step_key: 'ale_pre_authoring_lock',
    name: 'ALE 出题前输入哈希锁定',
    description: '出题派发前自动校验材料非空并锁定挂载进 environment/input/ 的精确文件名与 SHA-256。',
    anchor: { ordinal: 4, placement: 'before', order: 1 },
    mode: 'inline_before_gate',
    lane: 'internal',
    runBeforeGate: runAlePreAuthoringLock,
  },
  {
    step_key: 'ale_verify_gate',
    name: 'ALE 题包构建与反例硬筛',
    description: '0 模型槽位秒级展开题包，校验门控分层并实跑参考基线、空提交与 9 类单因子错误反例，未通过时自动输出结构化返修评价 JSON。',
    anchor: { ordinal: 4, placement: 'after', order: 1 },
    mode: 'queued_single',
    lane: 'internal',
    blocks_downstream_ordinal: 8,
    allow_explicit_pilot_skip: false,
    executeRun: executeAleVerifyGate,
    buildRepairEvaluation: buildAleVerifyRepairEvaluation,
  },
  {
    step_key: 'ale_calibrate_8plus1',
    name: 'ALE 难度标定与轨迹采集（支持 8+3 并发标定及 3/5 轮抽测）',
    description:
      '每次子运行占 1 个 Agent 槽位，正式 8+1 默认首轮 8 路标定 + 3 路示范（11 路）并发同跑，超上限/必败自动早停撤单；未达标时自动聚合失分热点写入结构化返修评价 JSON，支持只改判分器秒级重评。',
    anchor: { ordinal: 4, placement: 'after', order: 2 },
    mode: 'queued_subruns',
    lane: 'agent',
    max_parallel_subruns: 12,
    blocks_downstream_ordinal: 8,
    allow_explicit_pilot_skip: true,
    planSubRuns: planAleCalibrationSubRuns,
    executeRun: executeAleCalibrationSubRun,
    buildRepairEvaluation: buildAleCalibrationRepairEvaluation,
  },
]);

export function registerAleCustomSteps(registry: CustomStepRegistry): () => void {
  return registry.registerProject(ALE_PROJECT_KEY, ALE_CUSTOM_STEPS);
}
