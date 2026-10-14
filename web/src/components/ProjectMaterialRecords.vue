<!--
职责：在项目详情按材料包平铺显示入库与脱敏状态、当前附件数及关联题目数。
Props：projectId、packages、questions；按当前页读取状态，点击步骤打开执行历史。
-->
<script setup lang="ts">
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
import type {Workflow} from '../types/api';
import {workflowStepDisplay,type WorkflowStatusView} from '../utils/workflow-status';
import WorkflowAttemptHistory from './WorkflowAttemptHistory.vue';

const props=defineProps<{projectId:string;packages:Workflow[];questions:Workflow[]}>();
const search=shallowRef(''),page=shallowRef(1),views=shallowRef<Record<string,WorkflowStatusView>>({}),error=shallowRef(''),loading=shallowRef(false);
const history=shallowRef<{workflowId:string;title:string;ordinal:number;stepName:string}|null>(null);
let requestVersion=0;
const pageSize=10;
const filtered=computed(()=>props.packages.filter(item=>item.title.toLowerCase().includes(search.value.trim().toLowerCase())));
const pageCount=computed(()=>Math.max(1,Math.ceil(filtered.value.length/pageSize)));
const visible=computed(()=>filtered.value.slice((page.value-1)*pageSize,page.value*pageSize));
const counts=computed(()=>{const values:Record<string,number>={};for(const question of props.questions)if(question.source_workflow_id)values[question.source_workflow_id]=(values[question.source_workflow_id]??0)+1;return values;});
async function refresh(){
 const version=++requestVersion,items=visible.value;
 if(!items.length){views.value={};return;}
 try{loading.value=true;error.value='';const result=await api<Record<string,WorkflowStatusView>>(`/projects/${props.projectId}/workflow-status?ids=${items.map(item=>item.id).join(',')}`);if(version===requestVersion)views.value=result;}
 catch(cause){if(version===requestVersion){error.value=cause instanceof Error?cause.message:'读取材料包状态失败';views.value={};}}
 finally{if(version===requestVersion)loading.value=false;}
}
function openHistory(item:Workflow,ordinal:number){history.value={workflowId:item.id,title:item.title,ordinal,stepName:ordinal===1?'入库':'脱敏与检查'};}
watch([()=>props.packages,page,search],()=>{void refresh();});
watch(search,()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
onMounted(refresh);
</script>
<template><Column class="surface-card p-16" :gap="12">
 <Row x="between" wrap y="center" :gap="8"><Column :gap="4"><h2 class="section-title">材料包</h2><span class="text-xs text-muted">共 {{ filtered.length }} 个 · 每页 {{ pageSize }} 个</span></Column><v-text-field v-model="search" placeholder="搜索材料包" aria-label="搜索材料包" hide-details clearable class="filter-field-compact" /></Row>
 <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
 <p v-if="!visible.length" class="text-sm text-muted">{{ packages.length?'没有符合条件的材料包':'暂无材料包。请在“材料与 skill”中同步来源目录。' }}</p>
 <Column v-else class="overflow-x-auto"><v-table density="comfortable" class="min-w-850px">
  <thead><tr><th scope="col">材料包</th><th scope="col">当前附件</th><th scope="col">入库</th><th scope="col">脱敏</th><th scope="col">题目数</th><th scope="col">操作</th></tr></thead>
  <tbody><tr v-for="item in visible" :key="item.id"><td class="min-w-180px"><RouterLink :to="`/workflows/${item.id}`" class="link-text font-medium">{{ item.title }}</RouterLink></td><td>{{ item.material_count??0 }} 份</td>
   <td v-for="ordinal in [1,9]" :key="ordinal"><Column :gap="4"><v-btn variant="text" size="small" :color="workflowStepDisplay(views[item.id],ordinal).color" @click="openHistory(item,ordinal)">{{ workflowStepDisplay(views[item.id],ordinal).label }}</v-btn><span v-if="workflowStepDisplay(views[item.id],ordinal).reason" class="text-xs text-muted max-w-180px break-words">{{ workflowStepDisplay(views[item.id],ordinal).reason }}</span><span v-if="workflowStepDisplay(views[item.id],ordinal).finishedAt" class="text-xs text-muted">{{ dateLabel(workflowStepDisplay(views[item.id],ordinal).finishedAt!) }}</span></Column></td>
   <td>{{ counts[item.id]??0 }} 道</td><td><v-btn variant="text" color="primary" :to="`/workflows/${item.id}`">材料详情</v-btn></td></tr></tbody>
 </v-table></Column>
 <Row x="between" y="center"><span class="text-xs text-muted">{{ loading?'正在读取状态…':`第 ${page} / ${pageCount} 页` }}</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="材料包分页" /></Row>
 <WorkflowAttemptHistory v-if="history" :key="`${history.workflowId}-${history.ordinal}`" v-bind="history" @close="history=null" />
</Column></template>
