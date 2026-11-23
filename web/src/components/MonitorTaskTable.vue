<script setup lang="ts">
import { dateLabel } from '@/utils/format';

export interface MonitorTaskRow {
 id: string;
 title: string;
 to?: string;
 project?: { name: string; to: string };
 stage: string;
 channel: string;
 location?: string;
 state: string;
 startedAt: string | null;
 provider?: string | null;
 model?: string | null;
 effort?: string | null;
 executorId?: string | null;
 generation?: number | null;
 pid?: number | null;
 progress?: string;
 error?: string | null;
}

defineProps<{
 title: string;
 status: 'loading' | 'known' | 'unavailable';
 rows: MonitorTaskRow[];
}>();

const stateLabels: Record<string, string> = {
 queued: '排队',
 running: '运行中',
 pending_registration: '等待确认入队',
 result_pending_commit: '等待结果同步',
 needs_review: '待核实',
};
const stateColors: Record<string, string> = {
 running: 'primary',
 needs_review: 'warning',
};
</script>

<template>
 <section class="border-t border-line-subtle pt-16">
  <Column :gap="8">
   <Row x="between" wrap :gap="8">
    <h3 class="text-sm font-semibold text-ink-heading">{{ title }}</h3>
    <span v-if="$slots.summary" class="text-xs text-muted tabular-nums"><slot name="summary" /></span>
   </Row>
   <p v-if="status === 'loading'" class="text-sm text-muted py-12">正在读取任务…</p>
   <p v-else-if="status === 'unavailable'" class="text-sm text-error py-12">暂时无法读取{{ title }}。</p>
   <p v-else-if="!rows.length" class="bg-surface-muted rounded-lg px-12 py-16 text-sm text-muted">暂无活动{{ title }}</p>
   <v-table v-else density="compact" class="monitor-task-table border border-line-subtle rounded-lg">
    <colgroup>
     <col class="w-30%">
     <col class="w-12%">
     <col class="w-13%">
     <col class="w-14%">
     <col class="w-17%">
     <col class="w-14%">
    </colgroup>
    <thead class="bg-surface-muted">
     <tr>
      <th scope="col" class="whitespace-nowrap">任务</th>
      <th scope="col" class="whitespace-nowrap">阶段</th>
      <th scope="col" class="whitespace-nowrap">状态</th>
      <th scope="col" class="whitespace-nowrap">执行方式</th>
      <th scope="col" class="whitespace-nowrap">开始时间</th>
      <th scope="col" class="whitespace-nowrap">详情</th>
     </tr>
    </thead>
    <tbody>
     <tr v-for="row in rows" :key="row.id">
      <td class="py-8">
       <Column :gap="2" class="break-words">
        <RouterLink v-if="row.to" :to="row.to" class="link-text font-medium">{{ row.title }}</RouterLink>
        <span v-else class="font-medium text-ink-heading">{{ row.title }}</span>
        <RouterLink v-if="row.project" :to="row.project.to" class="link-text text-xs">{{ row.project.name }}</RouterLink>
       </Column>
      </td>
      <td class="whitespace-nowrap">{{ row.stage }}</td>
      <td>
       <Column :gap="4" class="items-start whitespace-nowrap">
        <v-chip size="small" variant="tonal" class="self-start" :color="stateColors[row.state]">{{ stateLabels[row.state] ?? row.state }}</v-chip>
        <span v-if="row.progress" class="text-xs text-muted tabular-nums">{{ row.progress }}</span>
       </Column>
      </td>
      <td class="whitespace-nowrap">{{ row.channel }}<span v-if="row.location" class="text-xs text-muted"> · {{ row.location }}</span></td>
      <td class="whitespace-nowrap text-xs text-muted tabular-nums">{{ row.startedAt ? dateLabel(row.startedAt) : '—' }}</td>
      <td class="py-8">
       <details class="text-xs">
        <summary class="cursor-pointer whitespace-nowrap text-muted" :aria-label="`执行详情：${row.title}`">执行详情</summary>
        <Column :gap="4" class="mt-8 break-all">
         <span>请求后端 {{ row.provider ?? '未记录' }}</span>
         <span>模型 {{ row.model ?? '未记录或不适用' }}<template v-if="row.effort"> · 推理 {{ row.effort }}</template></span>
         <code>任务 {{ row.id }}</code>
         <span>执行器 {{ row.executorId ?? '未归属或旧接口' }} · 代次 {{ row.generation ?? '未知' }}</span>
         <span>{{ row.pid ? `已领取 · PID ${row.pid}` : row.state === 'queued' ? '待领取' : '领取进程未确认' }}</span>
         <span v-if="row.error" class="text-error">{{ row.error }}</span>
        </Column>
       </details>
      </td>
     </tr>
    </tbody>
   </v-table>
  </Column>
 </section>
</template>

<style scoped>
.monitor-task-table :deep(table) {
 table-layout: fixed;
 min-width: 56rem;
}
</style>
