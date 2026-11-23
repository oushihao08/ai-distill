/**
 * 职责：定义项目级隔离定制步骤（Custom Steps）的纯类型契约、前后置挂载锚点、8 路并发子运行协议与结构化返修评价 JSON 契约。
 * 主要公开入口：`CustomStepDefinition`、`RepairEvaluationJson`、`validateRepairEvaluationJson`、`MAX_ALLOWED_PARALLEL_SUBRUNS`。
 * 维护边界：本文件属核心通用插座层，严禁引入任何具体项目（如 ALE、豆包、Work）的业务常量或分支。
 */

export type CustomStepLane = 'internal' | 'agent' | 'api';
export type CustomStepPlacement = 'before' | 'after';
export type CustomStepStatus = 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** 单题多子运行（如 8+1 正式标定与并发示范采集）允许的最大并发路数上限（每路固定占 1 个 Agent 槽位）。 */
export const MAX_ALLOWED_PARALLEL_SUBRUNS = 12;

export interface CustomStepAnchor {
  /** 挂载围绕的基础步骤稳定 ordinal（如 4=出题，8=交付归档）。 */
  ordinal: 1 | 4 | 8 | 9;
  /** 位于基础步骤之前（派发前置关卡）或之后（独立排队扩展步骤）。 */
  placement: CustomStepPlacement;
  /** 同一锚点同一方向下的稳定正整数顺序（从 1 开始）。 */
  order: number;
}

/** 强制为结构化 JSON 对象的返修评价记录（持久化于 custom_step_runs.repair_evaluation jsonb）。 */
export interface RepairEvaluationJson {
  schema_version: 'custom_repair_eval_v1';
  verdict:
    | 'needs_grader_patch'
    | 'needs_prompt_and_grader_patch'
    | 'too_easy_tighten'
    | 'too_hard_relax'
    | 'verify_gate_blocked'
    | 'manual_override';
  /**
   * 推荐返修方式：
   * - `grader_only_regrade`：题面与输入不变，仅修补 grade.py / rubric.json 后对已有轨迹产物秒级离线重评（0 模型耗时）；
   * - `incremental_question_patch`：基于当前题包做局部补丁微调（不重读全卷重写）；
   * - `full_reauthor`：立意或结构不成立，整体重出。
   */
  recommended_scope: 'grader_only_regrade' | 'incremental_question_patch' | 'full_reauthor';
  pass_count?: number;
  total_runs?: number;
  target_pass_range?: [number, number];
  failed_criteria_hotspots: Array<{
    criterion_id: string;
    fail_rate: number;
    observed_samples: unknown[];
  }>;
  action_items: string[];
  notes?: string;
  generated_at: string;
  updated_by: 'auto_diagnostic' | 'user';
}

export function validateRepairEvaluationJson(raw: unknown): RepairEvaluationJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('返修评价 repair_evaluation 必须是 JSON 对象，不允许纯字符串或数组');
  }
  const obj = raw as Record<string, unknown>;
  const validVerdicts = new Set([
    'needs_grader_patch',
    'needs_prompt_and_grader_patch',
    'too_easy_tighten',
    'too_hard_relax',
    'verify_gate_blocked',
    'manual_override',
  ]);
  const validScopes = new Set(['grader_only_regrade', 'incremental_question_patch', 'full_reauthor']);
  const verdict = typeof obj.verdict === 'string' && validVerdicts.has(obj.verdict) ? (obj.verdict as RepairEvaluationJson['verdict']) : 'manual_override';
  const recommendedScope =
    typeof obj.recommended_scope === 'string' && validScopes.has(obj.recommended_scope)
      ? (obj.recommended_scope as RepairEvaluationJson['recommended_scope'])
      : 'incremental_question_patch';

  const actionItems = Array.isArray(obj.action_items)
    ? obj.action_items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  if (!actionItems.length) {
    throw new Error('返修评价 JSON 必须至少包含 1 条非空 action_items 修改指令');
  }

  const hotspots = Array.isArray(obj.failed_criteria_hotspots)
    ? obj.failed_criteria_hotspots
        .filter((h): h is Record<string, unknown> => Boolean(h && typeof h === 'object' && !Array.isArray(h)))
        .map((h) => ({
          criterion_id: String(h.criterion_id ?? 'unknown'),
          fail_rate: typeof h.fail_rate === 'number' && Number.isFinite(h.fail_rate) ? h.fail_rate : 0,
          observed_samples: Array.isArray(h.observed_samples) ? h.observed_samples.slice(0, 5) : [],
        }))
    : [];

  return {
    schema_version: 'custom_repair_eval_v1',
    verdict,
    recommended_scope: recommendedScope,
    ...(typeof obj.pass_count === 'number' ? { pass_count: obj.pass_count } : {}),
    ...(typeof obj.total_runs === 'number' ? { total_runs: obj.total_runs } : {}),
    ...(Array.isArray(obj.target_pass_range) &&
    obj.target_pass_range.length === 2 &&
    typeof obj.target_pass_range[0] === 'number' &&
    typeof obj.target_pass_range[1] === 'number'
      ? { target_pass_range: [obj.target_pass_range[0], obj.target_pass_range[1]] }
      : {}),
    failed_criteria_hotspots: hotspots,
    action_items: actionItems,
    ...(typeof obj.notes === 'string' && obj.notes.trim() ? { notes: obj.notes.trim() } : {}),
    generated_at: typeof obj.generated_at === 'string' && obj.generated_at ? obj.generated_at : new Date().toISOString(),
    updated_by: obj.updated_by === 'auto_diagnostic' ? 'auto_diagnostic' : 'user',
  };
}

export interface InlineBeforeGateContext {
  project_key: string;
  project_id: string;
  workflow_id: string;
  materials: ReadonlyArray<{ id: string; sha256: string; text?: string; source_names?: string[] }>;
  model_materials?: ReadonlyArray<{ id: string; sha256: string; text?: string; source_names?: string[] }>;
  authoring_direction?: string | null;
}

export interface InlineBeforeGateOutput {
  /** 写入本次主步骤冻结输入的只读扩展元数据（关在 custom_before_gates 命名空间内，不覆盖主字段）。 */
  frozen_metadata?: Record<string, unknown>;
}

export interface RecordedSubRun {
  id: string;
  sub_run_key: string;
  status: CustomStepStatus;
  config: Record<string, unknown>;
  result: Record<string, unknown> | null;
  repair_evaluation?: RepairEvaluationJson | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface PlannedSubRunSpec {
  sub_run_key: string;
  config?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

export type SubRunDecision =
  | {
      action: 'enqueue';
      /** 本轮需要补充入队的原子子运行（调度器按 max_parallel_subruns 控制并发路数，支持最高 8 路并发）。 */
      next_sub_runs: PlannedSubRunSpec[];
      progress_label: string;
      summary?: Record<string, unknown>;
    }
  | {
      action: 'wait';
      progress_label: string;
      summary?: Record<string, unknown>;
    }
  | {
      action: 'early_stop_failed';
      reason: string;
      progress_label: string;
      cancel_waiting_sub_runs: boolean;
      summary?: Record<string, unknown>;
      repair_evaluation?: RepairEvaluationJson;
    }
  | {
      action: 'succeeded';
      progress_label: string;
      cancel_waiting_sub_runs?: boolean;
      summary: Record<string, unknown>;
    }
  | {
      action: 'failed';
      reason: string;
      progress_label: string;
      summary?: Record<string, unknown>;
      repair_evaluation?: RepairEvaluationJson;
    };

export interface SubRunPlanContext {
  project_key: string;
  workflow_id: string;
  source_digest: string;
  options?: Record<string, unknown>;
  sub_runs: ReadonlyArray<RecordedSubRun>;
}

export interface IsolatedRunContext {
  project_key: string;
  project_id: string;
  workflow_id: string;
  step_key: string;
  sub_run_key: string;
  source_digest: string;
  sandbox_dir: string;
  project_workflow_dir: string;
  question_draft: Record<string, unknown>;
  attachments: ReadonlyArray<{
    id: string;
    name: string;
    sha256: string;
    text: string;
    model_sha256?: string;
    model_text?: string;
  }>;
  run_config: Record<string, unknown>;
  run_input: Record<string, unknown>;
  signal: AbortSignal;
}

export interface CustomStepDefinition {
  project_key: string;
  step_key: string;
  name: string;
  description: string;
  anchor: CustomStepAnchor;
  mode: 'inline_before_gate' | 'queued_single' | 'queued_subruns';
  lane: CustomStepLane;
  /** 仅对 queued_subruns 生效：同一题目同时排队/运行的子任务上限（1..8），每次子任务独立占 1 个槽位。 */
  max_parallel_subruns?: number;
  blocks_downstream_ordinal?: 8;
  allow_explicit_pilot_skip?: boolean;
  runBeforeGate?: (ctx: InlineBeforeGateContext) => Promise<InlineBeforeGateOutput> | InlineBeforeGateOutput;
  planSubRuns?: (ctx: SubRunPlanContext) => SubRunDecision;
  executeRun?: (ctx: IsolatedRunContext) => Promise<Record<string, unknown>>;
  buildRepairEvaluation?: (ctx: {
    sub_runs: ReadonlyArray<RecordedSubRun>;
    decision?: SubRunDecision;
    result?: Record<string, unknown> | null;
    error?: string | null;
  }) => RepairEvaluationJson | null;
}

export interface WorkflowCustomStepView {
  project_key: string;
  step_key: string;
  name: string;
  description: string;
  anchor: CustomStepAnchor;
  mode: CustomStepDefinition['mode'];
  lane: CustomStepLane;
  max_parallel_subruns: number | null;
  blocks_downstream_ordinal: number | null;
  allow_explicit_pilot_skip: boolean;
  status: 'not_started' | CustomStepStatus;
  ready: boolean;
  ready_reason: string | null;
  progress_label: string | null;
  summary: Record<string, unknown> | null;
  repair_evaluation: RepairEvaluationJson | null;
  error: string | null;
  active_sub_runs: number;
  total_sub_runs: number;
  sub_runs: RecordedSubRun[];
}
