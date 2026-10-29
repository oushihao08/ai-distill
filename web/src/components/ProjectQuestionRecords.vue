<!--
职责：按关键词、标签和出题／作答／评分状态筛选项目全部题目，展示步骤状态、逐模型评分与单题操作。
关键方法与用法：接收 `workflows`、`packages`、`projectId`；分批读取轻量步骤状态，达标详情和缺少评分的旧列表记录按需补读；`runBatch()` 对全部筛选结果派发。
-->

<script setup lang="ts">
import { api,ApiRequestError } from '../api/client';
import {dispatchWorkflowBatch} from '../api/batch-dispatch';
import { dateLabel } from '../utils/format';
import { readAcceptanceResult, readAnswerStepResult, readScoreStepResult, statusLabels, type Attempt, type ProjectWorkflowStatus, type ScoreStepModelSummary, type Workflow, type WorkflowDetail } from '../types/api';
import {workflowStepDisplay,acceptanceBatchSummary,batchStepIssue,type BatchStepResult,type WorkflowStatusView} from '../utils/workflow-status';
import RevisionAdvice from './RevisionAdvice.vue';
import WorkflowAttemptHistory from './WorkflowAttemptHistory.vue';
import ModelEvaluationSummary from './ModelEvaluationSummary.vue';

const props=defineProps<{workflows:Workflow[];packages:Workflow[];projectId:string;workflowStatus?:Record<string,ProjectWorkflowStatus>;materialPackagesEnabled?:boolean}>();
const emit=defineEmits<{refresh:[]}>();
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
const authorStatus=shallowRef<string|null>(null),answerStatus=shallowRef<string|null>(null),scoreStatus=shallowRef<string|null>(null);
const acceptanceStatus=shallowRef<string|null>(null);
const acceptanceOptions=[{title:'达标',value:'达标'},{title:'不达标',value:'未达标'}];
const statusOptions=['成功','等待','就绪','失败'];
const statusLoading=shallowRef(false);
const statusFilters=computed(()=>[{ordinal:4,value:authorStatus.value},{ordinal:5,value:answerStatus.value},{ordinal:6,value:scoreStatus.value},{ordinal:7,value:acceptanceStatus.value}]);
const page=shallowRef(1);
const pageSize=20;
interface ProjectQuestionStatus extends WorkflowStatusView {attempt_summary?:{has_authored:boolean}}
const details=shallowRef<Record<string,ProjectQuestionStatus>>({});
const detailErrors=shallowRef<Record<string,string>>({});
const detailLoadingByWorkflow=shallowRef<Record<string,boolean>>({});
const runningAction=shallowRef<string|null>(null);
const adviceBatch=shallowRef(false);
const batchOrdinal=shallowRef<number|null>(null),batchMessage=shallowRef(''),batchIssues=shallowRef<{id:string;title:string;reason:string}[]>([]);
const actionMessages=shallowRef<Record<string,string>>({});
const decisionDetailOpen=shallowRef(false);
const selectedDecisionFlow=shallowRef<Workflow|null>(null);
const selectedDecisionAttempt=shallowRef<Attempt|null>(null);
const decisionDetailLoading=shallowRef(false),decisionDetailError=shallowRef('');
const history=shallowRef<{workflowId:string;title:string;ordinal:number;stepName:string}|null>(null);
const scoreDetailOpen=shallowRef(false),scoreDetailLoading=shallowRef(false),scoreDetailError=shallowRef('');
const scoreDetailFlow=shallowRef<Workflow|null>(null),scoreDetail=shallowRef<Pick<WorkflowDetail,'steps'|'attempts'>|null>(null);
let scoreRequestVersion=0;
let decisionRequestVersion=0;
const selectedAggregate=computed(()=>{const result=selectedDecisionAttempt.value?.result as {aggregate?:{mean_percentage:number;threshold:number;model_count:number}}|null;return result?.aggregate;});
const packageNames=computed(()=>Object.fromEntries(props.packages.map(item=>[item.id,item.title])));
function sourceName(flow:Workflow){return flow.library_package_name||(flow.source_workflow_id?packageNames.value[flow.source_workflow_id]:null)||'旧题目目录';}
const tagOptions=computed(()=>[...new Set(props.workflows.flatMap(displayTags))].sort((a,b)=>a.localeCompare(b,'zh-CN')));
const filteredWorkflows=computed(()=>{
 const keyword=(search.value??'').trim().toLowerCase();
 return props.workflows.filter(flow=>(!selectedTag.value||displayTags(flow).includes(selectedTag.value))&&(flow.title.toLowerCase().includes(keyword)||sourceName(flow).toLowerCase().includes(keyword)))
  .filter(flow=>statusFilters.value.every(filter=>!filter.value||stepState(flow,filter.ordinal).label===filter.value));
});
const pageCount=computed(()=>Math.max(1,Math.ceil(filteredWorkflows.value.length/pageSize)));
const visibleWorkflows=computed(()=>filteredWorkflows.value.slice((page.value-1)*pageSize,page.value*pageSize));
const stageColumns=computed(()=>[...(!props.materialPackagesEnabled?[{ordinal:1,name:'入库'},{ordinal:9,name:'脱敏'}]:[]),{ordinal:4,name:'出题'},{ordinal:5,name:'作答'},{ordinal:6,name:'评分'},{ordinal:7,name:'达标判断'},{ordinal:8,name:'归档'}]);
function stepState(flow:Workflow,ordinal:number){return workflowStepDisplay(details.value[flow.id],ordinal);}
function stepHint(flow:Workflow,ordinal:number){const state=stepState(flow,ordinal);return [state.reason,state.finishedAt?'完成时间：'+dateLabel(state.finishedAt):''].filter(Boolean).join(' · ');}
function openHistory(flow:Workflow,ordinal:number,name:string){history.value={workflowId:flow.id,title:flow.title,ordinal,stepName:name};}
function displayTags(flow:Workflow){return flow.question_tags?.length?flow.question_tags:flow.target_level?[flow.target_level]:[];}
function currentState(flow:Workflow){
 if(flow.current_ordinal===6&&flow.current_decision==='repair')return '未达标';
 return flow.current_status?statusLabels[flow.current_status]:'已完成';
}
function nextAction(flow:Workflow){
 const state=currentState(flow);
 if(state==='失败')return '查看失败原因，再按提示重试或修正';
 if(state==='执行中')return '任务正在执行，查看当前进度';
 if(state==='未达标')return '查看各模型评分和未达标原因';
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
     // 已部署的旧列表投影不含评分；仅对已执行评分的题目补读不含题面／答案正文的状态视图。
     const missingScores=flows.filter(flow=>{
      const step=loaded[flow.id]?.steps.find(step=>step.ordinal===6);
      return step&&['running','succeeded','failed'].includes(step.status)&&!readScoreStepResult(step.result)?.models.length;
     });
     for(let offset=0;offset<missingScores.length;offset+=4){
      await Promise.all(missingScores.slice(offset,offset+4).map(async flow=>{
       try{
        const full=await api<Pick<WorkflowDetail,'steps'|'attempts'>>(`/workflows/${flow.id}?view=status`,{signal:controller.signal});
        const score=full.steps.find(step=>step.ordinal===6);
        if(score)loaded[flow.id]!.steps=loaded[flow.id]!.steps.map(step=>step.ordinal===6?{...step,result:score.result}:step);
       }catch(cause){errors[flow.id]=cause instanceof Error?cause.message:'读取评分明细失败';}
      }));
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
 const answerStep=detail.steps.find(step=>step.ordinal===5);
 const models=readAnswerStepResult(answerStep?.result)?.models;
 const answerReady=answerStep?.status==='succeeded'||(!!models?.length&&models.every(model=>['succeeded','failed','skipped'].includes(model.status))&&models.some(model=>model.status==='succeeded'&&typeof model.attempt_id==='string'));
 const decision=detail.steps.find(step=>step.ordinal===7)?.result?.decision;
 const actions:RowAction[]=[];
 const libraryQuestion=Boolean(flow.library_package_id);
 if(!flow.source_workflow_id&&!libraryQuestion){
  if(status(1)!=='succeeded')actions.push({ordinal:1,path:'/intake',label:'入库',disabled:!ready(1)||active([1,2])});
  actions.push({ordinal:9,path:'/redact',label:'脱敏',disabled:!ready(9)||active([9])});
 }
 actions.push({ordinal:4,path:'/author',label:hasAuthored?'重新生成题目':'生成题目',disabled:!(ready(4)||(status(4)==='succeeded'&&(Boolean(flow.source_workflow_id)||libraryQuestion||status(9)==='succeeded')))||active([4])});
 actions.push({ordinal:5,path:'/answer',label:'模型作答',disabled:!(ready(5)||(status(5)==='succeeded'&&status(4)==='succeeded'))||active([5])});
 actions.push({ordinal:6,path:'/score',label:'独立评分',disabled:!answerReady||!(ready(6)||status(6)==='succeeded')||active([6])});
 actions.push({ordinal:8,path:'/publish',label:status(8)==='succeeded'?'重新执行项目交付':'归档题目',disabled:!(ready(8)||(status(8)==='succeeded'&&status(7)==='succeeded'&&decision==='accepted'))||active([8])});
 return actions;
}
function decisionScores(attempt:Attempt|null){
 const result=readAcceptanceResult(attempt?.result);
 return Object.entries(result?.model_scores??{});
}
function scoreModels(flow:Workflow){return readScoreStepResult(details.value[flow.id]?.steps.find(step=>step.ordinal===6)?.result)?.models??[];}
function modelScoreText(model:ScoreStepModelSummary){
 const name=model.name||model.model_id||'未知模型';
 const score=model.score_contract==='model_report_v1'?model.raw_score:model.score;
 const maximum=model.score_contract==='model_report_v1'?model.full_score:model.max_score;
 if(typeof score==='number'&&typeof maximum==='number')return `${name} ${model.score_contract==='model_report_v1'?'原始分 ':''}${score}/${maximum}${model.veto_triggered===true?' · 否决':''}`;
 return `${name} ${model.score_status==='failed'?'评分失败':model.score_status==='running'?'评分中':model.score_status==='waiting'?'等待评分':'暂无分数'}`;
}
async function showScoreDetail(flow:Workflow){
 const version=++scoreRequestVersion;
 scoreDetailFlow.value=flow;scoreDetail.value=null;scoreDetailError.value='';scoreDetailOpen.value=true;scoreDetailLoading.value=true;
 try{
  const detail=await api<WorkflowDetail>(`/workflows/${flow.id}`);
  if(version===scoreRequestVersion)scoreDetail.value={steps:detail.steps,attempts:detail.attempts};
 }catch(cause){if(version===scoreRequestVersion)scoreDetailError.value=cause instanceof Error?cause.message:'读取评分详情失败';}
 finally{if(version===scoreRequestVersion)scoreDetailLoading.value=false;}
}
function decisionModelName(flow:Workflow,modelId:string){
 const models=readAnswerStepResult(details.value[flow.id]?.steps.find(step=>step.ordinal===5)?.result)?.models;
 if(!models)return modelId;
 const model=models.find(item=>item.model_id===modelId);
 return typeof model?.name==='string'&&model.name?model.name:modelId;
}
function decisionPercent(value:number|undefined){return typeof value==='number'?`${Number(value.toFixed(1))}%`:'—';}
async function showDecisionDetail(flow:Workflow){
 const version=++decisionRequestVersion;
 selectedDecisionFlow.value=flow;selectedDecisionAttempt.value=null;decisionDetailError.value='';decisionDetailOpen.value=true;decisionDetailLoading.value=true;
 try{
  const detail=await api<WorkflowDetail>(`/workflows/${flow.id}?view=status`);
  if(version===decisionRequestVersion)selectedDecisionAttempt.value=[...detail.attempts.filter(attempt=>attempt.ordinal===7)].sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at))[0]??null;
 }catch(cause){if(version===decisionRequestVersion)decisionDetailError.value=cause instanceof Error?cause.message:'读取达标判断记录失败';}
 finally{if(version===decisionRequestVersion)decisionDetailLoading.value=false;}
}
function decisionAttemptStatus(attempt:Attempt){const result=readAcceptanceResult(attempt.result);if(attempt.ordinal===7&&result){return ({accepted:'达标',repair:'未达标',waiting:'等待判定条件',quarantine:'隔离'} as Record<string,string>)[result.decision]??statusLabels[attempt.status];}return statusLabels[attempt.status];}
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
  batchMessage.value=`${name}：匹配 ${selected.length} 道，排队 ${counts.queued??0}，${ordinal===7?acceptanceBatchSummary(result.results):`已完成 ${counts.succeeded??0}`}，已归档跳过 ${counts.already_archived??0}，已达标跳过 ${counts.already_accepted??0}，未就绪 ${counts.not_ready??0}，容量不足未派发 ${counts.capacity_exceeded??0}，失败 ${(counts.failed??0)+(counts.not_found??0)}。`;
  emit('refresh');
 }catch(cause){batchMessage.value=cause instanceof Error?cause.message:`批量${name}失败`;await refreshDetails();}
 finally{batchOrdinal.value=null;}
}
onMounted(syncDetailsFromProject);
onBeforeUnmount(()=>{detailsDisposed=true;refreshRequestedAgain=false;detailsController?.abort();});
watch([()=>props.workflows,()=>props.workflowStatus,()=>props.projectId],syncDetailsFromProject);
watch([search,selectedTag,authorStatus,answerStatus,scoreStatus,acceptanceStatus],()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
async function generateBatchAdvice(){
 if(adviceBatch.value||batchOrdinal.value!==null)return;
 adviceBatch.value=true;batchMessage.value='';batchIssues.value=[];
 let queued=0,skipped=0,failed=0,capacity=false,unknown=false;
 try{
  for(const [index,flow] of filteredWorkflows.value.entries()){
   if(details.value[flow.id]?.steps.find(step=>step.ordinal===7)?.result?.decision==='accepted'){skipped++;continue;}
   if(capacity||unknown){batchIssues.value.push({id:flow.id,title:flow.title,reason:capacity?'本机待领取容量已满，未派发':'上一请求回执未知，停止继续派发，请刷新确认'});continue;}
   batchMessage.value=`派发返修建议 ${index+1}/${filteredWorkflows.value.length}`;
   try{await api(`/workflows/${flow.id}/revision-advice`,{method:'POST'});queued++;}
   catch(cause){const reason=cause instanceof Error?cause.message:'派发失败';capacity=cause instanceof ApiRequestError&&cause.code==='local_queue_full';unknown=cause instanceof ApiRequestError&&cause.outcome_unknown;if(!capacity)failed++;batchIssues.value.push({id:flow.id,title:flow.title,reason});}
  }
  batchMessage.value=`返修建议：已排队/复用 ${queued}，已达标跳过 ${skipped}，失败/不符合条件 ${failed}，容量不足未派发 ${batchIssues.value.filter(item=>item.reason.includes('容量')).length}`;
 }finally{adviceBatch.value=false;}
}
</script>

<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap :gap="12">
   <Column :gap="4"><h2 class="section-title">题目记录</h2><span class="text-xs text-muted">匹配 {{ filteredWorkflows.length }} 道题 · 每页 {{ pageSize }} 道</span></Column>
   <Row wrap y="center" :gap="8">
    <v-select v-model="authorStatus" :items="statusOptions" label="出题状态" placeholder="全部" aria-label="按出题状态筛选" hide-details clearable class="filter-field-compact" />
    <v-select v-model="answerStatus" :items="statusOptions" label="作答状态" placeholder="全部" aria-label="按作答状态筛选" hide-details clearable class="filter-field-compact" />
    <v-select v-model="scoreStatus" :items="statusOptions" label="评分状态" placeholder="全部" aria-label="按评分状态筛选" hide-details clearable class="filter-field-compact" />
    <v-select v-model="acceptanceStatus" :items="acceptanceOptions" label="达标判断" placeholder="全部" aria-label="按达标判断筛选" hide-details clearable class="filter-field-compact" />
    <v-select v-model="selectedTag" :items="tagOptions" placeholder="全部出题标签" aria-label="按出题标签筛选" hide-details clearable class="filter-field-compact" />
    <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索题目" hide-details clearable class="filter-field-compact" />
   </Row>
  </Row>
  <p v-if="statusLoading" class="text-xs text-muted" role="status">正在读取全部题目状态及评分…</p>
  <v-alert v-if="Object.keys(detailErrors).length" type="error" density="compact">部分题目状态或评分读取失败，请刷新后重试。</v-alert>
  <Row wrap y="center" :gap="6"><span class="text-xs text-muted mr-4">筛选结果批量操作</span><v-btn v-for="stage in stageColumns" :key="stage.ordinal" size="small" variant="outlined" title="执行全部筛选结果，不限当前页" :loading="batchOrdinal===stage.ordinal" :disabled="statusLoading||!filteredWorkflows.length||runningAction!==null||batchOrdinal!==null||adviceBatch" @click="runBatch(stage.ordinal)">批量{{ stage.name }}</v-btn><v-btn size="small" variant="outlined" :loading="adviceBatch" :disabled="statusLoading||!filteredWorkflows.length||runningAction!==null||batchOrdinal!==null||adviceBatch" @click="generateBatchAdvice">批量返修建议</v-btn></Row>
  <v-alert v-if="batchMessage" type="info" density="compact" role="status"><Column :gap="4"><span>{{ batchMessage }}</span><details v-if="batchIssues.length"><summary class="cursor-pointer">查看未完成原因</summary><ul class="my-0 pl-20"><li v-for="item in batchIssues" :key="item.id">{{ item.title }}：{{ item.reason }}</li></ul></details></Column></v-alert>
  <p v-if="!visibleWorkflows.length&&!statusLoading" class="text-sm text-muted">{{ !props.workflows.length?(props.materialPackagesEnabled?'暂无已创建题目。请在“本期材料”中选择材料包并设置题目名称、场景、角色、等级、方向和标签。':'暂无题目。将材料放入题目子文件夹后同步目录。'):'没有符合条件的题目' }}</p>
  <Column v-else class="w-full overflow-x-auto">
   <v-table density="compact" class="project-records-table min-w-1080px">
    <thead><tr><th scope="col">题目</th><th scope="col">所属材料包</th><th scope="col">当前附件</th><th v-for="stage in stageColumns" :key="stage.ordinal" scope="col">{{ stage.name }}</th><th scope="col">步骤操作</th></tr></thead>
    <tbody>
     <tr v-for="flow in visibleWorkflows" :key="flow.id">
      <td class="max-w-260px"><Column :gap="4"><Row :gap="4"><RouterLink :to="`/workflows/${flow.id}`" class="link-text font-medium line-clamp-2" :title="flow.title">{{ flow.title }}</RouterLink><Row v-if="displayTags(flow).length" wrap :gap="4"><v-chip v-for="tag in displayTags(flow)" :key="tag" size="small">{{ tag }}</v-chip></Row></Row><RevisionAdvice :workflow-id="flow.id" :disabled="details[flow.id]?.steps.find(step=>step.ordinal===7)?.result?.decision==='accepted'||details[flow.id]?.steps.some(step=>[4,5,6].includes(step.ordinal)&&step.active)"/></Column></td>
      <td class="max-w-220px"><RouterLink v-if="flow.library_package_id" :to="`/materials/${flow.library_package_id}`" class="link-text line-clamp-2" :title="sourceName(flow)">{{ sourceName(flow) }}</RouterLink><RouterLink v-else-if="flow.source_workflow_id" :to="`/workflows/${flow.source_workflow_id}`" class="link-text line-clamp-2" :title="sourceName(flow)">{{ sourceName(flow) }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
      <td class="whitespace-nowrap"><v-btn variant="text" :disabled="!flow.material_count" @click="openMaterials(flow)">查看附件 · {{ flow.material_count??0 }} 份</v-btn></td>
      <td v-for="stage in stageColumns" :key="stage.ordinal" :class="stage.ordinal===6?'min-w-180px':'whitespace-nowrap'"><Column :gap="2"><Row wrap y="center" :gap="2"><v-btn size="small" variant="text" :color="stepState(flow,stage.ordinal).color" :title="stepHint(flow,stage.ordinal)" @click="openHistory(flow,stage.ordinal,stage.name)">{{ stepState(flow,stage.ordinal).label }}</v-btn><v-btn v-if="stage.ordinal===6&&scoreModels(flow).length" size="small" variant="text" color="primary" @click="showScoreDetail(flow)">查看评分</v-btn><v-btn v-if="stage.ordinal===7&&details[flow.id]?.steps.find(step=>step.ordinal===7)?.result?.decision" size="small" variant="text" color="primary" @click="showDecisionDetail(flow)">详情</v-btn></Row><template v-if="stage.ordinal===6&&scoreModels(flow).length"><span v-for="(model,index) in scoreModels(flow)" :key="model.model_id??index" class="text-xs text-muted whitespace-nowrap">{{ modelScoreText(model) }}</span></template></Column></td>
      <td class="whitespace-nowrap"><Row :gap="4"><v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" size="small" variant="text" color="primary" :disabled="!actionsFor(flow).length||detailLoadingByWorkflow[flow.id]">步骤操作</v-btn></template><v-list density="compact"><v-list-item v-for="action in actionsFor(flow)" :key="action.ordinal" :title="action.label" :disabled="action.disabled||runningAction!==null" @click="runAction(flow,action)" /></v-list></v-menu><span v-if="runningAction?.startsWith(flow.id+':')" class="text-xs text-muted">提交中…</span><span v-if="detailLoadingByWorkflow[flow.id]&&!details[flow.id]&&!detailErrors[flow.id]" class="text-xs text-muted">读取中…</span></Row><span v-if="detailErrors[flow.id]" class="text-xs text-danger" :title="detailErrors[flow.id]">读取失败</span><span v-else-if="actionMessages[flow.id]" class="text-xs text-muted" :title="actionMessages[flow.id]">{{ actionMessages[flow.id] }}</span><span v-else-if="!actionsFor(flow).length&&!detailLoadingByWorkflow[flow.id]" class="text-xs text-muted" :title="nextAction(flow)">{{ currentState(flow) }}</span></td>
     </tr>
    </tbody>
   </v-table>
  </Column>
  <WorkflowAttemptHistory v-if="history" :key="`${history.workflowId}-${history.ordinal}`" v-bind="history" @close="history=null" />
  <v-dialog v-model="scoreDetailOpen" max-width="1120" scrollable>
   <Column class="surface-card p-16" :gap="12">
    <Row x="between" y="center" :gap="8"><h2 class="section-title">评分详情 · {{ scoreDetailFlow?.title }}</h2><v-btn icon="$close" aria-label="关闭评分详情" variant="text" @click="scoreDetailOpen=false" /></Row>
    <p v-if="scoreDetailLoading" class="text-sm text-muted" role="status">正在读取模型评分…</p>
    <v-alert v-else-if="scoreDetailError" type="error" density="compact">{{ scoreDetailError }}</v-alert>
    <ModelEvaluationSummary v-else-if="scoreDetail" :steps="scoreDetail.steps" :attempts="scoreDetail.attempts" />
   </Column>
  </v-dialog>
  <v-dialog v-model="decisionDetailOpen" max-width="960" scrollable>
   <Column class="surface-card p-16" :gap="12">
    <Row x="between" y="center" :gap="12"><Column :gap="4"><h2 class="section-title">达标判断 · 执行详情</h2><span v-if="selectedDecisionAttempt" class="text-xs text-muted">{{ dateLabel(selectedDecisionAttempt.started_at) }}</span></Column><v-btn icon="$close" aria-label="关闭达标判定详情" variant="text" @click="decisionDetailOpen=false" /></Row>
    <v-chip v-if="selectedDecisionAttempt" class="self-start" size="small" :color="selectedDecisionAttempt.status==='succeeded'?'success':selectedDecisionAttempt.status==='failed'?'error':selectedDecisionAttempt.status==='running'?'primary':'secondary'">{{ decisionAttemptStatus(selectedDecisionAttempt) }}</v-chip>
    <v-alert v-if="selectedDecisionAttempt?.error" type="error" density="compact">{{ selectedDecisionAttempt.error }}</v-alert>
    <p v-if="decisionDetailLoading" class="text-sm text-muted">正在读取判定执行记录…</p>
    <p v-else-if="decisionDetailError" class="text-sm text-danger">读取失败：{{ decisionDetailError }}</p>
    <p v-else-if="!selectedDecisionAttempt" class="text-sm text-muted">暂无达标判断执行记录。</p>
    <Column v-else class="max-h-480px overflow-y-auto" :gap="4">
     <section v-if="selectedDecisionFlow&&decisionScores(selectedDecisionAttempt).length" class="surface-panel p-8"><h3 class="px-8 py-4 text-sm font-semibold">模型评分</h3><p v-if="selectedAggregate" class="px-8 pb-4 text-sm">两模型均分 {{ decisionPercent(selectedAggregate.mean_percentage) }}，门槛 ≤{{ selectedAggregate.threshold }}%（{{ selectedAggregate.model_count }} 个模型）</p><v-table density="compact"><thead><tr><th scope="col">模型</th><th scope="col">得分</th><th scope="col">百分制／模型指标</th><th scope="col">门槛</th><th scope="col">评分结果</th></tr></thead><tbody><tr v-for="[modelId,score] in decisionScores(selectedDecisionAttempt)" :key="modelId"><td>{{ decisionModelName(selectedDecisionFlow,modelId) }}</td><td>{{ score.score_contract==='model_report_v1'?'原始分 ':'' }}{{ (score.score_contract==='model_report_v1'?score.raw_score:score.score)??'—' }} / {{ (score.score_contract==='model_report_v1'?score.full_score:score.max_score)??'—' }}{{ score.veto_triggered===true?' · 否决':'' }}</td><td>{{ decisionPercent(score.percentage) }}</td><td>{{ selectedAggregate?`用于均分；≤ ${selectedAggregate.threshold}%`:(typeof score.threshold==='number'?`低于 ${score.threshold}%`:'—') }}</td><td><v-chip size="small" :color="score.status==='passed'?'success':score.status==='not_passed'?'warning':score.status==='invalid'?'error':'secondary'">{{ ({passed:'达标',not_passed:'未达标',pending:'待定',invalid:'无效',included:'计入均分'} as Record<string,string>)[score.status??'']??'未知' }}</v-chip></td></tr></tbody></v-table></section>
     <p class="text-sm text-muted">{{ (selectedDecisionAttempt.result as {reasons?:string[]}|null)?.reasons?.join('；') || '请核对各模型评分与分数上限。' }}</p>
    </Column>
   </Column>
  </v-dialog>
  <Row x="between" wrap y="center" :gap="8">
   <span class="text-xs text-muted">第 {{ page }} / {{ pageCount }} 页</span>
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
