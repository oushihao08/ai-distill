<!--
职责：展示本地 worker 心跳、资源状态、项目步骤和独立材料库任务。
关键方法与用法：组件挂载后仅前台每 10 秒刷新 `/monitor`，卸载时停止轮询；任务监控页用它定位当前运行任务。
-->

<script setup lang="ts">
import { useResource } from '@/composables/useResource';
import { dateLabel, fileSize } from '@/utils/format';
import type { MaterialLibraryQueueStatus,WorkerMonitorStatus } from '@server/monitoring/worker-monitor';
type MonitorResponse=WorkerMonitorStatus&{active_workflow_tasks:{status:'known'|'unavailable';items:{attempt_id:string;project_id:string;workflow_id:string;project_name:string;question_title:string;step_name:string;channel:'agent'|'api'|'unknown';state:'running';started_at:string|null}[]};material_library:MaterialLibraryQueueStatus};
const {data,error,loading,refresh}=useResource<MonitorResponse>('/monitor');
let timer:ReturnType<typeof setInterval>|undefined;
onMounted(()=>{timer=setInterval(()=>{if(!loading.value&&!document.hidden)void refresh();},10000);});
onUnmounted(()=>clearInterval(timer));
const labels={running:'运行中',paused:'低内存暂停派发',stopped:'已停止',stale:'监控已过期',unavailable:'监控不可用'};
const current=computed(()=>data.value&&['running','paused'].includes(data.value.status)?data.value.snapshot:null);
const rss=computed(()=>current.value?.processes.find(p=>p.pid===data.value?.worker_pid)?.rss_bytes);
const activeTasks=computed(()=>data.value?.active_workflow_tasks.items??[]);
const activeTasksStatus=computed(()=>data.value?.active_workflow_tasks.status??'loading');
const libraryJobs=computed(()=>data.value?.material_library.status==='known'?data.value.material_library.items:[]);
const libraryTotals=computed(()=>data.value?.material_library.status==='known'?data.value.material_library.totals:null);
const libraryKindLabel={intake:'入库核验',extract:'文本提取',redact:'脱敏'};
const libraryStateLabel={queued:'排队',running:'运行'};
</script>
<template><Column class="surface-card p-16" :gap="12">
 <Row x="between" wrap :gap="8"><h2 class="section-title">执行器监控</h2><span class="text-sm text-muted">{{ data ? labels[data.status] : '正在读取…' }}</span></Row>
 <p v-if="error" class="text-sm text-error">{{ error }}</p>
 <p v-if="data?.status==='paused'" class="text-sm text-muted">可用内存低于 {{ data.dispatch?.min_available_percent }}%，暂停领取新任务；运行中的任务继续，内存恢复后自动派发。</p>
 <Row v-if="current" wrap :gap="16" class="text-sm text-muted">
  <span>可用内存：{{ current.system.status==='known' ? `${current.system.value.available_percent}%（估算）` : '未知，沿用派发策略' }}</span>
  <span>Worker 内存：{{ rss?.status==='known' ? fileSize(rss.value) : '未知' }}</span>
  <span>任务：{{ current.tasks.status==='known' ? `${current.tasks.value.states.waiting} 等待 / ${current.tasks.value.running} 运行` : '未知' }}</span>
 </Row>
 <ActiveWorkflowTasks :status="activeTasksStatus" :tasks="activeTasks" />
 <section class="border border-subtle rounded-md p-12">
  <Row x="between" wrap :gap="8"><h3 class="text-sm font-semibold text-ink-heading">独立材料库队列</h3><span v-if="libraryTotals" class="text-xs text-muted">排队 {{ libraryTotals.queued }} · 运行 {{ libraryTotals.running }} · 成功 {{ libraryTotals.succeeded }} · 失败 {{ libraryTotals.failed }}</span><span v-else class="text-xs text-muted">{{ data?.material_library.status==='unavailable'?'尚未应用材料库迁移或读取不可用':'读取中' }}</span></Row>
  <Column v-if="libraryJobs.length" :gap="6" class="mt-8">
   <Row v-for="job in libraryJobs" :key="job.job_id" wrap x="between" :gap="8" class="text-xs text-muted">
    <span>{{ job.package_name }} · {{ libraryKindLabel[job.kind] }} · {{ libraryStateLabel[job.state] }} · {{ job.executor_kind }}/{{ job.execution_target }}</span>
    <span v-if="job.progress.total_files">{{ job.progress.completed_files??0 }}/{{ job.progress.total_files }} 份材料</span>
    <span v-if="job.error_code" class="text-error">{{ job.error_code }}</span>
   </Row>
  </Column>
  <p v-else-if="libraryTotals" class="mt-8 text-xs text-muted">当前没有排队或运行中的材料库任务。</p>
 </section>
 <p class="text-xs text-muted">{{ data?.heartbeat_at ? `最后采样 ${dateLabel(data.heartbeat_at)}` : '等待 worker 上报' }}。认证与额度状态尚未采集；内存统计仅包含 worker 进程。</p>
</Column></template>
