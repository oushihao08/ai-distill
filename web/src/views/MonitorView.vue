<!--
职责：提供全局任务执行器监控页面。
关键组合：承载 `WorkerMonitor`，由其读取 worker 心跳、资源与任务队列状态。
使用场景：工作台主导航“任务监控”入口。
-->
<script setup lang="ts">
import DispatchBatches from '@/components/DispatchBatches.vue';
import { useResource } from '@/composables/useResource';
const {data:sources,error}=useResource<{id:string;label:string}[]>('/monitor-sources');
</script>
<template>
 <Column :gap="16">
  <h1 class="page-title">任务监控</h1>
  <p v-if="error" class="text-sm text-error">独立服务列表读取失败：{{ error }}</p>
  <DispatchBatches />
  <WorkerMonitor v-for="source in sources ?? [{id:'local',label:'当前服务'}]" :key="source.id" :source="source.id" :label="source.label" />
 </Column>
</template>
