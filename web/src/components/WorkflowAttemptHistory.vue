<!--
职责：按步骤分页展示材料包或题目的安全执行记录，供项目状态表和材料包详情查看历史。
Props：workflowId、ordinal、title、stepName 指定记录；事件 close 关闭弹窗。
-->
<script setup lang="ts">
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
import {statusLabels,type StepStatus} from '../types/api';

const props=defineProps<{workflowId:string;ordinal:number;title:string;stepName:string}>();
const emit=defineEmits<{close:[]}>();
type RecordRow={id:string;ordinal:number;attempt:number;status:StepStatus;error:string|null;decision:string|null;started_at:string;finished_at:string|null};
const rows=shallowRef<RecordRow[]>([]),offset=shallowRef(0),total=shallowRef(0),loading=shallowRef(false),error=shallowRef('');
const decisionLabels:Record<string,string>={accepted:'达标',repair:'未达标',waiting:'等待判定',quarantine:'隔离'};
async function load(){
 try{
  loading.value=true;error.value='';
  const result=await api<{attempts:RecordRow[];total:number}>(`/workflows/${props.workflowId}/steps/${props.ordinal}/attempts?offset=${offset.value}`);
  rows.value=result.attempts;total.value=result.total;
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取执行记录失败';}
 finally{loading.value=false;}
}
function turn(delta:number){offset.value=Math.max(0,offset.value+delta*20);void load();}
onMounted(load);
watch(()=>[props.workflowId,props.ordinal],()=>{offset.value=0;void load();});
</script>
<template>
 <v-dialog :model-value="true" max-width="1000" scrollable @update:model-value="emit('close')">
  <Column class="surface-card p-20 max-h-[90vh] overflow-y-auto" :gap="12">
   <Row x="between" y="center" :gap="8"><h2 class="section-title">{{ title }} · {{ stepName }}记录</h2><v-btn icon="$close" variant="text" aria-label="关闭执行记录" @click="emit('close')" /></Row>
   <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
   <p v-if="loading" class="text-sm text-muted">正在读取执行记录…</p>
   <Column class="overflow-x-auto"><v-table density="compact" class="min-w-750px">
    <thead><tr><th scope="col">尝试</th><th scope="col">步骤</th><th scope="col">状态</th><th scope="col">开始时间</th><th scope="col">完成时间</th><th scope="col">原因</th></tr></thead>
    <tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.attempt }}</td><td>{{ row.ordinal===2?'PDF 文本提取':stepName }}</td><td>{{ row.decision?decisionLabels[row.decision]??statusLabels[row.status]:statusLabels[row.status] }}</td><td>{{ dateLabel(row.started_at) }}</td><td>{{ row.finished_at?dateLabel(row.finished_at):'—' }}</td><td class="max-w-320px break-words">{{ row.error??'—' }}</td></tr><tr v-if="!rows.length&&!loading"><td colspan="6" class="text-muted">暂无执行记录</td></tr></tbody>
   </v-table></Column>
   <Row x="between" y="center" :gap="8"><span class="text-xs text-muted">{{ total }} 条 · 第 {{ Math.floor(offset/20)+1 }} 页</span><Row :gap="8"><v-btn :disabled="loading||offset===0" @click="turn(-1)">上一页</v-btn><v-btn :disabled="loading||offset+20>=total" @click="turn(1)">下一页</v-btn><v-btn color="primary" variant="text" :to="`/workflows/${workflowId}`" @click="emit('close')">查看详情</v-btn></Row></Row>
  </Column>
 </v-dialog>
</template>
