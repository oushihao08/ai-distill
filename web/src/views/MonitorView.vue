<!--
职责：提供全局任务执行器监控页面。
关键组合：承载 `WorkerMonitor`，由其读取 worker 心跳、资源与任务队列状态。
使用场景：工作台主导航“任务监控”入口。
-->
<script setup lang="ts">
import { useResource } from '@/composables/useResource';
const {data:sources,error}=useResource<{id:string;label:string}[]>('/monitor-sources');
</script>
<template>
 <Column :gap="16">
  <Column :gap="6"><h1 class="text-2xl font-bold text-ink-heading">任务监控</h1><p class="text-sm text-muted">查看本地 worker 心跳、资源状态，以及 Agent／API 正在处理的项目、题目和步骤。</p></Column>
  <p v-if="error" class="text-sm text-error">独立服务列表读取失败：{{ error }}</p>
  <p class="text-sm text-muted">Agent／API 是执行方式，提取、脱敏、整理、出题是业务阶段。各执行器独立展示，不重复汇总共享并发额度。</p>
  <WorkerMonitor v-for="source in sources ?? [{id:'local',label:'当前服务'}]" :key="source.id" :source="source.id" :label="source.label" />
 </Column>
</template>
