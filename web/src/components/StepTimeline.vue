<script setup lang="ts">
import { statusLabels, type Step } from '../types/api';
import { dateLabel } from '../utils/format';
const props = defineProps<{ steps: Step[] }>();
defineSlots<{
 actions(props: { step: Step }): any;
 artifacts(props: { step: Step }): any;
}>();
const completed = computed(() => props.steps.filter(step => step.status === 'succeeded').length);
function stepMessage(step: Step) {
 if (step.status === 'running') return '正在执行';
 if (step.status === 'failed') return '执行失败';
 if (step.status === 'skipped') return '已跳过';
 if (step.finished_at) return dateLabel(step.finished_at);
 return step.implemented ? '等待执行' : '此环节尚未开放';
}
</script>
<template><section class="surface-card p-16 min-w-0"><Column :gap="16">
 <Row x="between" wrap><Column :gap="4"><h2 class="section-title">处理流程</h2><span class="text-xs text-muted">每个步骤独立记录结果</span></Column><span class="text-sm text-muted">{{ completed }} / {{ steps.length }} 步完成</span></Row>
 <v-progress-linear color="primary" :model-value="steps.length ? completed / steps.length * 100 : 0" rounded />
 <ol class="list-none m-0 p-0"><li v-for="step in steps" :key="step.ordinal" class="border-b border-line-subtle last:border-b-0 py-12">
  <Row x="between" wrap :gap="12"><Row :gap="12"><v-avatar :color="step.status === 'succeeded' ? 'success' : 'secondary'" variant="tonal" size="small"><UiIcon v-if="step.status === 'succeeded'" name="check" /><span v-else class="text-sm">{{ step.display_position ?? step.position ?? step.ordinal }}</span></v-avatar><Column :gap="4"><span class="font-medium text-sm">{{ step.name }}</span><span class="text-xs text-muted">{{ stepMessage(step) }}</span></Column></Row><Row wrap y="center" :gap="8"><slot name="actions" :step="step" /><v-chip :color="step.status === 'succeeded' ? 'success' : step.status === 'failed' ? 'error' : 'secondary'">{{ statusLabels[step.status] }}</v-chip></Row></Row>
  <v-alert v-if="step.error" type="error" class="mt-8">{{ step.error }}</v-alert>
  <details v-if="step.result" class="mt-8 text-sm"><summary class="cursor-pointer link-text">查看返回结果</summary><pre class="surface-panel text-xs whitespace-pre-wrap break-all mt-8">{{ JSON.stringify(step.result, null, 2) }}</pre></details>
  <slot name="artifacts" :step="step" />
 </li></ol>
</Column></section></template>
