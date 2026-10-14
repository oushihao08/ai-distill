<!--
职责：以宽屏弹窗查看一道达标题目的脱敏附件全文、题目包、模型作答和评分原文。
关键方法与用法：接收工作流 ID 与标题，按需读取工作流详情及脱敏附件正文，关闭时发出 `close`。
-->

<script setup lang="ts">
import { api } from '../api/client';
import type { Material, WorkflowDetail } from '../types/api';
import StepResultTable from './StepResultTable.vue';

interface ModelResult { model_id:string; name:string; attempt_id?:string|null; status:string; answer?:string|null }
interface ScoreResult { model_id:string; name:string; answer_attempt_id?:string|null; answer_status:string; score_attempt_id?:string|null; score_status:string; score?:number|null; max_score?:number|null; valid?:boolean|null; disputes?:unknown[];score_contract?:'model_report_v1';raw_score?:number|null;full_score?:number|null;evaluation_percent?:number|null;veto_triggered?:boolean|null }
interface AcceptanceResult { model_scores?:Record<string,{status:string;score?:number;max_score?:number;percentage?:number;threshold:number}> }
interface RedactedText { material:Material; redaction_status:'redacted'; redacted_text:string; redacted_pages?:{page:number;text:string}[] }
const props=defineProps<{workflowId:string;title:string;acceptanceResult?:AcceptanceResult|null}>();
const emit=defineEmits<{close:[]}>();
const open=shallowRef(true);
const detail=shallowRef<WorkflowDetail>();
const loading=shallowRef(false);
const error=shallowRef('');
const tab=shallowRef<'attachments'|'question'|'answers'|'scores'>('question');
const selectedMaterialId=shallowRef('');
const selectedModelId=shallowRef('');
const attachment=shallowRef<RedactedText>();
const attachmentBusy=shallowRef(false);
const attachmentError=shallowRef('');
const steps=computed(()=>detail.value?.steps??[]);
const materials=computed(()=>detail.value?.materials??[]);
const questionStep=computed(()=>steps.value.find(step=>step.ordinal===4));
const question=computed(()=>questionStep.value?.result??{});
const answerModels=computed(()=>Array.isArray(steps.value.find(step=>step.ordinal===5)?.result?.models)?steps.value.find(step=>step.ordinal===5)!.result!.models as ModelResult[]:[]);
const scoreModels=computed(()=>Array.isArray(steps.value.find(step=>step.ordinal===6)?.result?.models)?steps.value.find(step=>step.ordinal===6)!.result!.models as ScoreResult[]:[]);
const attempts=computed(()=>detail.value?.attempts??[]);
const currentAnswer=computed(()=>answerModels.value.find(model=>model.model_id===selectedModelId.value)??answerModels.value[0]);
const currentAnswerAttempt=computed(()=>attempts.value.find(item=>item.id===currentAnswer.value?.attempt_id));
const currentAnswerText=computed(()=>{
 const result=currentAnswerAttempt.value?.result as {text?:unknown}|null;
 return typeof result?.text==='string'?result.text:currentAnswer.value?.answer??'';
});
const scoreByModel=computed(()=>scoreModels.value.find(model=>model.model_id===selectedModelId.value)??scoreModels.value[0]);
const currentScoreAttempt=computed(()=>attempts.value.find(item=>item.id===scoreByModel.value?.score_attempt_id));
const scoreResult=computed(()=>currentScoreAttempt.value?.result as {raw_text?:unknown;report?:unknown;validation?:unknown}|null);
const scoreText=computed(()=>typeof scoreResult.value?.raw_text==='string'?scoreResult.value.raw_text:scoreResult.value?.report?JSON.stringify(scoreResult.value.report,null,2):currentScoreAttempt.value?.error??'尚无评分文本。');
const questionSections=computed(()=>[
 {label:'题面',value:question.value.question},
 {label:'作答思路',value:question.value.answer_approach},
 {label:'参考答案',value:question.value.reference_answer},
 {label:'评分标准',value:question.value.rubric},
 {label:'作答要求',value:question.value.answer_requirements},
].filter(item=>item.value!==undefined&&item.value!==null&&item.value!==''));
function decisionLabel(modelId:string){return props.acceptanceResult?.model_scores?.[modelId]?.status??'缺少判定明细';}
watch(()=>props.workflowId,async(workflowId,_previous,onCleanup)=>{
 const controller=new AbortController();onCleanup(()=>controller.abort());
 try{loading.value=true;error.value='';detail.value=await api<WorkflowDetail>(`/workflows/${workflowId}`,{signal:controller.signal});selectedMaterialId.value=materials.value[0]?.id??'';selectedModelId.value=answerModels.value[0]?.model_id??scoreModels.value[0]?.model_id??'';}
 catch(cause){if(!controller.signal.aborted)error.value=cause instanceof Error?cause.message:'读取题目详情失败';}
 finally{if(!controller.signal.aborted)loading.value=false;}
},{immediate:true});
watch([tab,selectedMaterialId],async([activeTab,materialId],_old,onCleanup)=>{
 if(activeTab!=='attachments'||!materialId)return;
 const controller=new AbortController();onCleanup(()=>controller.abort());
 try{attachmentBusy.value=true;attachmentError.value='';attachment.value=await api<RedactedText>(`/workflows/${props.workflowId}/materials/${materialId}/extracted-text?redacted_only=true`,{signal:controller.signal});}
 catch(cause){if(!controller.signal.aborted)attachmentError.value=cause instanceof Error?cause.message:'读取脱敏附件全文失败';}
 finally{if(!controller.signal.aborted)attachmentBusy.value=false;}
},{immediate:true});
watch(open,value=>{if(!value)emit('close');});
</script>

<template>
 <v-dialog v-model="open" max-width="1440" width="94vw" scrollable>
  <v-card class="surface-card max-h-[90vh] overflow-hidden">
   <v-card-title class="p-20 pb-8"><Row x="between" wrap y="center" :gap="12"><Column :gap="4" class="min-w-0"><h2 class="section-title">{{ title }}</h2><span class="text-xs text-muted">达标题目 · 题面、答案和评分均为本题当前记录</span></Column><v-btn icon="$close" variant="text" aria-label="关闭达标题目详情" @click="open=false" /></Row></v-card-title>
   <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
    <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
    <p v-else-if="loading&&!detail" class="text-sm text-muted">正在读取题目内容…</p>
    <template v-else-if="detail">
     <v-tabs v-model="tab" color="primary" density="compact" class="mb-12"><v-tab value="attachments">附件全文</v-tab><v-tab value="question">完整题目</v-tab><v-tab value="answers">模型作答</v-tab><v-tab value="scores">评分</v-tab></v-tabs>
     <Column v-if="tab==='attachments'" class="min-w-0" :gap="12">
      <v-alert type="info" density="compact">仅展示当前附件的脱敏全文；未完成脱敏或没有可用脱敏正文时不会回退显示原始提取文本。</v-alert>
      <v-select v-model="selectedMaterialId" :items="materials" item-title="original_name" item-value="id" label="选择附件" hide-details />
      <v-alert v-if="attachmentError" type="error" density="compact">{{ attachmentError }}</v-alert>
      <p v-else-if="attachmentBusy" class="text-sm text-muted">正在读取脱敏全文…</p>
      <p v-else-if="!materials.length" class="text-sm text-muted">此题目没有当前附件。</p>
      <Column v-else-if="attachment" class="surface-panel max-h-[62vh] overflow-y-auto p-16" :gap="12"><span class="text-xs text-muted">{{ attachment.material.original_name }} · 已脱敏</span><pre class="whitespace-pre-wrap break-words font-sans text-sm leading-24">{{ attachment.redacted_text }}</pre></Column>
     </Column>
     <Column v-else-if="tab==='question'" class="surface-panel max-h-[68vh] overflow-y-auto p-16" :gap="16">
      <Column v-for="section in questionSections" :key="section.label" :gap="8"><h3 class="text-sm font-semibold">{{ section.label }}</h3><pre v-if="typeof section.value==='string'" class="whitespace-pre-wrap break-words font-sans text-sm leading-24">{{ section.value }}</pre><StepResultTable v-else-if="section.value" :value="section.value" /></Column>
      <p v-if="!questionSections.length" class="text-sm text-muted">当前没有已保存的完整题目包。</p>
     </Column>
     <Column v-else-if="tab==='answers'" :gap="12">
      <v-select v-model="selectedModelId" :items="answerModels" item-title="name" item-value="model_id" label="作答模型" hide-details />
      <v-chip v-if="currentAnswer" :color="currentAnswer.status==='succeeded'?'success':'warning'">{{ currentAnswer.name }} · {{ currentAnswer.status }}</v-chip>
      <Column v-if="currentAnswerText" class="surface-panel max-h-[62vh] overflow-y-auto p-16"><pre class="whitespace-pre-wrap break-words font-sans text-sm leading-24">{{ currentAnswerText }}</pre></Column>
      <p v-else class="text-sm text-muted">此模型没有保存成功的作答文本。</p>
     </Column>
     <Column v-else :gap="12">
      <v-select v-model="selectedModelId" :items="scoreModels" item-title="name" item-value="model_id" label="作答模型评分" hide-details />
      <Row v-if="scoreByModel" wrap :gap="8"><v-chip :color="decisionLabel(scoreByModel.model_id)==='passed'?'success':decisionLabel(scoreByModel.model_id)==='not_passed'?'error':'warning'">达标判定：{{ decisionLabel(scoreByModel.model_id) }}</v-chip><v-chip v-if="scoreByModel.score_contract==='model_report_v1'">原始分 {{ scoreByModel.raw_score??'—' }} / {{ scoreByModel.full_score??'—' }} · 模型指标 {{ scoreByModel.evaluation_percent??'—' }}% · 否决 {{ scoreByModel.veto_triggered===true?'是':scoreByModel.veto_triggered===false?'否':'未报告' }}</v-chip><v-chip v-else>{{ scoreByModel.score??'—' }} / {{ scoreByModel.max_score??'—' }}</v-chip><v-chip>评分 {{ scoreByModel.score_status }} · {{ scoreByModel.valid===true?'有效':scoreByModel.valid===false?'无效':'待核' }}</v-chip></Row>
      <Column v-if="scoreByModel" class="surface-panel max-h-[58vh] overflow-y-auto p-16" :gap="12"><span class="text-xs text-muted">模型返回的评分文本</span><pre class="whitespace-pre-wrap break-words font-sans text-sm leading-24">{{ scoreText }}</pre><StepResultTable v-if="scoreResult?.validation" :value="scoreResult.validation as Record<string,unknown>" /></Column>
      <p v-else class="text-sm text-muted">当前没有评分结果。</p>
     </Column>
    </template>
   </v-card-text>
  </v-card>
 </v-dialog>
</template>
