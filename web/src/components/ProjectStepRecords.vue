<!--
职责：以表格展示项目中材料包或题目在当前步骤的状态、原因与业务详情入口。
关键方法与用法：`refresh()` 分块批量读取轻量状态，`color()` 展示状态；项目详情页按步骤打开本组件，`close` 事件关闭弹层。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel } from '../utils/format';
import type { ProjectStage, Workflow, WorkflowDetail } from '../types/api';

const props = defineProps<{ step: ProjectStage; workflows: Workflow[] }>();
const emit = defineEmits<{ close: [] }>();
const records = shallowRef<Record<string, Pick<WorkflowDetail,'steps'|'attempts'>>>({});
const failures = shallowRef<Record<string, string>>({});
const loading = shallowRef(false);
const search = shallowRef('');
const filter = shallowRef('全部');
const filters = ['全部', '未进入', '就绪', '排队中', '处理中', '完成', '达标', '未达标', '等待判定条件', '隔离', '失败', '跳过', '读取失败'];
const recordNoun=computed(()=>props.workflows.some(flow=>flow.workflow_kind==='material_package')?'材料包':'题目');
let controller: AbortController | undefined;
async function refresh() {
 if (loading.value) return;
 loading.value = true;
 controller = new AbortController();
 const signal = controller.signal;
 try {
  const next: Record<string, Pick<WorkflowDetail,'steps'|'attempts'>> = {};
  const errors: Record<string, string> = {};
  const projectId=props.workflows[0]?.project_id;
  if(projectId){
   for(let start=0;start<props.workflows.length;start+=100){
    if(signal.aborted)return;
    const flows=props.workflows.slice(start,start+100);
    const views=await api<Record<string,Pick<WorkflowDetail,'steps'|'attempts'>>>(`/projects/${projectId}/workflow-status?ids=${flows.map(flow=>flow.id).join(',')}`,{signal});
    for(const flow of flows){const view=views[flow.id];if(view)next[flow.id]=view;else errors[flow.id]='记录状态不存在';}
   }
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
 const attempts = detail?.attempts.filter(item => ordinals.includes(item.ordinal)) ?? [];
 const active = attempts.find(item => ['waiting', 'running'].includes(item.status));
 const ready = step?.ready === true;
 const decision = String(step?.result?.decision ?? '');
 const decisionLabels: Record<string, string> = { accepted: '达标', repair: '未达标', waiting: '等待判定条件', quarantine: '隔离' };
 const state = failures.value[flow.id] ? '读取失败' : !detail ? '读取中' : !step ? '未进入'
  : props.step.ordinal===7&&decision==='waiting'&&ready ? '就绪'
  : props.step.ordinal===7&&decision ? decisionLabels[decision]??decision
  : step.status === 'succeeded' ? '完成' : step.status === 'failed' ? '失败'
  : step.status === 'skipped' ? '跳过' : step.status === 'running' || active?.status === 'running' ? '处理中'
  : active ? '排队中' : ready ? '就绪' : '未进入';
 const issues = (Array.isArray(step?.result?.reasons) ? step.result.reasons.join('；') : '') || (Array.isArray(step?.result?.issues) && step.result.issues.length ? `${step.result.issues.length} 项处理问题，展开结果查看` : '');
 const summary = props.step.ordinal === 1 ? `${flow.material_count ?? 0} 份当前附件`
  : props.step.ordinal === 7 && decision ? decisionLabels[decision] ?? decision
  : step?.status === 'succeeded' ? '已完成，可查看详情' : '以本步状态为准';
 const issueText=step?.error||issues||(state==='未进入'?step?.ready_reason??(step?.enabled===false?'本步骤未启用':'前置步骤尚未完成'):state==='就绪'?'等待执行':'—');
 return { flow, detail, step, state, summary, ready, active,
  issue: failures.value[flow.id] ?? issueText };
}));
const visibleRows = computed(() => rows.value.filter(row => row.flow.title.toLowerCase().includes((search.value ?? '').trim().toLowerCase()) && (filter.value === '全部' || row.state === filter.value)));
function color(state: string) { return ['完成','达标'].includes(state) ? 'success' : state==='未达标'?'warning' : ['失败', '读取失败','隔离'].includes(state) ? 'error' : ['排队中', '处理中', '就绪'].includes(state) ? 'primary' : 'secondary'; }
onMounted(refresh);
onUnmounted(() => { controller?.abort(); });
</script>
<template>
 <Column class="surface-card p-20 min-w-0" :gap="16">
  <Row x="between" wrap :gap="12"><Column :gap="4"><h2 class="section-title">{{ step.position }} · {{ step.name }} · {{ recordNoun }}记录</h2><span class="text-xs text-muted">全部 {{ workflows.length }} 个{{ recordNoun }} · 当前步骤状态与结果</span></Column><Row :gap="8"><v-btn :loading="loading" @click="refresh">刷新</v-btn><v-btn @click="emit('close')">关闭</v-btn></Row></Row>
  <Row wrap :gap="12"><v-text-field v-model="search" :label="`搜索${recordNoun}`" clearable hide-details class="filter-field" /><v-select v-model="filter" :items="filters" label="处理状态" hide-details class="filter-field-compact" /></Row>
  <p v-if="loading" class="text-xs text-muted" role="status">正在读取{{ recordNoun }}状态…</p>
  <Column class="w-full overflow-x-auto max-h-640px overflow-y-auto">
   <v-table density="comfortable" class="min-w-900px w-full">
    <thead><tr><th scope="col">{{ recordNoun }}</th><th scope="col">本步状态</th><th scope="col">处理结果</th><th scope="col">问题 / 未进入原因</th><th scope="col">完成时间</th><th scope="col">操作</th></tr></thead>
    <tbody>
     <template v-for="row in visibleRows" :key="row.flow.id">
      <tr>
       <td class="min-w-180px"><Column :gap="4"><RouterLink :to="`/workflows/${row.flow.id}`" class="link-text font-medium">{{ row.flow.title }}</RouterLink></Column></td>
       <td class="whitespace-nowrap"><Column :gap="4"><v-chip :color="color(row.state)">{{ row.state }}</v-chip><span v-if="row.state==='失败' && row.ready" class="text-xs text-muted">可重试</span></Column></td>
       <td class="min-w-180px text-sm break-words">
        <span>{{ row.summary }}</span>
       </td>
       <td class="min-w-220px max-w-320px text-sm break-words" :class="row.state==='失败'?'text-danger':'text-muted'">{{ row.issue }}</td>
       <td class="whitespace-nowrap text-xs">{{ row.step?.finished_at ? dateLabel(row.step.finished_at) : '—' }}</td>
       <td><v-btn variant="text" color="primary" :to="`/workflows/${row.flow.id}`">查看{{ recordNoun }}详情</v-btn></td>
      </tr>
     </template>
     <tr v-if="!visibleRows.length"><td colspan="6" class="text-muted py-16">{{ loading?'正在读取…':`没有符合条件的${recordNoun}` }}</td></tr>
    </tbody>
   </v-table>
  </Column>
 </Column>
</template>
