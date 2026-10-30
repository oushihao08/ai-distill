<!--
职责：按 API／Agent 通道列出正在占用执行器的工作流步骤。
关键属性与用途：接收监控读取状态和安全任务摘要；只负责展示项目、题目、步骤及开始时间，不派发任务。
-->

<script setup lang="ts">
import type { ActiveWorkflowTask } from '@server/monitoring/worker-monitor';
import { dateLabel } from '../utils/format';

const props=defineProps<{
 status:'loading'|'known'|'unavailable';
 tasks:ActiveWorkflowTask[];
}>();
const channelLabels={agent:'Agent',api:'API',unknown:'通道待确认'} as const;
const channels=computed(()=>
 (['agent','api','unknown'] as const).map(channel=>({
  channel,
  label:channelLabels[channel],
  tasks:props.tasks.filter(task=>task.channel===channel),
 })).filter(group=>group.tasks.length>0),
);
</script>

<template>
 <Column class="border-t border-line-subtle pt-12" :gap="12">
  <Row x="between" wrap :gap="8"><h3 class="text-sm font-semibold">当前占用任务</h3><span v-if="status==='known'" class="text-xs text-muted">每 10 秒刷新；这里只显示执行中任务</span></Row>
  <p v-if="status==='loading'" class="text-sm text-muted">正在读取项目、题目和任务明细…</p>
  <v-alert v-else-if="status==='unavailable'" type="warning" density="compact">暂时无法读取项目、题目和任务明细。</v-alert>
  <p v-else-if="!tasks.length" class="text-sm text-muted">当前没有出题、作答、评分、返修建议或脱敏任务占用 API／Agent。</p>
  <Column v-for="group in channels" :key="group.channel" class="surface-panel" :gap="8">
   <Row x="between" wrap :gap="8"><h4 class="text-sm font-medium">{{ group.label }}</h4><span class="text-xs text-muted">占用 {{ group.tasks.length }} 项</span></Row>
   <Column class="w-full overflow-x-auto">
    <v-table density="compact" class="min-w-720px">
     <thead><tr><th scope="col">项目</th><th scope="col">题目</th><th scope="col">正在执行的任务</th><th scope="col">开始时间</th></tr></thead>
     <tbody>
      <tr v-for="task in group.tasks" :key="task.attempt_id">
       <td><RouterLink :to="`/projects/${task.project_id}`" class="link-text">{{ task.project_name }}</RouterLink></td>
       <td><RouterLink :to="`/workflows/${task.workflow_id}`" class="link-text">{{ task.question_title }}</RouterLink></td>
       <td>{{ task.step_name }}</td>
       <td class="whitespace-nowrap">{{ task.started_at?dateLabel(task.started_at):'—' }}</td>
      </tr>
     </tbody>
    </v-table>
   </Column>
  </Column>
 </Column>
</template>
