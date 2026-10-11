<!--
职责：按接口步骤顺序呈现单题流程及各步状态、时间和可插入操作。
关键方法与用法：`stepMessage()` 生成步骤说明；接收 `steps`，通过插槽承载详情页提供的派发、设置和结果操作。
-->

<script setup lang="ts">
import { statusLabels, type Step } from '../types/api';
import { dateLabel } from '../utils/format';
const props = defineProps<{ steps: Step[] }>();
defineSlots<{
 actions(props: { step: Step }): any;
 artifacts(props: { step: Step }): any;
}>();
const completed = computed(() => props.steps.filter(step => step.status === 'succeeded').length);
function decisionLabel(step:Step){
 const decision=String(step.result?.decision??'');
 return ({accepted:'达标',repair:'需要返修',waiting:'等待判定条件',quarantine:'隔离'} as Record<string,string>)[decision];
}
function statusLabel(step:Step){return step.ordinal===7&&decisionLabel(step)?decisionLabel(step):statusLabels[step.status];}
function statusColor(step:Step){
 if(step.ordinal===7&&step.result?.decision==='accepted')return 'success';
 if(step.ordinal===7&&step.result?.decision==='repair')return 'warning';
 if(step.ordinal===7&&step.result?.decision==='quarantine')return 'error';
 return step.status==='succeeded'?'success':step.status==='failed'?'error':'secondary';
}
function stepMessage(step: Step) {
 if(step.ordinal===7&&step.result?.decision==='accepted')return '全部所选模型均低于各自分数上限，题目达标';
 if(step.ordinal===7&&step.result?.decision==='repair')return '并非所有所选模型都低于分数上限，题目需要返修';
 if(step.ordinal===7&&step.result?.decision==='waiting')return '尚有模型未完成作答或有效评分；查看右侧模型状态';
 if(step.ordinal===7&&step.result?.decision==='quarantine')return '题目或材料版本已变化，当前判定已隔离';
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
  <Row x="between" wrap :gap="12"><Row :gap="12"><v-avatar :color="statusColor(step)" variant="tonal" size="small"><UiIcon v-if="step.status === 'succeeded'" name="check" /><span v-else class="text-sm">{{ step.display_position ?? step.position ?? step.ordinal }}</span></v-avatar><Column :gap="4"><span class="font-medium text-sm">{{ step.name }}</span><span class="text-xs text-muted">{{ stepMessage(step) }}</span></Column></Row><Row wrap y="center" :gap="8"><slot name="actions" :step="step" /><v-chip :color="statusColor(step)">{{ statusLabel(step) }}</v-chip></Row></Row>
  <v-alert v-if="step.error" type="error" class="mt-8">{{ step.error }}</v-alert>
  <slot name="artifacts" :step="step" />
 </li></ol>
</Column></section></template>
