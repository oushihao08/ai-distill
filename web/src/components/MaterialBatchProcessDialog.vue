<!-- 职责：确认并展示对当前全部搜索结果的批量处理；实际派发与状态维护由材料库页面负责。 -->
<script setup lang="ts">
type BatchStage='intake'|'extract'|'redact'|'prepare';
type BatchRow={id:string;name:string;status:string;jobId?:string;reason:string};
defineProps<{open:boolean;stage:BatchStage;stages:{title:string;value:string}[];total:number;rows:BatchRow[];running:boolean;disabled:boolean}>();
const emit=defineEmits<{close:[];run:[];updateStage:[value:BatchStage]}>();
function statusColor(status:string){return status==='已派发'||status==='已复用'?'success':status==='已停止'?'error':status==='跳过'?'warning':'secondary';}
</script>
<template>
 <v-dialog :model-value="open" max-width="820" scrollable :persistent="running" aria-labelledby="batch-process-title" @update:model-value="!$event&&!running&&emit('close')">
  <v-card class="max-h-[85vh] overflow-hidden">
   <v-card-title><Row x="between" y="center" :gap="12"><Column :gap="4"><h2 id="batch-process-title" class="text-base font-semibold">批量处理搜索结果</h2><p class="text-xs text-muted">当前筛选命中 {{ total }} 个材料包，范围包含全部分页。</p></Column><v-btn icon="$close" variant="text" aria-label="关闭批量处理" :disabled="running" @click="emit('close')"/></Row></v-card-title>
   <v-card-text class="min-h-0 overflow-y-auto">
    <Column :gap="16">
     <v-alert type="info" density="compact">系统会跳过已完成、有活动任务或前置条件未满足的材料包；容量不足或请求异常时停止，不会自动进入下一处理阶段。</v-alert>
     <Column :gap="6"><label for="batch-stage" class="text-sm font-medium text-ink-heading">处理阶段</label><v-select id="batch-stage" :model-value="stage" :items="stages" hide-details :disabled="running" @update:model-value="emit('updateStage',$event as BatchStage)"/></Column>
     <Column v-if="rows.length" :gap="8">
      <Row x="between" y="center"><h3 class="text-sm font-semibold">本次执行结果</h3><span class="text-xs text-muted">{{ rows.length }} 个材料包</span></Row>
      <Column :gap="0" class="max-h-360 overflow-auto border border-line rounded-lg">
       <v-table density="compact" class="min-w-640px" aria-label="批量处理结果">
        <thead><tr><th scope="col">材料包</th><th scope="col">状态</th><th scope="col">任务或原因</th></tr></thead>
        <tbody><tr v-for="row in rows" :key="row.id"><td class="max-w-280px"><span class="break-words">{{ row.name }}</span></td><td class="whitespace-nowrap"><v-chip size="small" variant="tonal" :color="statusColor(row.status)">{{ row.status }}</v-chip></td><td class="max-w-320px break-all text-xs text-muted">{{ row.reason||row.jobId||'—' }}</td></tr></tbody>
       </v-table>
      </Column>
     </Column>
    </Column>
   </v-card-text>
   <v-card-actions class="border-t border-line"><v-spacer/><v-btn :disabled="running" @click="emit('close')">关闭</v-btn><v-btn color="primary" variant="flat" :loading="running" :disabled="disabled" @click="emit('run')">确认批量派发 · {{ total }}</v-btn></v-card-actions>
  </v-card>
 </v-dialog>
</template>
