<!--
职责：提供全局 Agent／API 并发与 Codex 凭证、默认模型设置页面。
关键组合：承载 `WorkerConcurrencyConfig` 和 `CodexConfig`；项目和步骤可继续按既有优先级覆盖默认值。
使用场景：工作台主导航“系统设置”入口。
-->
<template>
 <Column :gap="16">
  <Column :gap="6"><h1 class="text-2xl font-bold text-ink-heading">系统设置</h1><p class="text-sm text-muted">配置全局运行并发及本机 Codex 默认设置；项目和步骤设置优先级更高。</p></Column>
  <WorkerConcurrencyConfig />
  <CodexConfig />
 </Column>
</template>
