<!--
职责：展示项目题目清单、当前步骤状态、详情页同款单题步骤操作和分页导航，供项目详情页面直接复用。
关键方法与用法：接收 `workflows` 列表并读取题目详情；`actionsFor()` 按详情页条件生成单题步骤按钮，`runAction()` 调用对应工作流接口。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel } from '../utils/format';
import { stages, statusLabels, type Attempt, type Workflow, type WorkflowDetail } from '../types/api';

const props=defineProps<{workflows:Workflow[]}>();
const emit=defineEmits<{refresh:[]}>();
const search=shallowRef('');
const page=shallowRef(1);
const pageSize=10;
const details=shallowRef<Record<string,WorkflowDetail>>({});
const detailErrors=shallowRef<Record<string,string>>({});
const detailLoadingByWorkflow=shallowRef<Record<string,boolean>>({});
const runningAction=shallowRef<string|null>(null);
const actionMessages=shallowRef<Record<string,string>>({});
const decisionDetailOpen=shallowRef(false);
const selectedDecisionFlow=shallowRef<Workflow|null>(null);
const selectedDecisionAttempt=computed(()=>selectedDecisionFlow.value?latestDecisionAttempt(selectedDecisionFlow.value):null);
const expandedDecisionSections=shallowRef<string[]>(['result']);
const copiedDecisionField=shallowRef('');
const decisionCopyError=shallowRef('');
const activeWorkflows=computed(()=>props.workflows.filter(flow=>flow.publication_status!=='succeeded'));
const filteredWorkflows=computed(()=>activeWorkflows.value.filter(flow=>flow.title.toLowerCase().includes(search.value.trim().toLowerCase())));
const pageCount=computed(()=>Math.max(1,Math.ceil(filteredWorkflows.value.length/pageSize)));
const visibleWorkflows=computed(()=>filteredWorkflows.value.slice((page.value-1)*pageSize,page.value*pageSize));
function currentStage(flow:Workflow){return stages[(flow.current_ordinal??1)-1]??'状态未知';}
function currentState(flow:Workflow){
 if(flow.current_ordinal===6&&flow.current_decision==='repair')return '需要返修';
 return flow.current_status?statusLabels[flow.current_status]:'已完成';
}
function stateColor(flow:Workflow){
 const state=currentState(flow);
 return state==='失败'?'error':state==='执行中'?'primary':state==='需要返修'?'warning':state==='成功'||state==='已完成'?'success':'secondary';
}
function nextAction(flow:Workflow){
 const state=currentState(flow);
 if(state==='失败')return '查看失败原因，再按提示重试或修正';
 if(state==='执行中')return '任务正在执行，查看当前进度';
 if(state==='需要返修')return '查看返修原因，再启动返修';
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
    for(let start=0;start<props.workflows.length;start+=4){
     const batch=props.workflows.slice(start,start+4);
     detailLoadingByWorkflow.value={...detailLoadingByWorkflow.value,...Object.fromEntries(batch.map(flow=>[flow.id,true]))};
     const errors={...detailErrors.value};batch.forEach(flow=>delete errors[flow.id]);detailErrors.value=errors;
     await Promise.all(batch.map(async flow=>{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),15_000);
      try{
       const detail=await api<WorkflowDetail>(`/workflows/${flow.id}`,{signal:controller.signal});
       details.value={...details.value,[flow.id]:detail};
       const errors={...detailErrors.value};delete errors[flow.id];detailErrors.value=errors;
      }catch(cause){detailErrors.value={...detailErrors.value,[flow.id]:controller.signal.aborted?'读取题目步骤状态超时，请刷新重试':cause instanceof Error?cause.message:'读取步骤状态失败'};}
      finally{clearTimeout(timeout);detailLoadingByWorkflow.value={...detailLoadingByWorkflow.value,[flow.id]:false};}
     }));
    }
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
 const active=(ordinals:number[])=>detail.attempts.some(attempt=>ordinals.includes(attempt.ordinal)&&['waiting','running'].includes(attempt.status));
 const hasAuthored=detail.attempts.some(attempt=>attempt.ordinal===4&&attempt.status==='succeeded');
 const answerStep=detail.steps.find(step=>step.ordinal===5);
 const models=answerStep?.result?.models;
 const answerReady=answerStep?.status==='succeeded'||(Array.isArray(models)&&models.length>0&&models.every((model:any)=>['succeeded','failed','skipped'].includes(model?.status))&&models.some((model:any)=>model?.status==='succeeded'&&typeof model.attempt_id==='string'));
 const decision=detail.steps.find(step=>step.ordinal===7)?.result?.decision;
 const actions:RowAction[]=[];
 if(status(1)!=='succeeded')actions.push({ordinal:1,path:'/intake',label:'入库',disabled:active([1,2])});
 actions.push({ordinal:9,path:'/redact',label:'脱敏',disabled:status(1)!=='succeeded'||status(9)==='succeeded'||active([9])});
 actions.push({ordinal:4,path:'/author',label:hasAuthored?'重新生成题目':'生成题目',disabled:status(9)!=='succeeded'||active([4])});
 actions.push({ordinal:5,path:'/answer',label:'模型作答',disabled:status(4)!=='succeeded'||active([5])});
 actions.push({ordinal:6,path:'/score',label:'独立评分',disabled:!answerReady||active([6])});
 actions.push({ordinal:8,path:'/publish',label:'归档题目',disabled:status(7)!=='succeeded'||decision!=='accepted'||status(8)==='succeeded'});
 return actions;
}
function latestDecisionAttempt(flow:Workflow){const attempts=details.value[flow.id]?.attempts.filter(attempt=>attempt.ordinal===7)??[];return [...attempts].sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at))[0]??null;}
function decisionScores(attempt:Attempt|null){
 const result=attempt?.result;
 if(!result||typeof result!=='object'||!('model_scores'in result)||!result.model_scores||typeof result.model_scores!=='object')return [];
 return Object.entries(result.model_scores as Record<string,{status?:string;score?:number;max_score?:number;percentage?:number;threshold?:number}>);
}
function decisionModelName(flow:Workflow,modelId:string){
 const models=details.value[flow.id]?.steps.find(step=>step.ordinal===5)?.result?.models;
 if(!Array.isArray(models))return modelId;
 const model=models.find((item:any)=>item?.model_id===modelId);
 return typeof model?.name==='string'&&model.name?model.name:modelId;
}
function decisionPercent(value:number|undefined){return typeof value==='number'?`${Number(value.toFixed(1))}%`:'—';}
function showDecisionDetail(flow:Workflow){selectedDecisionFlow.value=flow;expandedDecisionSections.value=['result'];copiedDecisionField.value='';decisionCopyError.value='';decisionDetailOpen.value=true;}
function decisionAttemptStatus(attempt:Attempt){const result=attempt.result;if(attempt.ordinal===7&&result&&typeof result==='object'&&'decision'in result){const decision=String((result as {decision?:unknown}).decision??'');return ({accepted:'达标',repair:'需要返修',waiting:'等待判定条件',quarantine:'隔离'} as Record<string,string>)[decision]??statusLabels[attempt.status];}return statusLabels[attempt.status];}
function decisionJson(value:unknown){return value==null?'暂无内容':JSON.stringify(value,null,2)??'暂无内容';}
function toggleDecisionSection(section:string){expandedDecisionSections.value=expandedDecisionSections.value.includes(section)?expandedDecisionSections.value.filter(item=>item!==section):[...expandedDecisionSections.value,section];}
async function copyDecisionField(label:string,value:unknown){
 try{await navigator.clipboard.writeText(decisionJson(value));copiedDecisionField.value=label;decisionCopyError.value='';window.setTimeout(()=>{if(copiedDecisionField.value===label)copiedDecisionField.value='';},1800);}
 catch(cause){decisionCopyError.value=cause instanceof Error?`复制${label}失败：${cause.message}`:`复制${label}失败，请检查浏览器剪贴板权限`;}
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
  await refreshDetails();
 }catch(cause){actionMessages.value={...actionMessages.value,[flow.id]:cause instanceof Error?cause.message:`${action.label}提交失败`};}
 finally{runningAction.value=null;}
}
onMounted(refreshDetails);
watch(()=>props.workflows.map(flow=>`${flow.id}:${flow.current_ordinal}:${flow.current_status}`).join('|'),()=>{void refreshDetails();});
watch(search,()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
</script>

<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap :gap="12">
   <Column :gap="4"><h2 class="section-title">题目记录</h2><span class="text-xs text-muted">共 {{ filteredWorkflows.length }} 道题 · 每页 {{ pageSize }} 道</span></Column>
   <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索题目" hide-details clearable class="filter-field-compact" />
  </Row>
  <p v-if="!visibleWorkflows.length" class="text-sm text-muted">{{ !props.workflows.length?'暂无题目。将PDF放入材料目录下的题目子文件夹，再同步目录。':activeWorkflows.length?'没有符合条件的题目':'当前题目均已归档，可在“达标题目”中查看。' }}</p>
  <Column v-else class="w-full overflow-x-auto">
   <v-table density="comfortable" class="min-w-900px">
    <thead><tr><th scope="col">题目</th><th scope="col">材料数</th><th scope="col">当前步骤与状态</th><th scope="col">步骤操作</th></tr></thead>
    <tbody>
     <tr v-for="flow in visibleWorkflows" :key="flow.id">
      <td class="min-w-240px"><RouterLink :to="`/workflows/${flow.id}`" class="link-text font-medium break-words">{{ flow.title }}</RouterLink></td>
      <td class="whitespace-nowrap">{{ flow.material_count || flow.source_manifest?.length || 0 }} 份</td>
      <td class="min-w-220px"><Row wrap :gap="4"><span class="text-sm font-medium">{{ currentStage(flow) }}</span><v-btn v-if="flow.current_ordinal===6" size="small" density="compact" variant="text" color="primary" @click="showDecisionDetail(flow)">查看执行详情</v-btn><v-chip size="small" :color="stateColor(flow)">{{ currentState(flow) }}</v-chip></Row></td>
      <td class="min-w-320px"><Column :gap="4"><Row wrap :gap="4"><v-btn v-for="action in actionsFor(flow)" :key="action.ordinal" size="small" density="compact" color="primary" variant="text" :loading="runningAction===`${flow.id}:${action.ordinal}`" :disabled="action.disabled||runningAction!==null||detailLoadingByWorkflow[flow.id]" @click="runAction(flow,action)">{{ action.label }}</v-btn></Row><span v-if="detailLoadingByWorkflow[flow.id]&&!details[flow.id]&&!detailErrors[flow.id]" class="text-sm text-muted">正在读取可用操作…</span><span v-else-if="detailErrors[flow.id]" class="text-sm text-danger">步骤状态读取失败：{{ detailErrors[flow.id] }}</span><span v-if="actionMessages[flow.id]" class="text-xs text-muted">{{ actionMessages[flow.id] }}</span><span v-else-if="actionMessages.refresh" class="text-xs text-danger">{{ actionMessages.refresh }}</span><span v-if="!actionsFor(flow).length&&!detailLoadingByWorkflow[flow.id]&&!detailErrors[flow.id]&&currentState(flow)!=='需要返修'" class="text-sm text-muted">{{ nextAction(flow) }}</span></Column></td>
     </tr>
    </tbody>
   </v-table>
  </Column>
  <v-dialog v-model="decisionDetailOpen" max-width="960" scrollable>
   <Column class="surface-card p-16" :gap="12">
    <Row x="between" y="center" :gap="12"><Column :gap="4"><h2 class="section-title">达标或返修 · 执行详情</h2><span v-if="selectedDecisionAttempt" class="text-xs text-muted">{{ dateLabel(selectedDecisionAttempt.started_at) }}</span></Column><v-btn icon="$close" aria-label="关闭达标判定详情" variant="text" @click="decisionDetailOpen=false" /></Row>
    <v-chip v-if="selectedDecisionAttempt" class="self-start" size="small" :color="selectedDecisionAttempt.status==='succeeded'?'success':selectedDecisionAttempt.status==='failed'?'error':selectedDecisionAttempt.status==='running'?'primary':'secondary'">{{ decisionAttemptStatus(selectedDecisionAttempt) }}</v-chip>
    <v-alert v-if="selectedDecisionAttempt?.error" type="error" density="compact">{{ selectedDecisionAttempt.error }}</v-alert>
    <v-alert v-if="decisionCopyError" type="error" density="compact" closable @click:close="decisionCopyError=''">{{ decisionCopyError }}</v-alert>
    <p v-if="!selectedDecisionAttempt&&selectedDecisionFlow&&detailLoadingByWorkflow[selectedDecisionFlow.id]&&!detailErrors[selectedDecisionFlow.id]" class="text-sm text-muted">正在读取判定执行记录…</p>
    <p v-else-if="!selectedDecisionAttempt&&selectedDecisionFlow&&detailErrors[selectedDecisionFlow.id]" class="text-sm text-danger">读取失败：{{ detailErrors[selectedDecisionFlow.id] }}</p>
    <p v-else-if="!selectedDecisionAttempt" class="text-sm text-muted">暂无达标或返修执行记录。</p>
    <Column v-else class="max-h-480px overflow-y-auto" :gap="4">
     <section v-if="selectedDecisionFlow&&decisionScores(selectedDecisionAttempt).length" class="surface-panel p-8"><h3 class="px-8 py-4 text-sm font-semibold">模型评分</h3><v-table density="compact"><thead><tr><th scope="col">模型</th><th scope="col">得分</th><th scope="col">百分制</th><th scope="col">门槛</th><th scope="col">评分结果</th></tr></thead><tbody><tr v-for="[modelId,score] in decisionScores(selectedDecisionAttempt)" :key="modelId"><td>{{ decisionModelName(selectedDecisionFlow,modelId) }}</td><td>{{ score.score??'—' }} / {{ score.max_score??'—' }}</td><td>{{ decisionPercent(score.percentage) }}</td><td>{{ typeof score.threshold==='number'?`低于 ${score.threshold}%`:'—' }}</td><td><v-chip size="small" :color="score.status==='passed'?'success':score.status==='not_passed'?'warning':score.status==='invalid'?'error':'secondary'">{{ ({passed:'达标',not_passed:'未达标',pending:'待定',invalid:'无效'} as Record<string,string>)[score.status??'']??'未知' }}</v-chip></td></tr></tbody></v-table></section>
     <section class="surface-panel overflow-hidden"><Row x="between" y="center" class="min-h-36px px-8"><v-btn size="small" variant="text" @click="toggleDecisionSection('result')">{{ expandedDecisionSections.includes('result')?'收起':'展开' }} · 结果 / 输出</v-btn><v-btn size="small" variant="text" @click="copyDecisionField('结果',selectedDecisionAttempt?.result)">{{ copiedDecisionField==='结果'?'已复制':'复制' }}</v-btn></Row><pre v-if="expandedDecisionSections.includes('result')" class="border-t border-subtle p-8 text-xs whitespace-pre-wrap break-all">{{ decisionJson(selectedDecisionAttempt.result) }}</pre></section>
     <section class="surface-panel overflow-hidden"><Row x="between" y="center" class="min-h-36px px-8"><v-btn size="small" variant="text" @click="toggleDecisionSection('input')">{{ expandedDecisionSections.includes('input')?'收起':'展开' }} · 输入</v-btn><v-btn size="small" variant="text" @click="copyDecisionField('输入',selectedDecisionAttempt?.input)">{{ copiedDecisionField==='输入'?'已复制':'复制' }}</v-btn></Row><pre v-if="expandedDecisionSections.includes('input')" class="border-t border-subtle p-8 text-xs whitespace-pre-wrap break-all">{{ decisionJson(selectedDecisionAttempt.input) }}</pre></section>
     <section v-if="selectedDecisionAttempt.config" class="surface-panel overflow-hidden"><Row x="between" y="center" class="min-h-36px px-8"><v-btn size="small" variant="text" @click="toggleDecisionSection('config')">{{ expandedDecisionSections.includes('config')?'收起':'展开' }} · 配置</v-btn><v-btn size="small" variant="text" @click="copyDecisionField('配置',selectedDecisionAttempt?.config)">{{ copiedDecisionField==='配置'?'已复制':'复制' }}</v-btn></Row><pre v-if="expandedDecisionSections.includes('config')" class="border-t border-subtle p-8 text-xs whitespace-pre-wrap break-all">{{ decisionJson(selectedDecisionAttempt.config) }}</pre></section>
    </Column>
   </Column>
  </v-dialog>
  <Row x="between" wrap y="center" :gap="8">
   <span class="text-xs text-muted">第 {{ page }} / {{ pageCount }} 页</span>
   <v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="题目记录分页" />
  </Row>
 </Column>
</template>
