<!--
职责：在项目详情页列出当前版本已达标题目及其材料包，汇总各模型分数并打开全文弹窗。
关键方法与用法：接收题目、材料包、导出状态与错误，发出 `export` 事件；负责搜索、异常筛选、分页和单题归档入口。
-->

<script setup lang="ts">
import type { ProjectWorkflowStatus, Workflow } from '../types/api';
import AcceptedQuestionDetail from './AcceptedQuestionDetail.vue';

const props=defineProps<{workflows:Workflow[];packages:Workflow[];workflowStatus?:Record<string,ProjectWorkflowStatus>;exporting?:boolean;exportError?:string}>();
const emit=defineEmits<{export:[]}>();
const search=shallowRef('');
const filter=shallowRef<'全部'|'待归档'|'已归档'>('全部');
const page=shallowRef(1);
const selected=shallowRef<Workflow|null>(null);
const pageSize=20;
function isDeliverable(flow:Workflow){
 const step4=props.workflowStatus?.[flow.id]?.steps.find(step=>step.ordinal===4);
 return step4?.status==='succeeded'||flow.current_ordinal===7||flow.publication_status==='succeeded';
}
const accepted=computed(()=>props.workflows.filter(isDeliverable));
const packageNames=computed(()=>Object.fromEntries(props.packages.map(item=>[item.id,item.title])));
function sourceName(flow:Workflow){return flow.library_package_name||(flow.source_workflow_id?packageNames.value[flow.source_workflow_id]:null)||'旧题目目录';}
const publishedCount=computed(()=>accepted.value.filter(flow=>flow.publication_status==='succeeded').length);
const exportedCount=computed(()=>accepted.value.filter(flow=>flow.exported).length);
const filtered=computed(()=>accepted.value.filter(flow=>{
 const matchesText=flow.title.toLowerCase().includes(search.value.trim().toLowerCase())||(flow.source_key??'').toLowerCase().includes(search.value.trim().toLowerCase())||sourceName(flow).toLowerCase().includes(search.value.trim().toLowerCase());
 const matchesFilter=filter.value==='全部'||(filter.value==='待归档'&&flow.publication_status!=='succeeded')||(filter.value==='已归档'&&flow.publication_status==='succeeded');
 return matchesText&&matchesFilter;
}));
const pageCount=computed(()=>Math.max(1,Math.ceil(filtered.value.length/pageSize)));
const visible=computed(()=>filtered.value.slice((page.value-1)*pageSize,page.value*pageSize));
watch([search,filter],()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
</script>

<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap y="center" :gap="12">
   <Column :gap="4"><h2 class="section-title">可交付题目</h2><span class="text-xs text-muted">已完成出题 {{ accepted.length }} 道 · {{ publishedCount }} 道已归档 · {{ exportedCount }} 道已导出</span></Column>
   <Row wrap y="center" :gap="8">
    <v-btn :loading="props.exporting" :disabled="accepted.length===0||props.exporting" @click="emit('export')">下载全部可交付题目 Excel</v-btn>
    <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索可交付题目" hide-details clearable class="filter-field-compact" />
    <v-select v-model="filter" :items="['全部','待归档','已归档']" label="筛选" hide-details class="filter-field-compact w-140px" />
   </Row>
  </Row>
  <v-alert v-if="props.exportError" type="error" density="compact" role="alert">{{ props.exportError }}</v-alert>
  <p v-if="!visible.length" class="text-sm text-muted">{{ accepted.length?'没有符合筛选条件的题目':'暂无已完成出题的可交付题目。' }}</p>
  <Column v-else class="w-full overflow-x-auto">
   <v-table density="compact" class="project-records-table min-w-900px">
    <thead><tr><th scope="col">题目</th><th scope="col">所属材料包</th><th scope="col">成果状态</th><th scope="col">操作</th></tr></thead>
    <tbody>
     <tr v-for="flow in visible" :key="flow.id">
      <td class="max-w-260px"><Row wrap y="center" :gap="4"><RouterLink :to="`/workflows/${flow.id}`" class="link-text font-medium line-clamp-2" :title="flow.title">{{ flow.title }}</RouterLink><v-chip v-if="flow.load_eligible===false" size="x-small" color="warning" variant="tonal">材料≤10页（约 {{ flow.load_estimated_docx_pages }} 页）</v-chip></Row></td>
      <td class="max-w-220px"><RouterLink v-if="flow.library_package_id" :to="`/materials/${flow.library_package_id}`" class="link-text line-clamp-2" :title="sourceName(flow)">{{ sourceName(flow) }}</RouterLink><RouterLink v-else-if="flow.source_workflow_id" :to="`/workflows/${flow.source_workflow_id}`" class="link-text line-clamp-2" :title="sourceName(flow)">{{ sourceName(flow) }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
      <td class="whitespace-nowrap">{{ flow.publication_status==='succeeded'?'已归档':'待归档' }} · {{ flow.exported?'已导出':'未导出' }}</td>
      <td class="whitespace-nowrap"><Row :gap="4"><v-btn size="small" color="primary" variant="text" @click="selected=flow">查看内容</v-btn><v-btn v-if="flow.publication_status!=='succeeded'" size="small" color="primary" variant="text" :to="`/workflows/${flow.id}`">归档</v-btn></Row></td>
     </tr>
    </tbody>
   </v-table>
  </Column>
  <Row x="between" wrap y="center" :gap="8"><span class="text-xs text-muted">第 {{ page }} / {{ pageCount }} 页 · 每页 {{ pageSize }} 道</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="可交付题目分页" /></Row>
 </Column>
 <AcceptedQuestionDetail v-if="selected" :workflow-id="selected.id" :title="selected.title" detail-label="可交付题目" @close="selected=null" />
</template>
