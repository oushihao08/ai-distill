<script setup lang="ts">
import { useResource } from '../composables/useResource';
import { dateLabel, fileSize } from '../utils/format';
import type { WorkerMonitorStatus } from '../../../server/monitoring/worker-monitor';
const {data,error,refresh}=useResource<WorkerMonitorStatus>('/monitor');
let timer:ReturnType<typeof setInterval>|undefined;
onMounted(()=>{timer=setInterval(refresh,5000);});
onUnmounted(()=>clearInterval(timer));
const labels={running:'运行中',paused:'低内存暂停派发',stopped:'已停止',stale:'监控已过期',unavailable:'监控不可用'};
const current=computed(()=>data.value&&['running','paused'].includes(data.value.status)?data.value.snapshot:null);
const rss=computed(()=>current.value?.processes.find(p=>p.pid===data.value?.worker_pid)?.rss_bytes);
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
 <p class="text-xs text-muted">{{ data?.heartbeat_at ? `最后采样 ${dateLabel(data.heartbeat_at)}` : '等待 worker 上报' }}。认证与额度状态尚未采集；内存统计仅包含 worker 进程。</p>
</Column></template>
