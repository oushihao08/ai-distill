<!--
职责：以宽屏弹窗查看一道题目的脱敏附件全文、题目包、模型作答和评分原文。
关键方法与用法：接收工作流 ID 与标题，按需读取工作流详情及脱敏附件正文，关闭时发出 `close`。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel, numberedRubric } from '../utils/format';
import { statusLabels, type Material, type WorkflowDetail } from '../types/api';
import StepResultTable from './StepResultTable.vue';

interface RedactedText { material:Material; redaction_status:'redacted'; redacted_text:string; redacted_pages?:{page:number;text:string}[] }
const props=withDefaults(defineProps<{workflowId:string;title:string;detailLabel?:string}>(),{detailLabel:'题目详情'});
const emit=defineEmits<{close:[]}>();
const open=shallowRef(true);
const detail=shallowRef<WorkflowDetail>();
const loading=shallowRef(false);
const error=shallowRef('');
const tab=shallowRef<'basic'|'attachments'|'question'|'other'>('basic');
const selectedMaterialId=shallowRef('');
const attachment=shallowRef<RedactedText>();
const attachmentBusy=shallowRef(false);
const attachmentError=shallowRef('');
const steps=computed(()=>detail.value?.steps??[]);
const materials=computed(()=>detail.value?.materials??[]);
const questionStep=computed(()=>steps.value.find(step=>step.ordinal===4));
const question=computed(()=>questionStep.value?.result??{});
const attempts=computed(()=>detail.value?.attempts??[]);
const executionHistory=computed(()=>attempts.value
 .filter(item=>[4,8].includes(item.ordinal))
 .sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at)));
const questionSections=computed(()=>[
 {label:'表头',value:question.value.header??'尚未保存'},
 {label:'任务名称',value:question.value.task_name||'尚未保存'},
 {label:'任务类型',value:question.value.task_type||'尚未保存'},
 {label:'prompt',value:question.value.question||'尚未保存'},
 {label:'考点 rubric',value:(detail.value?.project.parent_name==='豆包高经济价值'?numberedRubric(question.value.rubric):question.value.rubric)??'尚未保存'},
 {label:'作答思路',value:question.value.answer_approach||'尚未保存'},
 {label:'标准答案-文本',value:question.value.reference_answer||'尚未保存'},
]);
const primaryQuestionFields=new Set(['header','task_name','task_type','question','rubric','answer_approach','reference_answer']);
const otherQuestionInformation=computed(()=>Object.fromEntries(
 Object.entries(question.value).filter(([key,value])=>!primaryQuestionFields.has(key)&&value!==undefined&&value!==null&&value!==''),
));
const stepNames:Record<number,string>={4:'出题',8:'交付归档'};
function durationLabel(startedAt:string,finishedAt:string|null){
 if(!finishedAt)return '进行中';
 const seconds=Math.max(0,Math.round((Date.parse(finishedAt)-Date.parse(startedAt))/1000));
 if(seconds<60)return `${seconds} 秒`;
 const minutes=Math.floor(seconds/60),remaining=seconds%60;
 return `${minutes} 分 ${remaining} 秒`;
}
watch(()=>props.workflowId,async(workflowId,_previous,onCleanup)=>{
 const controller=new AbortController();onCleanup(()=>controller.abort());
 try{loading.value=true;error.value='';detail.value=await api<WorkflowDetail>(`/workflows/${workflowId}`,{signal:controller.signal});selectedMaterialId.value=materials.value[0]?.id??'';}
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
   <v-card-title class="p-20 pb-8"><Row x="between" wrap y="center" :gap="12"><Column :gap="4" class="min-w-0"><h2 class="section-title">{{ title }}</h2><span class="text-xs text-muted">{{ detailLabel }} · 题面、考点、标答与附件为本题当前记录</span></Column><v-btn icon="$close" variant="text" aria-label="关闭题目详情" @click="open=false" /></Row></v-card-title>
   <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
    <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
    <p v-else-if="loading&&!detail" class="text-sm text-muted">正在读取题目内容…</p>
    <template v-else-if="detail">
     <v-tabs v-model="tab" color="primary" density="compact" class="mb-12"><v-tab value="basic">基础信息</v-tab><v-tab value="attachments">附件全文</v-tab><v-tab value="question">完整题目</v-tab><v-tab value="other">其他信息</v-tab></v-tabs>
     <Column v-if="tab==='basic'" class="max-h-[68vh] overflow-y-auto" :gap="16">
      <section class="surface-panel p-16">
       <h3 class="mb-12 text-sm font-semibold">当前记录</h3>
       <v-table density="compact"><tbody><tr><th scope="row">工作流</th><td class="font-mono text-xs break-all">{{ detail.workflow.id }}</td></tr><tr><th scope="row">记录名称</th><td>{{ detail.workflow.title }}</td></tr><tr><th scope="row">任务名称</th><td>{{ question.task_name||'尚未保存' }}</td></tr><tr><th scope="row">题目版本</th><td class="font-mono text-xs break-all">{{ question.question_version||'尚未保存' }}</td></tr><tr><th scope="row">评分标准版本</th><td class="font-mono text-xs break-all">{{ question.rubric_version||'尚未保存' }}</td></tr></tbody></v-table>
      </section>
      <section class="surface-panel p-16">
       <h3 class="mb-4 text-sm font-semibold">出题与交付记录</h3>
       <p class="mb-12 text-xs text-muted">按开始时间倒序展示出题与交付归档执行记录。</p>
       <div class="overflow-x-auto"><v-table density="compact" class="min-w-920px"><thead><tr><th scope="col">阶段</th><th scope="col">任务 ID</th><th scope="col">状态</th><th scope="col">开始时间</th><th scope="col">结束时间</th><th scope="col">耗时</th><th scope="col">失败原因</th></tr></thead><tbody><tr v-for="attempt in executionHistory" :key="attempt.id"><td class="whitespace-nowrap">{{ stepNames[attempt.ordinal]??`步骤 ${attempt.ordinal}` }}</td><td class="max-w-220px break-all font-mono text-xs">{{ attempt.id }}</td><td class="whitespace-nowrap">{{ statusLabels[attempt.status] }}</td><td class="whitespace-nowrap text-xs">{{ dateLabel(attempt.started_at) }}</td><td class="whitespace-nowrap text-xs">{{ attempt.finished_at?dateLabel(attempt.finished_at):'尚未结束' }}</td><td class="whitespace-nowrap text-xs tabular-nums">{{ durationLabel(attempt.started_at,attempt.finished_at) }}</td><td class="max-w-280px break-words text-xs">{{ attempt.error||'—' }}</td></tr><tr v-if="!executionHistory.length"><td colspan="7" class="text-muted">暂无出题或交付执行记录。</td></tr></tbody></v-table></div>
      </section>
     </Column>
     <Column v-else-if="tab==='attachments'" class="min-w-0" :gap="12">
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
     <Column v-else-if="tab==='other'" class="surface-panel max-h-[68vh] overflow-y-auto p-16" :gap="12">
      <StepResultTable v-if="Object.keys(otherQuestionInformation).length" :value="otherQuestionInformation" />
      <p v-else class="text-sm text-muted">当前题目没有其他已保存信息。</p>
     </Column>
    </template>
   </v-card-text>
  </v-card>
 </v-dialog>
</template>
