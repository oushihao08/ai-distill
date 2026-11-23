<!--
职责：展示本地 worker 心跳、资源状态、项目步骤和独立材料库任务。
关键方法与用法：组件挂载后仅前台每 10 秒刷新 `/monitor`，卸载时停止轮询；任务监控页用它定位当前运行任务。
-->

<script setup lang="ts">
import MonitorTaskTable, { type MonitorTaskRow } from './MonitorTaskTable.vue';
import { useResource } from '@/composables/useResource';
import { dateLabel, fileSize } from '@/utils/format';
import type { ActiveWorkflowTask,MaterialLibraryQueueStatus,WorkerMonitorStatus } from '@server/monitoring/worker-monitor';
type MonitorResponse=WorkerMonitorStatus&{active_workflow_tasks:{status:'known'|'unavailable';items:ActiveWorkflowTask[]};material_library:MaterialLibraryQueueStatus;local_execution_queue?:{executor_id:string;items:{id:string;kind:string;lane:string;state:string;updated_at?:number;cancel_requested:number}[]}|null};
const props=withDefaults(defineProps<{source?:string;label?:string}>(),{source:'local',label:'当前服务'});
const {data,error,loading,refresh}=useResource<MonitorResponse>(`/monitor?source=${encodeURIComponent(props.source)}`);
let timer:ReturnType<typeof setInterval>|undefined;
onMounted(()=>{timer=setInterval(()=>{if(!loading.value&&!document.hidden)void refresh();},10000);});
onUnmounted(()=>clearInterval(timer));
const labels={running:'运行中',paused:'低内存暂停派发',stopped:'已停止',stale:'监控已过期',unavailable:'监控不可用'};
const current=computed(()=>data.value&&['running','paused'].includes(data.value.status)?data.value.snapshot:null);
const rss=computed(()=>current.value?.processes.find(p=>p.pid===data.value?.worker_pid)?.rss_bytes);
const projectTasks=computed(()=>data.value?.active_workflow_tasks.items??[]);
const activeTasksStatus = computed(() => data.value?.active_workflow_tasks.status ?? 'loading');
const libraryStatus = computed(() => data.value?.material_library.status ?? 'loading');
const libraryTotals = computed(() => data.value?.material_library.status === 'known' ? data.value.material_library.totals : null);
const libraryKindLabel = { intake: '入库核验', extract: '文本提取', redact: '脱敏', prepare: '材料整理' };
const channelLabels: Record<string, string> = {
 agent: 'Agent', api: 'API', internal: '本地程序', web: '网页 Agent', unknown: '通道待核实',
};

function executionFields(task: ActiveWorkflowTask | Extract<MaterialLibraryQueueStatus, { status: 'known' }>['items'][number]) {
 return {
  state: task.state,
  startedAt: task.started_at,
  provider: task.provider,
  model: task.requested_model,
  effort: task.reasoning_effort,
  executorId: task.executor_id,
  generation: task.generation,
  pid: task.claimed_by_pid,
 };
}

const projectRows = computed<MonitorTaskRow[]>(() => projectTasks.value
 .filter(task => task.state === 'running' || task.state === 'queued')
 .map(task => ({
  ...executionFields(task),
  id: task.attempt_id,
  title: task.question_title,
  to: `/workflows/${task.workflow_id}`,
  project: { name: task.project_name, to: `/projects/${task.project_id}` },
  stage: task.step_name,
  channel: channelLabels[task.channel],
 })));

const libraryRows = computed<MonitorTaskRow[]>(() => {
 const library = data.value?.material_library;
 if (library?.status !== 'known') return [];
 return library.items.map(job => ({
  ...executionFields(job),
  id: job.job_id,
  title: job.package_name,
  stage: libraryKindLabel[job.kind],
  channel: channelLabels[job.executor_kind],
  location: job.execution_target === 'local' ? '本机' : '服务端',
  progress: job.progress.total_files ? `${job.progress.completed_files ?? 0}/${job.progress.total_files} 份材料` : undefined,
  error: job.error_code,
 }));
});
const localQueue=computed(()=>data.value?.local_execution_queue);
const queueCounts=computed(()=>{const items=localQueue.value?.items??[];const count=(lane:string,state:string)=>items.filter(i=>i.lane===lane&&i.state===state).length;return{agentQueued:count('agent','queued'),agentRunning:count('agent','running'),apiQueued:count('api','queued'),apiRunning:count('api','running'),pending:items.filter(i=>['pending_registration','result_pending_commit'].includes(i.state)).length,review:items.filter(i=>i.state==='needs_review').length};});
const recoveryItems=computed(()=>{
 const byAttempt=new Map(projectTasks.value.map(task=>[task.attempt_id,task]));
 return (localQueue.value?.items??[])
  .filter(item=>['pending_registration','result_pending_commit','needs_review'].includes(item.state))
  .map(item=>({...item,task:byAttempt.get(item.id)}));
});
const recoveryLabel:Record<string,string>={pending_registration:'等待确认入队',result_pending_commit:'等待结果同步',needs_review:'等待核实'};
</script>
<template><Column class="surface-card p-16" :gap="12">
 <Row x="between" wrap :gap="8"><h2 class="section-title">执行器监控 · {{ props.label }}</h2><span class="text-sm text-muted">{{ data ? labels[data.status] : '正在读取…' }}</span></Row>
 <p v-if="error" class="text-sm text-error">{{ error }}</p>
 <p v-if="data?.status==='paused'" class="text-sm text-muted">可用内存低于 {{ data.dispatch?.min_available_percent }}%，暂停领取新任务；运行中的任务继续，内存恢复后自动派发。</p>
 <Row v-if="current" wrap :gap="16" class="text-sm text-muted">
  <span>可用内存：{{ current.system.status==='known' ? `${current.system.value.available_percent}%（估算）` : '未知，沿用派发策略' }}</span>
  <span>Worker 内存：{{ rss?.status==='known' ? fileSize(rss.value) : '未知' }}</span>
  <span v-if="!localQueue">任务：{{ current.tasks.status==='known' ? `${current.tasks.value.states.waiting} 等待 / ${current.tasks.value.running} 运行` : '未知' }}</span>
 </Row>
 <Row v-if="localQueue" wrap :gap="12" class="text-sm text-muted">
  <span>本机执行器：{{ localQueue.executor_id.slice(0,8) }}</span>
  <span>Agent：{{ queueCounts.agentQueued }} 排队 / {{ queueCounts.agentRunning }} 运行</span>
  <span>API：{{ queueCounts.apiQueued }} 排队 / {{ queueCounts.apiRunning }} 运行</span>
  <span>待同步 {{ queueCounts.pending }} · 待核实 {{ queueCounts.review }}</span>
 </Row>
 <details v-if="recoveryItems.length" class="border border-subtle rounded-md p-12">
  <summary class="text-sm cursor-pointer">待核实与待同步任务（{{ recoveryItems.length }}）</summary>
  <p class="text-xs text-muted mt-8">待同步会按原任务恢复；待核实不会自动重放外部调用。以下任务不计入正在执行数量。</p>
  <Column :gap="8" class="mt-8 max-h-64 overflow-y-auto">
   <Row v-for="item in recoveryItems" :key="item.id" wrap :gap="8" class="text-xs">
    <span>{{ recoveryLabel[item.state] }}</span>
    <template v-if="item.task">
     <span>{{ item.task.project_name }}</span>
     <RouterLink :to="`/workflows/${item.task.workflow_id}`" class="link-text">{{ item.task.question_title }}</RouterLink>
     <span>{{ item.task.step_name }} · {{ item.task.requested_model ?? '模型未记录' }}</span>
    </template>
    <code>{{ item.id }}</code>
    <span class="text-muted">{{ item.lane }} · 更新于 {{ item.updated_at ? dateLabel(new Date(item.updated_at).toISOString()) : '未知' }}</span>
    <details v-if="item.kind==='step'"><summary class="cursor-pointer">日志查询命令</summary><code class="select-all break-all">bun scripts/diagnostics/read-logs.ts --attempt-id {{ item.id }}</code></details>
   </Row>
  </Column>
 </details>
 <MonitorTaskTable title="项目任务" :status="activeTasksStatus" :rows="projectRows">
  <template v-if="activeTasksStatus === 'known'" #summary>{{ projectRows.length }} 项 · 每 10 秒刷新</template>
 </MonitorTaskTable>
 <MonitorTaskTable title="材料库任务" :status="libraryStatus" :rows="libraryRows">
  <template v-if="libraryTotals" #summary>
   排队 {{ libraryTotals.queued }} · 运行 {{ libraryTotals.running }} · 历史成功 {{ libraryTotals.succeeded }} · 历史失败 {{ libraryTotals.failed }}
  </template>
 </MonitorTaskTable>
 <p class="text-xs text-muted">{{ data?.heartbeat_at ? `最后采样 ${dateLabel(data.heartbeat_at)}` : '等待 worker 上报' }}。后端与模型取自任务冻结请求，不表示供应商已返回实际模型。任务ID、执行器和代次用于多终端对账；未知任务不要重新领取。认证与额度状态尚未采集。</p>
</Column></template>
