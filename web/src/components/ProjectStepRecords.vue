<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel, fileSize } from '../utils/format';
import type { ProjectStage, Workflow, WorkflowDetail } from '../types/api';
import MaterialRecordsTable from './MaterialRecordsTable.vue';
import StepResultTable from './StepResultTable.vue';

const props = defineProps<{ step: ProjectStage; workflows: Workflow[] }>();
const emit = defineEmits<{ close: [] }>();
const records = shallowRef<Record<string, WorkflowDetail>>({});
const failures = shallowRef<Record<string, string>>({});
const loading = shallowRef(false);
const search = shallowRef('');
const filter = shallowRef('全部');
const expanded = shallowRef<string | null>(null);
const filters = ['全部', '未进入', '就绪', '排队中', '处理中', '完成', '失败', '跳过', '读取失败'];
let controller: AbortController | undefined;
async function refresh() {
 if (loading.value) return;
 loading.value = true;
 controller = new AbortController();
 const signal = controller.signal;
 try {
  // Read existing workflow contracts in bounded groups; no task is dispatched here.
  const next: Record<string, WorkflowDetail> = {};
  const errors: Record<string, string> = {};
  for (let start = 0; start < props.workflows.length; start += 4) {
   const batch = props.workflows.slice(start, start + 4);
   const results = await Promise.allSettled(batch.map(flow => api<WorkflowDetail>(`/workflows/${flow.id}`, { signal })));
   if (signal.aborted) return;
   results.forEach((result, index) => {
    const id = batch[index]!.id;
    if (result.status === 'fulfilled') next[id] = result.value;
    else errors[id] = result.reason instanceof Error ? result.reason.message : '读取失败';
   });
  }
  records.value = next;
  failures.value = errors;
 } catch (cause) {
  if (!signal.aborted) failures.value = Object.fromEntries(props.workflows.map(flow => [flow.id, cause instanceof Error ? cause.message : '读取失败']));
 } finally { loading.value = false; }
}
const rows = computed(() => props.workflows.map(flow => {
 const detail = records.value[flow.id];
 const step = detail?.steps.find(item => item.ordinal === props.step.ordinal);
 const ordinals = props.step.ordinal === 1 ? [1, 2] : [props.step.ordinal];
 const attempts = detail?.attempts.filter(item => item.input_revision === detail.workflow.input_revision && ordinals.includes(item.ordinal)) ?? [];
 const active = attempts.find(item => ['waiting', 'running'].includes(item.status));
 const index = detail?.steps.findIndex(item => item.ordinal === props.step.ordinal) ?? -1;
 const previous = index > 0 ? detail?.steps[index - 1] : undefined;
 const ready = step && ['waiting', 'failed'].includes(step.status) && !active && step.enabled !== false && (index === 0 || previous?.status === 'succeeded');
 const state = failures.value[flow.id] ? '读取失败' : !detail ? '读取中' : !step ? '未进入'
  : step.status === 'succeeded' ? '完成' : step.status === 'failed' ? '失败'
  : step.status === 'skipped' ? '跳过' : step.status === 'running' || active?.status === 'running' ? '处理中'
  : active ? '排队中' : ready ? '就绪' : '未进入';
 const quality = step?.result?.quality_check as { passed?: boolean; issues?: { detail: string }[] } | undefined;
 const decision = String(step?.result?.decision ?? '');
 const decisionLabels: Record<string, string> = { accepted: '达标', repair: '需要返修', waiting: '等待判定条件', quarantine: '隔离' };
 const issues = quality?.issues?.map(item => item.detail).join('；') || (Array.isArray(step?.result?.reasons) ? step.result.reasons.join('；') : '') || (Array.isArray(step?.result?.issues) && step.result.issues.length ? `${step.result.issues.length} 项处理问题，展开结果查看` : '');
 const summary = props.step.ordinal === 9 && detail ? `${detail.materials.filter(item => item.processing_status === 'redacted').length} / ${detail.materials.length} 份附件已脱敏`
  : props.step.ordinal === 1 && detail ? `${detail.materials.length} 份附件入库`
  : props.step.ordinal === 4 ? `${step?.result?.task_name ?? '暂无题目产物'}${quality ? ` · 质检${quality.passed ? '通过' : '未通过'}` : ''}`
  : props.step.ordinal === 7 && decision ? decisionLabels[decision] ?? decision
  : step?.result ? '已有处理结果' : '暂无处理结果';
 const artifacts = detail?.artifacts.filter(item => attempts.some(attempt => attempt.id === item.attempt_id) && (!step?.result?.question_version || !item.question_version || item.question_version === step.result.question_version)) ?? [];
 const publishedArtifact = props.step.ordinal === 8 && typeof step?.result?.artifact_id === 'string' ? step.result.artifact_id : undefined;
 return { publishedArtifact, flow: detail?.workflow ?? flow, detail, step, state, summary, ready, active, artifacts,
  issue: failures.value[flow.id] ?? step?.error ?? (issues || (step?.enabled === false ? '本步骤未启用' : state === '未进入' && previous && previous.status !== 'succeeded' ? `前一步「${previous.name}」尚未完成` : state === '就绪' ? '等待执行' : '—')) };
}));
const visibleRows = computed(() => rows.value.filter(row => row.flow.title.toLowerCase().includes((search.value ?? '').trim().toLowerCase()) && (filter.value === '全部' || row.state === filter.value)));
function color(state: string) { return state === '完成' ? 'success' : ['失败', '读取失败'].includes(state) ? 'error' : ['排队中', '处理中', '就绪'].includes(state) ? 'primary' : 'secondary'; }
const resultKeys: Record<number, string[]> = {
 1: ['material_count', 'page_count', 'validation', 'issues'], 9: ['material_count', 'page_count', 'issues'],
 4: ['task_name', 'task_type', 'question_version', 'question', 'quality_check', 'rubric_version', 'rubric', 'answer_requirements'],
 5: ['models'], 6: ['models'], 7: ['decision', 'accepted', 'quarantined', 'action', 'classification', 'reason', 'reasons', 'issues', 'models', 'model_scores'],
 8: ['question_version', 'rubric_version', 'published_at', 'question', 'quality_check', 'models'],
};
function resultValue(detail: WorkflowDetail) {
 const result = detail.steps.find(item => item.ordinal === props.step.ordinal)?.result;
 if (!result) return null;
 const selected = Object.fromEntries((resultKeys[props.step.ordinal] ?? []).filter(key => key in result).map(key => [key, result[key]]));
 return Object.keys(selected).length ? selected : result;
}
const artifactNames: Record<string, string> = { redacted_markdown: '脱敏全文', redacted_index: '脱敏索引', authored_question: '题目包', model_answer: '模型答案', score_report: '评分报告', published_result: '发布成果' };
onMounted(refresh);
const timer = setInterval(() => { if (rows.value.some(row => ['排队中', '处理中'].includes(row.state))) refresh(); }, 5000);
onUnmounted(() => { controller?.abort(); clearInterval(timer); });
</script>
<template>
 <Column class="surface-card p-20 min-w-0" :gap="16">
  <Row x="between" wrap :gap="12"><Column :gap="4"><h2 class="section-title">{{ step.position }} · {{ step.name }} · 题目记录</h2><span class="text-xs text-muted">全部 {{ workflows.length }} 题 · 当前材料版本的状态与结果</span></Column><Row :gap="8"><v-btn :loading="loading" @click="refresh">刷新</v-btn><v-btn @click="emit('close')">关闭</v-btn></Row></Row>
  <Row wrap :gap="12"><v-text-field v-model="search" label="搜索题目" clearable hide-details class="filter-field" /><v-select v-model="filter" :items="filters" label="处理状态" hide-details class="filter-field-compact" /></Row>
  <p v-if="loading" class="text-xs text-muted" role="status">正在读取题目状态…</p>
  <Column class="w-full overflow-x-auto max-h-640px overflow-y-auto">
   <v-table density="comfortable" class="min-w-900px w-full">
    <thead><tr><th scope="col">题目</th><th scope="col">本步状态</th><th scope="col">处理结果</th><th scope="col">问题 / 未进入原因</th><th scope="col">完成时间</th><th scope="col">操作</th></tr></thead>
    <tbody>
     <template v-for="row in visibleRows" :key="row.flow.id">
      <tr>
       <td class="min-w-180px"><Column :gap="4"><RouterLink :to="`/workflows/${row.flow.id}`" class="link-text font-medium">{{ row.flow.title }}</RouterLink><span class="text-xs text-muted">材料 v{{ row.flow.input_revision }}</span></Column></td>
       <td class="whitespace-nowrap"><Column :gap="4"><v-chip :color="color(row.state)">{{ row.state }}</v-chip><span v-if="row.state==='失败' && row.ready" class="text-xs text-muted">可重试</span></Column></td>
       <td class="min-w-180px text-sm break-words">{{ row.summary }}</td>
       <td class="min-w-220px max-w-320px text-sm break-words" :class="row.state==='失败'?'text-danger':'text-muted'">{{ row.issue }}</td>
       <td class="whitespace-nowrap text-xs">{{ row.step?.finished_at ? dateLabel(row.step.finished_at) : '—' }}</td>
       <td><v-btn variant="text" color="primary" :disabled="!row.detail" @click="expanded=expanded===row.flow.id?null:row.flow.id">{{ expanded===row.flow.id?'收起':'查看结果' }}</v-btn></td>
      </tr>
      <tr v-if="expanded===row.flow.id && row.detail"><td colspan="6" class="py-16">
       <Column :gap="12">
        <MaterialRecordsTable v-if="[1,9].includes(step.ordinal)" :workflow-id="row.flow.id" :materials="row.detail.materials" :redaction-status="row.detail.steps.find(item=>item.ordinal===9)?.status" :redaction-queued="row.detail.attempts.some(attempt=>attempt.ordinal===9 && attempt.input_revision===row.flow.input_revision && attempt.status==='waiting')" :prefer-redacted="step.ordinal===9" read-only />
        <v-table v-if="[1,9].includes(step.ordinal) && !row.detail.materials.length && row.flow.source_manifest?.length" density="compact" class="w-full">
         <thead><tr><th scope="col">目录附件</th><th scope="col">大小</th><th scope="col">状态</th></tr></thead>
         <tbody><tr v-for="source in row.flow.source_manifest" :key="source.name"><td class="break-all">{{ source.name }}</td><td>{{ fileSize(source.size) }}</td><td>未入库</td></tr></tbody>
        </v-table>
        <StepResultTable v-if="resultValue(row.detail)" :value="resultValue(row.detail)" />
        <span v-else-if="![1,9].includes(step.ordinal)" class="text-sm text-muted">当前步骤尚无结果。</span>
        <Row wrap :gap="8"><v-btn v-if="row.publishedArtifact" :href="`/api/artifacts/${row.publishedArtifact}/download`" size="small" variant="text" color="primary">下载发布成果</v-btn><v-btn v-for="artifact in row.artifacts" :key="artifact.id" :href="`/api/artifacts/${artifact.id}/download`" size="small" variant="text" color="primary">下载{{ artifactNames[artifact.kind] ?? '产物' }}</v-btn><v-btn :to="`/workflows/${row.flow.id}`" size="small" variant="text">查看完整执行历史</v-btn></Row>
       </Column>
      </td></tr>
     </template>
     <tr v-if="!visibleRows.length"><td colspan="6" class="text-muted py-16">{{ loading?'正在读取…':'没有符合条件的题目' }}</td></tr>
    </tbody>
   </v-table>
  </Column>
 </Column>
</template>
