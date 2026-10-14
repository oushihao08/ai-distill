<!--
职责：平铺展示项目全部题目、所属材料包、各步骤状态和单题操作，供项目详情页面复用。
关键方法与用法：接收 `workflows`、`packages`、`projectId`；批量读取当前页状态，`actionsFor()` 生成单题步骤按钮，`runAction()` 调用工作流接口。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel } from '../utils/format';
import { readAcceptanceResult, readAnswerStepResult, statusLabels, type Attempt, type Workflow, type WorkflowDetail } from '../types/api';
import {workflowStepDisplay} from '../utils/workflow-status';
import WorkflowAttemptHistory from './WorkflowAttemptHistory.vue';

const props=defineProps<{workflows:Workflow[];packages:Workflow[];projectId:string;materialPackagesEnabled?:boolean}>();
const emit=defineEmits<{refresh:[]}>();
const search=shallowRef('');
const page=shallowRef(1);
const pageSize=10;
const details=shallowRef<Record<string,Pick<WorkflowDetail,'steps'|'attempts'>>>({});
const detailErrors=shallowRef<Record<string,string>>({});
const detailLoadingByWorkflow=shallowRef<Record<string,boolean>>({});
const runningAction=shallowRef<string|null>(null);
const actionMessages=shallowRef<Record<string,string>>({});
const decisionDetailOpen=shallowRef(false);
const selectedDecisionFlow=shallowRef<Workflow|null>(null);
const history=shallowRef<{workflowId:string;title:string;ordinal:number;stepName:string}|null>(null);
const selectedDecisionAttempt=computed(()=>selectedDecisionFlow.value?latestDecisionAttempt(selectedDecisionFlow.value):null);
const packageNames=computed(()=>Object.fromEntries(props.packages.map(item=>[item.id,item.title])));
const filteredWorkflows=computed(()=>props.workflows.filter(flow=>flow.title.toLowerCase().includes(search.value.trim().toLowerCase())||Boolean(flow.source_workflow_id&&packageNames.value[flow.source_workflow_id]?.toLowerCase().includes(search.value.trim().toLowerCase()))));
const pageCount=computed(()=>Math.max(1,Math.ceil(filteredWorkflows.value.length/pageSize)));
const visibleWorkflows=computed(()=>filteredWorkflows.value.slice((page.value-1)*pageSize,page.value*pageSize));
const stageColumns=computed(()=>[...(!props.materialPackagesEnabled?[{ordinal:1,name:'入库'},{ordinal:9,name:'脱敏'}]:[]),{ordinal:4,name:'出题'},{ordinal:5,name:'作答'},{ordinal:6,name:'评分'},{ordinal:7,name:'达标判断'},{ordinal:8,name:'归档'}]);
function stepState(flow:Workflow,ordinal:number){return workflowStepDisplay(details.value[flow.id],ordinal);}
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
function refreshDetails(){
 if(detailsRefresh){refreshRequestedAgain=true;return detailsRefresh;}
 detailsRefresh=(async()=>{
  try{
   do{
    refreshRequestedAgain=false;
    const flows=visibleWorkflows.value;
    if(!flows.length){details.value={};continue;}
    detailLoadingByWorkflow.value=Object.fromEntries(flows.map(flow=>[flow.id,true]));
    try{
     details.value=await api<Record<string,Pick<WorkflowDetail,'steps'|'attempts'>>>(`/projects/${props.projectId}/workflow-status?ids=${flows.map(flow=>flow.id).join(',')}`);
     detailErrors.value={};
    }catch(cause){detailErrors.value=Object.fromEntries(flows.map(flow=>[flow.id,cause instanceof Error?cause.message:'读取步骤状态失败']));}
    finally{detailLoadingByWorkflow.value={};}
   }while(refreshRequestedAgain);
  }catch(cause){actionMessages.value={...actionMessages.value,refresh:cause instanceof Error?cause.message:'读取题目步骤状态失败'};}
  finally{detailsRefresh=null;}
 })();
 return detailsRefresh;
}
interface RowAction {ordinal:number;path:string;label:string;disabled:boolean}
function actionsFor(flow:Workflow):RowAction[]{
 const detail=details.value[flow.id];
 if(!detail)return [];
 const status=(ordinal:number)=>detail.steps.find(step=>step.ordinal===ordinal)?.status;
 const ready=(ordinal:number)=>detail.steps.find(step=>step.ordinal===ordinal)?.ready===true;
 const active=(ordinals:number[])=>detail.attempts.some(attempt=>ordinals.includes(attempt.ordinal)&&['waiting','running'].includes(attempt.status));
 const hasAuthored=detail.attempts.some(attempt=>attempt.ordinal===4&&attempt.status==='succeeded');
 const answerStep=detail.steps.find(step=>step.ordinal===5);
 const models=readAnswerStepResult(answerStep?.result)?.models;
 const answerReady=answerStep?.status==='succeeded'||(!!models?.length&&models.every(model=>['succeeded','failed','skipped'].includes(model.status))&&models.some(model=>model.status==='succeeded'&&typeof model.attempt_id==='string'));
 const decision=detail.steps.find(step=>step.ordinal===7)?.result?.decision;
 const actions:RowAction[]=[];
 if(!flow.source_workflow_id){
  if(status(1)!=='succeeded')actions.push({ordinal:1,path:'/intake',label:'入库',disabled:!ready(1)||active([1,2])});
  actions.push({ordinal:9,path:'/redact',label:'脱敏',disabled:!ready(9)||active([9])});
 }
 actions.push({ordinal:4,path:'/author',label:hasAuthored?'重新生成题目':'生成题目',disabled:!(ready(4)||(status(4)==='succeeded'&&(Boolean(flow.source_workflow_id)||status(9)==='succeeded')))||active([4])});
 actions.push({ordinal:5,path:'/answer',label:'模型作答',disabled:!(ready(5)||(status(5)==='succeeded'&&status(4)==='succeeded'))||active([5])});
 actions.push({ordinal:6,path:'/score',label:'独立评分',disabled:!answerReady||!(ready(6)||status(6)==='succeeded')||active([6])});
 actions.push({ordinal:8,path:'/publish',label:status(8)==='succeeded'?'重新执行项目交付':'归档题目',disabled:!(ready(8)||(status(8)==='succeeded'&&status(7)==='succeeded'&&decision==='accepted'))||active([8])});
 return actions;
}
function latestDecisionAttempt(flow:Workflow){const attempts=details.value[flow.id]?.attempts.filter(attempt=>attempt.ordinal===7)??[];return [...attempts].sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at))[0]??null;}
function decisionScores(attempt:Attempt|null){
 const result=readAcceptanceResult(attempt?.result);
 return Object.entries(result?.model_scores??{});
}
function decisionModelName(flow:Workflow,modelId:string){
 const models=readAnswerStepResult(details.value[flow.id]?.steps.find(step=>step.ordinal===5)?.result)?.models;
 if(!models)return modelId;
 const model=models.find(item=>item.model_id===modelId);
 return typeof model?.name==='string'&&model.name?model.name:modelId;
}
function decisionPercent(value:number|undefined){return typeof value==='number'?`${Number(value.toFixed(1))}%`:'—';}
function showDecisionDetail(flow:Workflow){selectedDecisionFlow.value=flow;decisionDetailOpen.value=true;}
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
  await refreshDetails();
 }catch(cause){actionMessages.value={...actionMessages.value,[flow.id]:cause instanceof Error?cause.message:`${action.label}提交失败`};}
 finally{runningAction.value=null;}
}
onMounted(refreshDetails);
watch([()=>props.workflows,page,search],()=>{void refreshDetails();});
watch(search,()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
</script>

<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap :gap="12">
   <Column :gap="4"><h2 class="section-title">题目记录</h2><span class="text-xs text-muted">共 {{ filteredWorkflows.length }} 道题 · 每页 {{ pageSize }} 道</span></Column>
   <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索题目" hide-details clearable class="filter-field-compact" />
  </Row>
  <p v-if="!visibleWorkflows.length" class="text-sm text-muted">{{ !props.workflows.length?(props.materialPackagesEnabled?'暂无题目。打开已完成脱敏的材料包详情即可创建题目。':'暂无题目。将材料放入题目子文件夹后同步目录。'):'没有符合条件的题目' }}</p>
  <Column v-else class="w-full overflow-x-auto">
   <v-table density="comfortable" class="min-w-1300px">
    <thead><tr><th scope="col">题目</th><th scope="col">所属材料包</th><th scope="col">当前附件</th><th v-for="stage in stageColumns" :key="stage.ordinal" scope="col">{{ stage.name }}</th><th scope="col">步骤操作</th></tr></thead>
    <tbody>
     <tr v-for="flow in visibleWorkflows" :key="flow.id">
      <td class="min-w-200px"><Column :gap="4"><RouterLink :to="`/workflows/${flow.id}`" class="link-text font-medium break-words">{{ flow.title }}</RouterLink><Row v-if="displayTags(flow).length" wrap :gap="4"><v-chip v-for="tag in displayTags(flow)" :key="tag" size="small">{{ tag }}</v-chip></Row></Column></td>
      <td class="min-w-150px"><RouterLink v-if="flow.source_workflow_id" :to="`/workflows/${flow.source_workflow_id}`" class="link-text">{{ packageNames[flow.source_workflow_id]??'查看材料包' }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
      <td class="whitespace-nowrap">{{ flow.material_count??0 }} 份</td>
      <td v-for="stage in stageColumns" :key="stage.ordinal" class="min-w-110px"><Column :gap="4"><v-btn size="small" variant="text" :color="stepState(flow,stage.ordinal).color" :title="stepState(flow,stage.ordinal).reason" @click="openHistory(flow,stage.ordinal,stage.name)">{{ stepState(flow,stage.ordinal).label }}</v-btn><span v-if="stepState(flow,stage.ordinal).reason&&stepState(flow,stage.ordinal).label!=='成功'" class="text-xs text-muted max-w-150px break-words">{{ stepState(flow,stage.ordinal).reason }}</span><span v-if="stepState(flow,stage.ordinal).finishedAt" class="text-xs text-muted">{{ dateLabel(stepState(flow,stage.ordinal).finishedAt!) }}</span><v-btn v-if="stage.ordinal===7&&details[flow.id]?.steps.find(step=>step.ordinal===7)?.result?.decision" size="small" variant="text" color="primary" @click="showDecisionDetail(flow)">判定详情</v-btn></Column></td>
      <td class="min-w-320px"><Column :gap="4"><Row wrap :gap="4"><v-btn v-for="action in actionsFor(flow)" :key="action.ordinal" size="small" density="compact" color="primary" variant="text" :loading="runningAction===`${flow.id}:${action.ordinal}`" :disabled="action.disabled||runningAction!==null||detailLoadingByWorkflow[flow.id]" @click="runAction(flow,action)">{{ action.label }}</v-btn></Row><span v-if="detailLoadingByWorkflow[flow.id]&&!details[flow.id]&&!detailErrors[flow.id]" class="text-sm text-muted">正在读取可用操作…</span><span v-else-if="detailErrors[flow.id]" class="text-sm text-danger">步骤状态读取失败：{{ detailErrors[flow.id] }}</span><span v-if="actionMessages[flow.id]" class="text-xs text-muted">{{ actionMessages[flow.id] }}</span><span v-else-if="actionMessages.refresh" class="text-xs text-danger">{{ actionMessages.refresh }}</span><span v-if="!actionsFor(flow).length&&!detailLoadingByWorkflow[flow.id]&&!detailErrors[flow.id]&&currentState(flow)!=='未达标'" class="text-sm text-muted">{{ nextAction(flow) }}</span></Column></td>
     </tr>
    </tbody>
   </v-table>
  </Column>
  <WorkflowAttemptHistory v-if="history" :key="`${history.workflowId}-${history.ordinal}`" v-bind="history" @close="history=null" />
  <v-dialog v-model="decisionDetailOpen" max-width="960" scrollable>
   <Column class="surface-card p-16" :gap="12">
    <Row x="between" y="center" :gap="12"><Column :gap="4"><h2 class="section-title">达标判断 · 执行详情</h2><span v-if="selectedDecisionAttempt" class="text-xs text-muted">{{ dateLabel(selectedDecisionAttempt.started_at) }}</span></Column><v-btn icon="$close" aria-label="关闭达标判定详情" variant="text" @click="decisionDetailOpen=false" /></Row>
    <v-chip v-if="selectedDecisionAttempt" class="self-start" size="small" :color="selectedDecisionAttempt.status==='succeeded'?'success':selectedDecisionAttempt.status==='failed'?'error':selectedDecisionAttempt.status==='running'?'primary':'secondary'">{{ decisionAttemptStatus(selectedDecisionAttempt) }}</v-chip>
    <v-alert v-if="selectedDecisionAttempt?.error" type="error" density="compact">{{ selectedDecisionAttempt.error }}</v-alert>
    <p v-if="!selectedDecisionAttempt&&selectedDecisionFlow&&detailLoadingByWorkflow[selectedDecisionFlow.id]&&!detailErrors[selectedDecisionFlow.id]" class="text-sm text-muted">正在读取判定执行记录…</p>
    <p v-else-if="!selectedDecisionAttempt&&selectedDecisionFlow&&detailErrors[selectedDecisionFlow.id]" class="text-sm text-danger">读取失败：{{ detailErrors[selectedDecisionFlow.id] }}</p>
    <p v-else-if="!selectedDecisionAttempt" class="text-sm text-muted">暂无达标判断执行记录。</p>
    <Column v-else class="max-h-480px overflow-y-auto" :gap="4">
     <section v-if="selectedDecisionFlow&&decisionScores(selectedDecisionAttempt).length" class="surface-panel p-8"><h3 class="px-8 py-4 text-sm font-semibold">模型评分</h3><v-table density="compact"><thead><tr><th scope="col">模型</th><th scope="col">得分</th><th scope="col">百分制／模型指标</th><th scope="col">门槛</th><th scope="col">评分结果</th></tr></thead><tbody><tr v-for="[modelId,score] in decisionScores(selectedDecisionAttempt)" :key="modelId"><td>{{ decisionModelName(selectedDecisionFlow,modelId) }}</td><td>{{ score.score_contract==='model_report_v1'?'原始分 ':'' }}{{ (score.score_contract==='model_report_v1'?score.raw_score:score.score)??'—' }} / {{ (score.score_contract==='model_report_v1'?score.full_score:score.max_score)??'—' }}{{ score.veto_triggered===true?' · 否决':'' }}</td><td>{{ decisionPercent(score.percentage) }}</td><td>{{ typeof score.threshold==='number'?`低于 ${score.threshold}%`:'—' }}</td><td><v-chip size="small" :color="score.status==='passed'?'success':score.status==='not_passed'?'warning':score.status==='invalid'?'error':'secondary'">{{ ({passed:'达标',not_passed:'未达标',pending:'待定',invalid:'无效'} as Record<string,string>)[score.status??'']??'未知' }}</v-chip></td></tr></tbody></v-table></section>
     <p class="text-sm text-muted">{{ (selectedDecisionAttempt.result as {reasons?:string[]}|null)?.reasons?.join('；') || '请核对各模型评分与分数上限。' }}</p>
    </Column>
   </Column>
  </v-dialog>
  <Row x="between" wrap y="center" :gap="8">
   <span class="text-xs text-muted">第 {{ page }} / {{ pageCount }} 页</span>
   <v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="题目记录分页" />
  </Row>
 </Column>
</template>
