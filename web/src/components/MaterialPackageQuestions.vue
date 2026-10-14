<!--
职责：在材料包详情分页显示全部派生题目的独立五步状态和执行记录。
Props：projectId、questions；当前页批量读取步骤状态，点击状态查看该题历史尝试。
-->
<script setup lang="ts">
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
import type {WorkflowDetail} from '../types/api';
import {workflowStepDisplay,type WorkflowStatusView} from '../utils/workflow-status';
import WorkflowAttemptHistory from './WorkflowAttemptHistory.vue';

type Question=NonNullable<WorkflowDetail['material_package_questions']>[number];
const props=defineProps<{projectId:string;questions:Question[]}>();
const page=shallowRef(1),views=shallowRef<Record<string,WorkflowStatusView>>({}),loading=shallowRef(false),error=shallowRef('');
const history=shallowRef<{workflowId:string;title:string;ordinal:number;stepName:string}|null>(null);
let requestVersion=0;
const columns=[{ordinal:4,name:'出题'},{ordinal:5,name:'作答'},{ordinal:6,name:'评分'},{ordinal:7,name:'达标判断'},{ordinal:8,name:'归档'}];
const pageSize=10;
const pageCount=computed(()=>Math.max(1,Math.ceil(props.questions.length/pageSize)));
const visible=computed(()=>props.questions.slice((page.value-1)*pageSize,page.value*pageSize));
async function refresh(){
 const version=++requestVersion,questions=visible.value;
 if(!questions.length){views.value={};return;}
 try{loading.value=true;error.value='';const result=await api<Record<string,WorkflowStatusView>>(`/projects/${props.projectId}/workflow-status?ids=${questions.map(item=>item.id).join(',')}`);if(version===requestVersion)views.value=result;}
 catch(cause){if(version===requestVersion){error.value=cause instanceof Error?cause.message:'读取题目状态失败';views.value={};}}
 finally{if(version===requestVersion)loading.value=false;}
}
function openHistory(question:Question,column:typeof columns[number]){history.value={workflowId:question.id,title:question.title,ordinal:column.ordinal,stepName:column.name};}
watch([()=>props.questions,page],()=>{void refresh();});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
onMounted(refresh);
</script>
<template><Column class="surface-card p-16" :gap="12">
 <Row x="between" wrap y="center" :gap="8"><h2 class="section-title">本材料包的题目</h2><span class="text-xs text-muted">共 {{ questions.length }} 道 · 每页 {{ pageSize }} 道</span></Row>
 <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
 <p v-if="!questions.length" class="text-sm text-muted">此材料包还没有题目。完成脱敏后可在上方创建多道题目。</p>
 <Column v-else class="overflow-x-auto"><v-table density="comfortable" class="min-w-950px"><thead><tr><th scope="col">题目与脱敏版本</th><th v-for="column in columns" :key="column.ordinal" scope="col">{{ column.name }}</th></tr></thead>
  <tbody><tr v-for="question in visible" :key="question.id"><td class="min-w-220px"><Column :gap="4"><RouterLink :to="`/workflows/${question.id}`" class="link-text font-medium">{{ question.title }}</RouterLink><span class="text-xs text-muted">脱敏尝试 {{ question.source_redaction_attempt_id }} · 正文指纹 {{ question.source_redaction_sha256?.slice(0,16) }}</span></Column></td><td v-for="column in columns" :key="column.ordinal"><Column :gap="4"><v-btn size="small" variant="text" :color="workflowStepDisplay(views[question.id],column.ordinal).color" @click="openHistory(question,column)">{{ workflowStepDisplay(views[question.id],column.ordinal).label }}</v-btn><span v-if="workflowStepDisplay(views[question.id],column.ordinal).reason" class="text-xs text-muted max-w-180px break-words">{{ workflowStepDisplay(views[question.id],column.ordinal).reason }}</span><span v-if="workflowStepDisplay(views[question.id],column.ordinal).finishedAt" class="text-xs text-muted">{{ dateLabel(workflowStepDisplay(views[question.id],column.ordinal).finishedAt!) }}</span></Column></td></tr></tbody>
 </v-table></Column>
 <Row x="between" y="center"><span class="text-xs text-muted">{{ loading?'正在读取状态…':`第 ${page} / ${pageCount} 页` }}</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="材料包题目分页" /></Row>
 <WorkflowAttemptHistory v-if="history" :key="`${history.workflowId}-${history.ordinal}`" v-bind="history" @close="history=null" />
</Column></template>
