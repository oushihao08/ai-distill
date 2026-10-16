<!--
职责：在项目详情按材料包平铺显示入库与脱敏状态、当前附件数及关联题目数。
Props：projectId、packages、questions；按当前页读取状态，点击步骤打开执行历史；单项及搜索结果批量派发后发出 refresh 事件。
-->
<script setup lang="ts">
import {api} from '../api/client';
import type {Workflow} from '../types/api';
import {workflowStepDisplay,type WorkflowStatusView} from '../utils/workflow-status';
import WorkflowAttemptHistory from './WorkflowAttemptHistory.vue';

const props=defineProps<{projectId:string;packages:Workflow[];questions:Workflow[]}>();
const emit=defineEmits<{refresh:[]}>();
const search=shallowRef(''),page=shallowRef(1),views=shallowRef<Record<string,WorkflowStatusView>>({}),error=shallowRef(''),loading=shallowRef(false);
const running=shallowRef<string|null>(null),actionMessages=shallowRef<Record<string,string>>({});
const batchMessage=shallowRef(''),batchIssues=shallowRef<{id:string;title:string;reason:string}[]>([]);
const history=shallowRef<{workflowId:string;title:string;ordinal:number;stepName:string}|null>(null);
let requestVersion=0;
const pageSize=20;
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
function stepReady(item:Workflow,ordinal:number){return views.value[item.id]?.steps.find(step=>step.ordinal===ordinal)?.ready===true;}
function stepHint(item:Workflow,ordinal:number){const state=workflowStepDisplay(views.value[item.id],ordinal);return [state.reason,state.finishedAt?'完成时间：'+new Date(state.finishedAt).toLocaleString():''].filter(Boolean).join(' · ');}
async function runAction(item:Workflow,ordinal:number){
 if(!stepReady(item,ordinal)||running.value)return;
 const key=item.id+':'+ordinal,label=ordinal===1?'入库':'脱敏';
 try{running.value=key;error.value='';actionMessages.value={...actionMessages.value,[item.id]:''};await api('/workflows/'+item.id+'/'+(ordinal===1?'intake':'redact'),{method:'POST'});actionMessages.value={...actionMessages.value,[item.id]:label+'已提交'};emit('refresh');await refresh();}
 catch(cause){actionMessages.value={...actionMessages.value,[item.id]:cause instanceof Error?cause.message:label+'提交失败'};await refresh();}
 finally{running.value=null;}
}
async function runBatch(ordinal:1|9){
 if(!filtered.value.length||running.value)return;
 const selected=[...filtered.value],label=ordinal===1?'入库':'脱敏';
 try{
  running.value='batch:'+ordinal;error.value='';batchMessage.value='';batchIssues.value=[];
  const result=await api<{results:{workflow_id:string;status:string;reason?:string;reused?:boolean}[]}>(`/projects/${props.projectId}/steps/${ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_ids:selected.map(item=>item.id)})});
  const counts:Record<string,number>={};for(const item of result.results)counts[item.status]=(counts[item.status]??0)+1;
  batchIssues.value=result.results.filter(item=>['failed','not_found','not_ready'].includes(item.status)).map(item=>({id:item.workflow_id,title:selected.find(pkg=>pkg.id===item.workflow_id)?.title??item.workflow_id,reason:item.reason??'派发失败，请查看任务记录'}));
  batchMessage.value=`${label}：匹配 ${selected.length} 个，排队 ${counts.queued??0}，已完成 ${counts.succeeded??0}，未就绪 ${counts.not_ready??0}，失败 ${(counts.failed??0)+(counts.not_found??0)}。`;
  emit('refresh');await refresh();
 }catch(cause){error.value=cause instanceof Error?cause.message:`批量${label}失败`;await refresh();}
 finally{running.value=null;}
}
watch([()=>props.packages,page,search],()=>{void refresh();});
watch(search,()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
onMounted(refresh);
</script>
<template><Column class="surface-card p-16" :gap="12">
 <Row x="between" wrap y="center" :gap="8"><Column :gap="4"><h2 class="section-title">材料包</h2><span class="text-xs text-muted">匹配 {{ filtered.length }} 个 · 每页 {{ pageSize }} 个</span></Column><Row wrap y="center" :gap="8"><v-text-field v-model="search" placeholder="搜索材料包" aria-label="搜索材料包" hide-details clearable class="filter-field-compact" /><v-btn size="small" variant="outlined" title="执行全部搜索结果，不限当前页" :loading="running==='batch:1'" :disabled="!filtered.length||running!==null" @click="runBatch(1)">批量入库</v-btn><v-btn size="small" variant="outlined" title="执行全部搜索结果，不限当前页" :loading="running==='batch:9'" :disabled="!filtered.length||running!==null" @click="runBatch(9)">批量脱敏</v-btn></Row></Row>
 <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
 <v-alert v-if="batchMessage" type="info" density="compact" role="status"><Column :gap="4"><span>{{ batchMessage }}</span><details v-if="batchIssues.length"><summary class="cursor-pointer">查看未执行记录</summary><ul class="my-0 pl-20"><li v-for="item in batchIssues" :key="item.id">{{ item.title }}：{{ item.reason }}</li></ul></details></Column></v-alert>
 <p v-if="!visible.length" class="text-sm text-muted">{{ packages.length?'没有符合条件的材料包':'暂无材料包。请在“材料与 skill”中同步来源目录。' }}</p>
 <Column v-else class="overflow-x-auto"><v-table density="compact" class="project-records-table min-w-760px">
  <thead><tr><th scope="col">材料包</th><th scope="col">附件</th><th scope="col">入库</th><th scope="col">脱敏</th><th scope="col">题目</th><th scope="col">操作</th></tr></thead>
  <tbody><tr v-for="item in visible" :key="item.id"><td class="max-w-380px"><RouterLink :to="'/workflows/'+item.id" class="link-text font-medium line-clamp-2" :title="item.title">{{ item.title }}</RouterLink></td><td class="whitespace-nowrap">{{ item.material_count??0 }} 份</td>
   <td v-for="ordinal in [1,9]" :key="ordinal"><v-btn variant="text" size="small" :color="workflowStepDisplay(views[item.id],ordinal).color" :title="stepHint(item,ordinal)" @click="openHistory(item,ordinal)">{{ workflowStepDisplay(views[item.id],ordinal).label }}</v-btn></td>
   <td class="whitespace-nowrap">{{ counts[item.id]??0 }} 道</td><td><Row wrap :gap="4"><v-btn v-for="ordinal in [1,9]" :key="ordinal" size="small" variant="text" color="primary" :loading="running===item.id+':'+ordinal" :disabled="!stepReady(item,ordinal)||running!==null||loading" :title="stepHint(item,ordinal)" @click="runAction(item,ordinal)">{{ ordinal===1?'入库':'脱敏' }}</v-btn><v-btn size="small" variant="text" color="primary" :to="'/workflows/'+item.id">详情</v-btn></Row><span v-if="actionMessages[item.id]" class="text-xs text-muted">{{ actionMessages[item.id] }}</span></td></tr></tbody>
 </v-table></Column>
 <Row x="between" y="center"><span class="text-xs text-muted">{{ loading?'正在读取状态…':'第 '+page+' / '+pageCount+' 页' }}</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="材料包分页" /></Row>
 <WorkflowAttemptHistory v-if="history" :key="history.workflowId+'-'+history.ordinal" v-bind="history" @close="history=null" />
</Column></template>
