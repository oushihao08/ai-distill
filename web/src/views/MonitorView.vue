<!--
职责：提供全局任务执行器监控页面。
关键组合：承载 `WorkerMonitor`，由其读取 worker 心跳、资源与任务队列状态。
使用场景：工作台主导航“任务监控”入口。
-->
<template>
 <Column :gap="16">
  <Column :gap="6"><h1 class="text-2xl font-bold text-ink-heading">任务监控</h1><p class="text-sm text-muted">查看本地 worker 心跳、资源状态，以及 Agent／API 正在处理的项目、题目和步骤。</p></Column>
  <WorkerMonitor />
 </Column>
</template>
