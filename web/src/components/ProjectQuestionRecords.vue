<!--
职责：按关键词、标签和出题／作答／评分状态筛选项目全部题目，展示步骤状态、逐模型评分与单题操作。
关键方法与用法：接收 `workflows`、`packages`、`projectId`；分批读取轻量步骤状态，达标详情和缺少评分的旧列表记录按需补读；返修建议覆盖核对与批量派发覆盖项目全部题目，不受表格筛选和分页影响。
-->

<script setup lang="ts">
import { api } from '../api/client';
import {dispatchWorkflowBatch} from '../api/batch-dispatch';
import { dateLabel } from '../utils/format';
import { statusLabels, type ProjectWorkflowStatus, type Workflow, type WorkflowDetail } from '../types/api';
import {workflowStepDisplay,batchStepIssue,type WorkflowStatusView} from '../utils/workflow-status';
import WorkflowAttemptHistory from './WorkflowAttemptHistory.vue';
import AcceptedQuestionDetail from './AcceptedQuestionDetail.vue';

const props=defineProps<{workflows:Workflow[];totalQuestions?:number;packages:Workflow[];projectId:string;workflowStatus?:Record<string,ProjectWorkflowStatus>;materialPackagesEnabled?:boolean;hasMore?:boolean;loadingMore?:boolean}>();
const emit=defineEmits<{refresh:[];'load-all':[]}>();
const materialsOpen=shallowRef(false),materialsBusy=shallowRef(false),materialsError=shallowRef('');
const materialsDetail=shallowRef<WorkflowDetail>();
let materialsRequest=0;
let materialsController:AbortController|undefined;
async function openMaterials(flow:Workflow){
 materialsController?.abort();const controller=new AbortController();materialsController=controller;
 const token=++materialsRequest;materialsOpen.value=true;materialsBusy.value=true;materialsError.value='';materialsDetail.value=undefined;
 try{
  const result=await api<WorkflowDetail>(`/workflows/${flow.id}?view=status`,{signal:controller.signal});
  if(token===materialsRequest&&materialsOpen.value)materialsDetail.value=result;
 }catch(cause){if(token===materialsRequest&&materialsOpen.value)materialsError.value=cause instanceof Error?cause.message:'读取题目附件失败';}
 finally{if(token===materialsRequest)materialsBusy.value=false;}
}
watch(materialsOpen,open=>{if(!open){materialsRequest++;materialsController?.abort();materialsDetail.value=undefined;materialsBusy.value=false;}});
onUnmounted(()=>{materialsRequest++;materialsController?.abort();});
const search=shallowRef<string|null>('');
const selectedTag=shallowRef<string|null>(null);
const authorStatus=shallowRef<string|null>(null),deliveryStatus=shallowRef<string|null>(null);
const statusOptions=['成功','等待','就绪','失败'];
const statusLoading=shallowRef(false);
const statusFilters=computed(()=>[{ordinal:4,value:authorStatus.value},{ordinal:8,value:deliveryStatus.value}]);
const page=shallowRef(1);
const pageSize=20;
interface ProjectQuestionStatus extends WorkflowStatusView {attempt_summary?:{has_authored:boolean}}
const details=shallowRef<Record<string,ProjectQuestionStatus>>({});
const detailErrors=shallowRef<Record<string,string>>({});
const detailLoadingByWorkflow=shallowRef<Record<string,boolean>>({});
const runningAction=shallowRef<string|null>(null);
const batchOrdinal=shallowRef<number|null>(null),batchMessage=shallowRef(''),batchIssues=shallowRef<{id:string;title:string;reason:string}[]>([]);
const actionMessages=shallowRef<Record<string,string>>({});
const history=shallowRef<{workflowId:string;title:string;ordinal:number;stepName:string}|null>(null);
const selectedQuestion=shallowRef<Workflow|null>(null);
const packageNames=computed(()=>Object.fromEntries(props.packages.map(item=>[item.id,item.title])));
const effortLabels:Record<string,string>={low:'低',medium:'中',high:'高',xhigh:'超高'};
function authoringModelLabel(flow:Workflow){
 const config=flow.authoring_model;
 if(!config?.model)return '—';
 const effort=config.reasoning_effort;
 return effort ? config.model+' · '+(effortLabels[effort]??effort) : config.model;
}
function sourceName(flow:Workflow){return flow.library_package_name||(flow.source_workflow_id?packageNames.value[flow.source_workflow_id]:null)||'旧题目目录';}
const tagOptions=computed(()=>[...new Set(props.workflows.flatMap(displayTags))].sort((a,b)=>a.localeCompare(b,'zh-CN')));
function searchableQuestionText(flow:Workflow){return [flow.title,flow.current_task_name,sourceName(flow)].filter(Boolean).join('\n').toLowerCase();}
const filteredWorkflows=computed(()=>{
 const keyword=(search.value??'').trim().toLowerCase();
 return props.workflows.filter(flow=>(!selectedTag.value||displayTags(flow).includes(selectedTag.value))&&searchableQuestionText(flow).includes(keyword))
  .filter(flow=>statusFilters.value.every(filter=>!filter.value||stepState(flow,filter.ordinal).label===filter.value));
});
const hasActiveFilter=computed(()=>Boolean(search.value?.trim()||selectedTag.value||authorStatus.value||deliveryStatus.value));
const totalQuestions=computed(()=>props.hasMore ? props.totalQuestions : props.workflows.length);
const pageCount=computed(()=>Math.max(1,Math.ceil(filteredWorkflows.value.length/pageSize)));
const visibleWorkflows=computed(()=>filteredWorkflows.value.slice((page.value-1)*pageSize,page.value*pageSize));
const stageColumns=computed(()=>[...(!props.materialPackagesEnabled?[{ordinal:1,name:'入库'},{ordinal:9,name:'脱敏'}]:[]),{ordinal:4,name:'出题'},{ordinal:8,name:'交付归档'}]);
function stepState(flow:Workflow,ordinal:number){return workflowStepDisplay(details.value[flow.id],ordinal);}
function stepHint(flow:Workflow,ordinal:number){const state=stepState(flow,ordinal);return [state.reason,state.finishedAt?'完成时间：'+dateLabel(state.finishedAt):''].filter(Boolean).join(' · ');}
function openHistory(flow:Workflow,ordinal:number,name:string){history.value={workflowId:flow.id,title:flow.title,ordinal,stepName:name};}
function displayTags(flow:Workflow){return flow.question_tags?.length?flow.question_tags:flow.target_level?[flow.target_level]:[];}
function currentState(flow:Workflow){
 return flow.current_status?statusLabels[flow.current_status]:'已完成';
}
function nextAction(flow:Workflow){
 const state=currentState(flow);
 if(state==='失败')return '查看失败原因，再按提示重试或修正';
 if(state==='执行中')return '任务正在执行，查看当前进度';
 if(state==='等待')return '查看前置步骤和派发条件';
 if(state==='已完成')return '流程已完成';
 return '查看步骤结果和可用操作';
}
let detailsRefresh:Promise<void>|null=null;
let refreshRequestedAgain=false;
let detailsDisposed=false;
let detailsController:AbortController|undefined;
function refreshDetails(){
 if(detailsDisposed)return Promise.resolve();
 if(detailsRefresh){refreshRequestedAgain=true;return detailsRefresh;}
 if(!props.workflows.length){details.value={};detailErrors.value={};return Promise.resolve();}
 detailsRefresh=(async()=>{
  try{
   do{
    refreshRequestedAgain=false;
    const flows=[...props.workflows],projectId=props.projectId;
    const controller=new AbortController();detailsController=controller;
    if(!flows.length){details.value={};detailErrors.value={};continue;}
    statusLoading.value=true;
    detailLoadingByWorkflow.value=Object.fromEntries(flows.map(flow=>[flow.id,true]));
    try{
     const loaded:Record<string,ProjectQuestionStatus>={},errors:Record<string,string>={};
     for(let offset=0;offset<flows.length;offset+=100){
      Object.assign(loaded,await api<Record<string,ProjectQuestionStatus>>(`/projects/${projectId}/workflow-status?ids=${flows.slice(offset,offset+100).map(flow=>flow.id).join(',')}`,{signal:controller.signal}));
     }
     if(!detailsDisposed&&!controller.signal.aborted&&projectId===props.projectId){details.value=loaded;detailErrors.value=errors;}
    }catch(cause){if(!detailsDisposed&&!controller.signal.aborted){details.value={};detailErrors.value=Object.fromEntries(flows.map(flow=>[flow.id,cause instanceof Error?cause.message:'读取步骤状态失败']));}}
    finally{detailLoadingByWorkflow.value={};}
   }while(refreshRequestedAgain&&!detailsDisposed);
  }catch(cause){actionMessages.value={...actionMessages.value,refresh:cause instanceof Error?cause.message:'读取题目步骤状态失败'};}
  finally{detailsRefresh=null;statusLoading.value=false;}
 })();
 return detailsRefresh;
}
function syncDetailsFromProject(){
 if(props.workflowStatus){refreshRequestedAgain=false;detailsController?.abort();details.value=props.workflowStatus;detailErrors.value={};statusLoading.value=false;detailLoadingByWorkflow.value={};return;}
 void refreshDetails();
}
interface RowAction {ordinal:number;path:string;label:string;disabled:boolean}
function actionsFor(flow:Workflow):RowAction[]{
 const detail=details.value[flow.id];
 if(!detail||detail.steps.some(step=>step.ordinal===8&&step.status==='succeeded'))return [];
 const status=(ordinal:number)=>detail.steps.find(step=>step.ordinal===ordinal)?.status;
 const ready=(ordinal:number)=>detail.steps.find(step=>step.ordinal===ordinal)?.ready===true;
 const active=(ordinals:number[])=>ordinals.some(ordinal=>detail.steps.find(step=>step.ordinal===ordinal)?.active===true);
 const hasAuthored=detail.attempt_summary?.has_authored??detail.attempts?.some(attempt=>attempt.ordinal===4&&attempt.status==='succeeded')??false;
 const actions:RowAction[]=[];
 const libraryQuestion=Boolean(flow.library_package_id);
 if(!flow.source_workflow_id&&!libraryQuestion){
  if(status(1)!=='succeeded')actions.push({ordinal:1,path:'/intake',label:'入库',disabled:!ready(1)||active([1,2])});
  actions.push({ordinal:9,path:'/redact',label:'脱敏',disabled:!ready(9)||active([9])});
 }
 actions.push({ordinal:4,path:'/author',label:hasAuthored?'重新生成题目':'生成题目',disabled:!(ready(4)||(status(4)==='succeeded'&&(Boolean(flow.source_workflow_id)||libraryQuestion||status(9)==='succeeded')))||active([4])});
 actions.push({ordinal:8,path:'/publish',label:status(8)==='succeeded'?'重新执行项目交付':'交付归档',disabled:!(ready(8)||(status(8)==='succeeded'&&status(4)==='succeeded'))||active([8])});
 return actions;
}
async function runAction(flow:Workflow,action:RowAction){
 const key=`${flow.id}:${action.ordinal}`;
 if(action.disabled||runningAction.value)return;
 try{
  runningAction.value=key;
  actionMessages.value={...actionMessages.value,[flow.id]:''};
  await api(`/workflows/${flow.id}${action.path}`,{method:'POST'});
  actionMessages.value={...actionMessages.value,[flow.id]:`${action.label}已提交`};
  emit('refresh');
 }catch(cause){actionMessages.value={...actionMessages.value,[flow.id]:cause instanceof Error?cause.message:`${action.label}提交失败`};}
 finally{runningAction.value=null;}
}
async function runBatch(ordinal:number){
 if(statusLoading.value||!filteredWorkflows.value.length||runningAction.value||batchOrdinal.value!==null)return;
 const selected=[...filteredWorkflows.value],name=stageColumns.value.find(stage=>stage.ordinal===ordinal)?.name??'步骤';
 try{
  batchOrdinal.value=ordinal;batchMessage.value='';batchIssues.value=[];
  const result=await dispatchWorkflowBatch(props.projectId,ordinal,selected.map(flow=>flow.id),(receipts,total)=>{
   batchMessage.value=`${name}正在派发：已取得 ${receipts.length}/${total} 道题回执。`;
  });
  const counts:Record<string,number>={};for(const item of result.results)counts[item.status]=(counts[item.status]??0)+1;
  batchIssues.value=result.results.filter(item=>batchStepIssue(item)!==null).map(item=>({id:item.workflow_id,title:selected.find(flow=>flow.id===item.workflow_id)?.title??item.workflow_id,reason:batchStepIssue(item)!}));
  batchMessage.value=`${name}：匹配 ${selected.length} 道，排队 ${counts.queued??0}，已完成 ${counts.succeeded??0}，已归档跳过 ${counts.already_archived??0}，未就绪 ${counts.not_ready??0}，容量不足未派发 ${counts.capacity_exceeded??0}，失败 ${(counts.failed??0)+(counts.not_found??0)}。`;
  emit('refresh');
 }catch(cause){batchMessage.value=cause instanceof Error?cause.message:`批量${name}失败`;await refreshDetails();}
 finally{batchOrdinal.value=null;}
}
onMounted(syncDetailsFromProject);
onBeforeUnmount(()=>{detailsDisposed=true;refreshRequestedAgain=false;detailsController?.abort();});
watch([()=>props.workflows,()=>props.workflowStatus,()=>props.projectId],syncDetailsFromProject);
watch([search,selectedTag,authorStatus,deliveryStatus],()=>{
 page.value=1;
 if(hasActiveFilter.value&&props.hasMore&&!props.loadingMore)emit('load-all');
});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
</script>

<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap :gap="12">
   <Column :gap="4"><h2 class="section-title">题目记录</h2><span class="text-xs text-muted"><template v-if="totalQuestions!=null">全期 {{ totalQuestions }} 道题 · </template><template v-if="props.hasMore">已加载 {{ props.workflows.length }} 道 · </template><template v-if="hasActiveFilter">{{ props.hasMore ? '已加载中匹配' : '匹配' }} {{ filteredWorkflows.length }} 道 · </template>每页 {{ pageSize }} 道<template v-if="props.loadingMore"> · 加载中…</template></span></Column>
   <Row wrap y="center" :gap="8">
    <v-select v-model="authorStatus" :items="statusOptions" label="出题状态" placeholder="全部" aria-label="按出题状态筛选" hide-details clearable class="filter-field-compact" />
    <v-select v-model="deliveryStatus" :items="statusOptions" label="交付状态" placeholder="全部" aria-label="按交付状态筛选" hide-details clearable class="filter-field-compact" />
    <v-select v-model="selectedTag" :items="tagOptions" placeholder="全部出题标签" aria-label="按出题标签筛选" hide-details clearable class="filter-field-compact" />
    <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索题目" hide-details clearable class="filter-field-compact" />
   </Row>
  </Row>
  <p v-if="statusLoading" class="text-xs text-muted" role="status">正在读取全部题目状态…</p>
  <v-alert v-if="Object.keys(detailErrors).length" type="error" density="compact">部分题目状态读取失败，请刷新后重试。</v-alert>
  <Row wrap y="center" :gap="6"><span class="text-xs text-muted mr-4">筛选结果批量操作</span><v-btn v-for="stage in stageColumns" :key="stage.ordinal" size="small" variant="outlined" title="执行全部筛选结果，不限当前页" :loading="batchOrdinal===stage.ordinal" :disabled="statusLoading||!filteredWorkflows.length||runningAction!==null||batchOrdinal!==null" @click="runBatch(stage.ordinal)">批量{{ stage.name }}</v-btn></Row>
  <v-alert v-if="batchMessage" type="info" density="compact" role="status"><Column :gap="4"><span>{{ batchMessage }}</span><details v-if="batchIssues.length"><summary class="cursor-pointer">查看未完成原因</summary><ul class="my-0 pl-20"><li v-for="item in batchIssues" :key="item.id">{{ item.title }}：{{ item.reason }}</li></ul></details></Column></v-alert>
  <p v-if="!visibleWorkflows.length&&!statusLoading&&!props.loadingMore" class="text-sm text-muted">{{ !props.workflows.length?(props.materialPackagesEnabled?'暂无已创建题目。请在“本期材料”中选择材料包并设置题目名称、场景、角色、等级、方向和标签。':'暂无题目。将材料放入题目子文件夹后同步目录。'):'没有符合条件的题目' }}</p>
  <Column v-else class="w-full overflow-x-auto">
   <v-table density="compact" class="project-records-table min-w-1080px">
    <thead><tr><th scope="col">题目</th><th scope="col" title="最近一次出题派发时指定的模型和推理强度">出题模型</th><th scope="col">所属材料包</th><th scope="col">当前附件</th><th v-for="stage in stageColumns" :key="stage.ordinal" scope="col">{{ stage.name }}</th><th scope="col">步骤操作</th></tr></thead>
    <tbody>
     <tr v-for="flow in visibleWorkflows" :key="flow.id">
      <td class="max-w-260px"><Column :gap="4"><Row wrap y="center" :gap="4"><button type="button" class="link-text cursor-pointer border-none bg-transparent p-0 text-left font-medium line-clamp-2" :title="`查看题目详情：${flow.title}`" @click="selectedQuestion=flow">{{ flow.title }}</button><v-chip v-if="flow.load_eligible===false" size="x-small" color="warning" variant="tonal">材料≤10页（约 {{ flow.load_estimated_docx_pages }} 页）</v-chip><Row v-if="displayTags(flow).length" wrap :gap="4"><v-chip v-for="tag in displayTags(flow)" :key="tag" size="small">{{ tag }}</v-chip></Row></Row></Column></td>
      <td class="whitespace-nowrap">{{ authoringModelLabel(flow) }}</td>
      <td class="max-w-220px"><RouterLink v-if="flow.library_package_id" :to="`/materials/${flow.library_package_id}`" class="link-text line-clamp-2" :title="sourceName(flow)">{{ sourceName(flow) }}</RouterLink><RouterLink v-else-if="flow.source_workflow_id" :to="`/workflows/${flow.source_workflow_id}`" class="link-text line-clamp-2" :title="sourceName(flow)">{{ sourceName(flow) }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
      <td class="whitespace-nowrap"><v-btn variant="text" :disabled="!flow.material_count" @click="openMaterials(flow)">查看附件 · {{ flow.material_count??0 }} 份</v-btn></td>
      <td v-for="stage in stageColumns" :key="stage.ordinal" class="whitespace-nowrap"><v-btn size="small" variant="text" :color="stepState(flow,stage.ordinal).color" :title="stepHint(flow,stage.ordinal)" @click="openHistory(flow,stage.ordinal,stage.name)">{{ stepState(flow,stage.ordinal).label }}</v-btn></td>
      <td class="whitespace-nowrap"><Row :gap="4"><v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" size="small" variant="text" color="primary" :disabled="!actionsFor(flow).length||detailLoadingByWorkflow[flow.id]">步骤操作</v-btn></template><v-list density="compact"><v-list-item v-for="action in actionsFor(flow)" :key="action.ordinal" :title="action.label" :disabled="action.disabled||runningAction!==null" @click="runAction(flow,action)" /></v-list></v-menu><span v-if="runningAction?.startsWith(flow.id+':')" class="text-xs text-muted">提交中…</span><span v-if="detailLoadingByWorkflow[flow.id]&&!details[flow.id]&&!detailErrors[flow.id]" class="text-xs text-muted">读取中…</span></Row><span v-if="detailErrors[flow.id]" class="text-xs text-danger" :title="detailErrors[flow.id]">读取失败</span><span v-else-if="actionMessages[flow.id]" class="text-xs text-muted" :title="actionMessages[flow.id]">{{ actionMessages[flow.id] }}</span><span v-else-if="!actionsFor(flow).length&&!detailLoadingByWorkflow[flow.id]" class="text-xs text-muted" :title="nextAction(flow)">{{ currentState(flow) }}</span></td>
     </tr>
    </tbody>
   </v-table>
  </Column>
  <WorkflowAttemptHistory v-if="history" :key="`${history.workflowId}-${history.ordinal}`" v-bind="history" @close="history=null" />
  <AcceptedQuestionDetail v-if="selectedQuestion" :workflow-id="selectedQuestion.id" :title="selectedQuestion.title" @close="selectedQuestion=null" />
  <Row x="between" wrap y="center" :gap="8">
   <span class="text-xs text-muted">{{ props.hasMore ? '已加载记录' : '' }}第 {{ page }} / {{ pageCount }} 页</span>
   <v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="题目记录分页" />
  </Row>
 </Column>
  <v-dialog v-model="materialsOpen" max-width="1100" scrollable>
   <Column class="surface-card p-20 max-h-[85vh] overflow-y-auto" :gap="12">
    <Row x="between" y="center" :gap="12"><h2 class="section-title">题目附件 · {{ materialsDetail?.materials.length??0 }} 份</h2><v-btn @click="materialsOpen=false">关闭</v-btn></Row>
    <p v-if="materialsBusy" class="text-muted" role="status">正在读取附件清单…</p>
    <v-alert v-if="materialsError" type="error" role="alert">{{ materialsError }}</v-alert>
    <MaterialRecordsTable v-if="materialsDetail" :key="materialsDetail.workflow.id" :workflow-id="materialsDetail.workflow.id" :materials="materialsDetail.materials" :steps="materialsDetail.steps" :prefer-redacted="materialsDetail.question_material_origin?.kind!=='library_v1'||materialsDetail.question_material_origin.material_mode!=='original'" read-only/>
   </Column>
  </v-dialog>
</template>
