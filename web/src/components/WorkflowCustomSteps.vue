<!-- 职责：展示与操控当前项目注册的专属定制步骤（如 ALE 反例硬筛、8 路全并发 8+1 / 3 / 5 轮标定、结构化 JSON 返修评价与秒级重评）；未注册项目零渲染。 -->
<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel } from '../utils/format';

interface RepairEvaluationJson {
  schema_version: 'custom_repair_eval_v1';
  verdict: string;
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

interface SubRunRecord {
  id: string;
  sub_run_key: string;
  status: string;
  config: Record<string, unknown>;
  result: Record<string, unknown> | null;
  repair_evaluation?: RepairEvaluationJson | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface CustomStepView {
  project_key: string;
  step_key: string;
  name: string;
  description: string;
  anchor: { ordinal: number; placement: 'before' | 'after'; order: number };
  mode: 'inline_before_gate' | 'queued_single' | 'queued_subruns';
  lane: 'internal' | 'agent' | 'api';
  max_parallel_subruns: number | null;
  blocks_downstream_ordinal: number | null;
  allow_explicit_pilot_skip: boolean;
  status: 'not_started' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  ready: boolean;
  ready_reason: string | null;
  progress_label: string | null;
  summary: Record<string, unknown> | null;
  repair_evaluation: RepairEvaluationJson | null;
  error: string | null;
  active_sub_runs: number;
  total_sub_runs: number;
  sub_runs: SubRunRecord[];
}

const props = defineProps<{
  workflowId: string;
  authoringStatus?: string;
}>();
const emit = defineEmits<{ updated: [] }>();

const loaded = shallowRef(false);
const available = shallowRef(true);
const busyStep = shallowRef<string | null>(null);
const refreshing = shallowRef(false);
const error = shallowRef('');
const notice = shallowRef('');
const steps = shallowRef<CustomStepView[]>([]);

const calibrationPreset = shallowRef<'formal_8plus1' | 'sample_5' | 'sample_3'>('formal_8plus1');
const parallelLimit = shallowRef<number>(8);

const editingRepairStep = shallowRef<string | null>(null);
const repairJsonDraft = shallowRef('');

const presetOptions = [
  { title: '正式 8+1 标定（8 路并发，通过 1–3 次 + 示范轨迹）', value: 'formal_8plus1' },
  { title: '5 轮打版抽测（5 路并发，通过 1–2 次达标）', value: 'sample_5' },
  { title: '3 轮快速抽测（3 路并发，通过 1–2 次达标）', value: 'sample_3' },
];
const parallelOptions = [
  { title: '8 路全并发（8+1 默认一轮跑完）', value: 8 },
  { title: '5 路并发', value: 5 },
  { title: '3 路并发', value: 3 },
  { title: '2 路并发', value: 2 },
  { title: '单路串行（占 1 槽）', value: 1 },
];

watch(calibrationPreset, (val) => {
  parallelLimit.value = val === 'formal_8plus1' ? 8 : val === 'sample_5' ? 5 : 3;
});

const statusText: Record<string, string> = {
  not_started: '待执行',
  waiting: '排队中',
  running: '执行中',
  succeeded: '已通过',
  failed: '未通过',
  cancelled: '已取消',
  skipped: '已失效',
};

const scopeLabels: Record<string, string> = {
  grader_only_regrade: '只修判分器并秒级重评（免重跑模型）',
  incremental_question_patch: '基于当前题包做局部增量微调',
  full_reauthor: '立意重做（整题重出）',
};

function statusColor(status: string) {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'primary';
  if (status === 'waiting') return 'warning';
  return 'secondary';
}

function laneLabel(step: CustomStepView) {
  if (step.lane === 'internal') return '本地校验（0 Agent 槽）';
  if (step.mode === 'queued_subruns') return `Agent 单槽子运行（最高 ${step.max_parallel_subruns ?? 8} 路并发）`;
  return 'Agent 队列';
}

async function load() {
  try {
    refreshing.value = true;
    error.value = '';
    const res = await api<{ available: boolean; steps: CustomStepView[] }>(`/workflows/${props.workflowId}/custom-steps`);
    available.value = res.available;
    steps.value = res.steps ?? [];
    loaded.value = true;
  } catch (cause) {
    if (cause instanceof Error && cause.message === '接口不存在') {
      steps.value = [];
      loaded.value = true;
      return;
    }
    error.value = cause instanceof Error ? cause.message : '读取项目专属步骤失败';
    loaded.value = true;
  } finally {
    refreshing.value = false;
  }
}

async function triggerStep(step: CustomStepView, regradeOnly = false) {
  try {
    busyStep.value = step.step_key;
    error.value = '';
    notice.value = '';
    const payload =
      step.mode === 'queued_subruns'
        ? {
            preset: calibrationPreset.value,
            max_parallel_subruns: parallelLimit.value,
            ...(regradeOnly ? { regrade_only: true } : {}),
          }
        : {};
    const res = await api<{ enqueued_ids: string[]; progress_label: string | null }>(
      `/workflows/${props.workflowId}/custom-steps/${step.step_key}/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    notice.value = res.progress_label || `${step.name} 已入队（${res.enqueued_ids.length} 个子任务）`;
    emit('updated');
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : `启动 ${step.name} 失败`;
  } finally {
    busyStep.value = null;
  }
}

function openRepairEditor(step: CustomStepView) {
  editingRepairStep.value = step.step_key;
  const fallback: RepairEvaluationJson = step.repair_evaluation ?? {
    schema_version: 'custom_repair_eval_v1',
    verdict: 'manual_override',
    recommended_scope: 'incremental_question_patch',
    failed_criteria_hotspots: [],
    action_items: ['请补充具体返修指令'],
    generated_at: new Date().toISOString(),
    updated_by: 'user',
  };
  repairJsonDraft.value = JSON.stringify(fallback, null, 2);
}

async function saveRepairJson(step: CustomStepView) {
  try {
    busyStep.value = step.step_key;
    error.value = '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(repairJsonDraft.value);
    } catch {
      throw new Error('返修评价必须是合法 JSON 对象格式');
    }
    await api(`/workflows/${props.workflowId}/custom-steps/${step.step_key}/repair-evaluation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repair_evaluation: parsed }),
    });
    editingRepairStep.value = null;
    notice.value = '结构化返修评价 JSON 已保存，下一次增量出题将自动注入该诊断';
    emit('updated');
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存返修评价 JSON 失败';
  } finally {
    busyStep.value = null;
  }
}

async function cancelStep(step: CustomStepView) {
  try {
    busyStep.value = step.step_key;
    error.value = '';
    notice.value = '';
    await api(`/workflows/${props.workflowId}/custom-steps/${step.step_key}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    notice.value = `${step.name} 已请求取消`;
    emit('updated');
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : `取消 ${step.name} 失败`;
  } finally {
    busyStep.value = null;
  }
}

onMounted(load);
watch(
  () => [props.workflowId, props.authoringStatus],
  () => {
    load();
  },
);
</script>

<template>
  <section v-if="loaded && steps.length > 0" class="surface-card p-16">
    <Column :gap="12">
      <Row x="between" y="center" wrap :gap="8">
        <Row y="center" :gap="8">
          <h2 class="section-title">项目专属质检、8+1 标定与返修诊断</h2>
          <v-chip size="small" color="secondary">{{ steps[0]?.project_key }}</v-chip>
        </Row>
        <v-btn variant="outlined" size="small" :loading="refreshing" :disabled="refreshing || !!busyStep" @click="load">
          刷新步骤
        </v-btn>
      </Row>

      <v-alert v-if="!available" type="warning" density="compact">
        当前数据库尚未执行 065_project_custom_steps.sql 迁移；应用迁移后即可在页面派发专属步骤与持久化 JSON 返修评价。
      </v-alert>
      <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" density="compact">{{ notice }}</v-alert>

      <Column v-for="step in steps" :key="step.step_key" :gap="8" class="border-t border-line-subtle pt-12">
        <Row x="between" y="center" wrap :gap="8">
          <Row y="center" wrap :gap="8">
            <span class="font-semibold text-sm">{{ step.name }}</span>
            <v-chip size="x-small" color="secondary">
              {{ step.anchor.placement === 'before' ? `步骤 ${step.anchor.ordinal} 前` : `出题后 #${step.anchor.order}` }}
            </v-chip>
            <v-chip size="x-small" variant="tonal" color="secondary">{{ laneLabel(step) }}</v-chip>
            <v-chip size="small" :color="statusColor(step.status)">{{ statusText[step.status] ?? step.status }}</v-chip>
          </Row>

          <Row y="center" wrap :gap="8">
            <v-btn
              v-if="step.active_sub_runs > 0"
              color="error"
              variant="outlined"
              size="small"
              :loading="busyStep === step.step_key"
              :disabled="!!busyStep"
              @click="cancelStep(step)"
            >
              取消运行
            </v-btn>
            <v-btn
              v-if="step.mode === 'queued_subruns' && step.total_sub_runs > 0 && step.active_sub_runs === 0"
              color="secondary"
              variant="outlined"
              size="small"
              :loading="busyStep === step.step_key"
              :disabled="!!busyStep || !step.ready"
              @click="triggerStep(step, true)"
            >
              仅重评已有产物
            </v-btn>
            <v-btn
              color="primary"
              variant="flat"
              size="small"
              :loading="busyStep === step.step_key"
              :disabled="!!busyStep || !step.ready"
              @click="triggerStep(step, false)"
            >
              {{ step.status === 'failed' || step.status === 'cancelled' ? '重新执行' : step.status === 'succeeded' ? '已完成' : '执行步骤' }}
            </v-btn>
          </Row>
        </Row>

        <p class="text-xs text-muted">{{ step.description }}</p>

        <Row v-if="step.mode === 'queued_subruns'" stack-on-mobile :gap="8">
          <v-select
            v-model="calibrationPreset"
            :items="presetOptions"
            item-title="title"
            item-value="value"
            label="标定轮数档位"
            density="compact"
            hide-details
            :disabled="step.active_sub_runs > 0 || !!busyStep"
          />
          <v-select
            v-model="parallelLimit"
            :items="parallelOptions"
            item-title="title"
            item-value="value"
            label="并发槽位数"
            density="compact"
            hide-details
            :disabled="step.active_sub_runs > 0 || !!busyStep"
          />
        </Row>

        <p v-if="step.progress_label" class="text-xs">{{ step.progress_label }}</p>
        <p v-if="!step.ready && step.ready_reason && step.status !== 'succeeded'" class="text-xs text-muted">
          前置说明：{{ step.ready_reason }}
        </p>
        <p v-if="step.error" class="text-xs text-danger whitespace-pre-wrap break-words">{{ step.error }}</p>

        <Column v-if="step.repair_evaluation || step.status === 'failed'" class="rounded border border-line-subtle p-12" :gap="8">
          <Row x="between" y="center" wrap :gap="8">
            <span class="text-xs font-semibold">
              返修评价（JSON）：{{
                step.repair_evaluation
                  ? scopeLabels[step.repair_evaluation.recommended_scope] ?? step.repair_evaluation.recommended_scope
                  : '尚未填写'
              }}
            </span>
            <v-btn
              v-if="editingRepairStep !== step.step_key"
              size="x-small"
              variant="text"
              :disabled="!!busyStep"
              @click="openRepairEditor(step)"
            >
              编辑 JSON
            </v-btn>
          </Row>

          <template v-if="editingRepairStep === step.step_key">
            <v-textarea
              v-model="repairJsonDraft"
              label="结构化返修评价 JSON（jsonb 对象）"
              variant="outlined"
              rows="6"
              auto-grow
              class="font-mono text-xs"
            />
            <Row x="end" :gap="8">
              <v-btn size="small" :disabled="!!busyStep" @click="editingRepairStep = null">取消</v-btn>
              <v-btn size="small" color="primary" :loading="busyStep === step.step_key" @click="saveRepairJson(step)">
                保存 JSON
              </v-btn>
            </Row>
          </template>
          <template v-else-if="step.repair_evaluation">
            <p v-for="(item, idx) in step.repair_evaluation.action_items" :key="idx" class="text-xs">
              • {{ item }}
            </p>
            <p v-if="step.repair_evaluation.failed_criteria_hotspots.length" class="text-xs text-muted">
              高频失分项：{{
                step.repair_evaluation.failed_criteria_hotspots
                  .map((h) => `${h.criterion_id} (${Math.round(h.fail_rate * 100)}%)`)
                  .join('、')
              }}
            </p>
          </template>
        </Column>

        <details v-if="step.sub_runs.length > 0">
          <summary class="text-xs cursor-pointer text-muted">
            子任务明细（共 {{ step.sub_runs.length }} 条，运行/排队 {{ step.active_sub_runs }} 条）
          </summary>
          <Column :gap="4" class="mt-8">
            <Row v-for="sub in step.sub_runs" :key="sub.id" x="between" wrap :gap="8" class="text-xs">
              <span>
                <code>{{ sub.sub_run_key }}</code> · {{ statusText[sub.status] ?? sub.status }}
                <template v-if="sub.result && typeof sub.result.normalized_score === 'number'">
                  · 得分 {{ sub.result.normalized_score }}
                </template>
              </span>
              <span class="text-muted">{{ dateLabel(sub.started_at) }}</span>
            </Row>
          </Column>
        </details>
      </Column>
    </Column>
  </section>
</template>
