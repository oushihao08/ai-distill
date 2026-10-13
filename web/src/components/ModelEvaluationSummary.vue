<!--
职责：展示模型作答与评分摘要，并弹窗查看各模型答案和失败评分记录。
关键方法与用法：从步骤和尝试记录关联答案及评分；工作流详情页传入本题步骤与执行记录。
-->

<script setup lang="ts">
import { computed } from 'vue';
import {readAcceptanceResult,readAnswerStepResult,readScoreStepResult,type AnswerStepModelSummary,type Attempt,type ModelAcceptance,type ScoreStepModelSummary,type Step} from '../types/api';
import { dateLabel } from '../utils/format';
import { scorePercentage } from '../../../shared/score';

type ModelAnswer=AnswerStepModelSummary&{model_id:string;name:string};
type ModelScore=ScoreStepModelSummary&{model_id:string;name:string};
interface ScoreItemCounts {fullScore:number;belowFull:number;total:number}
const props=defineProps<{steps:Step[];attempts:Attempt[]}>();
const answerDialog=shallowRef(false);const answerTab=shallowRef('');
const failedScoreDialog=shallowRef(false);const selectedFailureId=shallowRef('');
const executionDialog=shallowRef(false),selectedExecutionId=shallowRef('');
const executionAttempts=computed(()=>props.attempts.filter(item=>item.ordinal===6&&item.result!=null).sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at)));
const executionAttempt=computed(()=>executionAttempts.value.find(item=>item.id===selectedExecutionId.value));
const acceptanceResult=computed(()=>readAcceptanceResult(props.steps.find(step=>step.ordinal===7)?.result));
const scoringOriginal=computed(()=>{const result=executionAttempt.value?.result as {raw_text?:string;report?:unknown}|null;return result?.raw_text??(result?.report?JSON.stringify(result.report,null,2):executionAttempt.value?.error??'暂无评分内容');});
const executionValidationIssues=computed(()=>{const result=executionAttempt.value?.result as {validation?:{issues?:unknown}}|null;return Array.isArray(result?.validation?.issues)?result.validation.issues.filter((issue):issue is string=>typeof issue==='string'):[];});
function openExecution(id?:string|null){selectedExecutionId.value=id??executionAttempts.value[0]?.id??'';executionDialog.value=true;}
const answers=computed(()=>{
 const models=readAnswerStepResult(props.steps.find(step=>step.ordinal===5)?.result)?.models;
 return models?.filter((model):model is ModelAnswer=>typeof model.model_id==='string'&&typeof model.name==='string')??[];
});
const scores=computed(()=>{
 const models=readScoreStepResult(props.steps.find(step=>step.ordinal===6)?.result)?.models;
 return models?.filter((model):model is ModelScore=>typeof model.model_id==='string'&&typeof model.name==='string')??[];
});
const acceptance=computed(()=>{
 return acceptanceResult.value?.model_scores??{};
});
const overallDecision=computed(()=>acceptanceResult.value?.decision);
function modelDecision(answer:ModelAnswer,score:ModelScore|undefined,saved:ModelAcceptance|undefined):ModelAcceptance['status']{
 if(saved)return saved.status;
 if(answer.status!=='succeeded'||!score)return 'pending';
 if(score.score_status==='failed')return score.valid===false?'invalid':'pending';
 if(score.score_status!=='succeeded')return 'pending';
 if(score.valid!==true)return 'invalid';
 if(typeof answer.minimum_score!=='number')return 'pending';
 const percentage=scorePercentage(score.score,score.max_score);
 if(percentage===null)return 'invalid';
 return percentage<answer.minimum_score?'passed':'not_passed';
}
function scoreItemCounts(score:ModelScore|undefined):ScoreItemCounts|null{
 if(!score||score.score_status!=='succeeded'||score.valid!==true||!score.score_attempt_id)return null;
 const attempt=props.attempts.find(item=>item.id===score.score_attempt_id);
 const input=attempt?.input as {context?:{rubric?:unknown}}|null;
 const result=attempt?.result as {report?:{items?:unknown}}|null;
 const rubric=input?.context?.rubric;
 const items=result?.report?.items;
 if(!Array.isArray(rubric)||!rubric.length||!Array.isArray(items)||items.length!==rubric.length)return null;
 const maximumById=new Map<string,number>();
 for(const raw of rubric){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const item=raw as {id?:unknown;max_score?:unknown};
  if(typeof item.id!=='string'||typeof item.max_score!=='number'||!Number.isFinite(item.max_score)||item.max_score<=0||maximumById.has(item.id))return null;
  maximumById.set(item.id,item.max_score);
 }
 if(maximumById.size!==items.length)return null;
 const seen=new Set<string>();let passed=0;
 for(const raw of items){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const item=raw as {id?:unknown;score?:unknown};
  const maximum=typeof item.id==='string'?maximumById.get(item.id):undefined;
  if(typeof item.id!=='string'||seen.has(item.id)||maximum===undefined||typeof item.score!=='number'||!Number.isFinite(item.score)||item.score<0||item.score>maximum)return null;
  seen.add(item.id);
  if(item.score===maximum)passed++;
 }
 return {fullScore:passed,belowFull:items.length-passed,total:items.length};
}
const evaluations=computed(()=>answers.value.map(answer=>{
 const score=scores.value.find(item=>item.model_id===answer.model_id);
 const decision=acceptance.value[answer.model_id];
 return {answer,score,percentage:scorePercentage(score?.score,score?.max_score),itemCounts:scoreItemCounts(score),decision:decision?.status??modelDecision(answer,score,undefined)};
}));
const overallLabel=computed(()=>{
 if(overallDecision.value==='accepted')return '全部模型通过';
 if(overallDecision.value==='repair')return '未全部通过，题目未达标';
 if(overallDecision.value==='waiting')return '等待全部模型完成';
 if(overallDecision.value==='quarantine')return '题目或材料版本变化，判定已隔离';
 if(!evaluations.value.length)return '';
 if(evaluations.value.every(item=>item.decision==='passed'))return '各模型均通过，待最终判定';
 if(evaluations.value.some(item=>item.decision==='not_passed'))return '存在模型未通过，待达标判定';
 return '等待有效作答与评分';
});
const overallColor=computed(()=>overallDecision.value==='accepted'?'success':overallDecision.value==='quarantine'||overallDecision.value==='repair'||evaluations.value.some(item=>item.decision==='not_passed')?'error':'secondary');
const failedScores=computed(()=>props.attempts.filter(attempt=>attempt.ordinal===6&&attempt.status==='failed').sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at)||b.id.localeCompare(a.id)));
const selectedFailure=computed(()=>failedScores.value.find(attempt=>attempt.id===selectedFailureId.value)??failedScores.value[0]);
function openAnswers(){answerTab.value=answers.value[0]?.model_id||answers.value[0]?.attempt_id||'';answerDialog.value=true;}
function openFailedScores(){selectedFailureId.value=failedScores.value[0]?.id??'';failedScoreDialog.value=true;}
function failedModelName(attempt:Attempt){
 const input=attempt.input as {context?:{binding?:{answer_attempt_id?:string}}}|null;
 const answerAttempt=props.attempts.find(item=>item.id===input?.context?.binding?.answer_attempt_id);
 const result=answerAttempt?.result as {model_name?:string;model_id?:string}|null;
 return result?.model_name||result?.model_id||'未知作答模型';
}
function failedText(attempt:Attempt){
 const result=attempt.result as {report?:{disputes?:unknown;failure_reason?:unknown}|string}|null;
 const report=result?.report;
 if(typeof report==='string'&&report.trim())return report;
 if(report&&typeof report==='object'){
  if(typeof report.failure_reason==='string'&&report.failure_reason.trim())return report.failure_reason;
  if(Array.isArray(report.disputes)){
   const reasons=report.disputes.filter((item):item is string=>typeof item==='string'&&!!item.trim());
   if(reasons.length)return reasons.join('\n');
  }
 }
 return attempt.error || '没有保存失败原因文本。';
}
// 作答／评分执行成功只表示任务已完成；模型是否通过由百分制分数和上限单独判定。
function evaluationLabel(status:ModelAcceptance['status']){
 if(status==='passed')return '模型通过';
 if(status==='not_passed')return '模型未通过';
 if(status==='invalid')return '评分无效';
 return '等待有效评分';
}
function evaluationColor(status:ModelAcceptance['status']){
 return status==='passed'?'success':status==='not_passed'||status==='invalid'?'error':'secondary';
}
function taskStatus(status:string){
 if(status==='succeeded')return '任务已完成';
 if(status==='failed')return '任务执行失败';
 if(status==='running')return '任务执行中';
 if(status==='skipped')return '任务已跳过';
 return '等待执行';
}
</script>

<template>
 <section v-if="answers.length" class="surface-card p-16">
  <Column :gap="16">
   <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">本轮模型评测</h2><span class="text-xs text-muted">被测模型得分低于上限才通过；达到或超过上限即不通过。全部所选模型通过，题目才达标</span></Column><Row wrap :gap="8"><v-chip color="secondary">{{ answers.length }} 个模型</v-chip><v-chip v-if="overallLabel" :color="overallColor">{{ overallLabel }}</v-chip><v-btn variant="outlined" color="primary" @click="openAnswers">查看模型作答</v-btn><v-btn variant="outlined" color="error" @click="openFailedScores">评分失败记录 · {{ failedScores.length }}</v-btn></Row></Row>
   <Column v-for="evaluation in evaluations" :key="evaluation.answer.model_id || evaluation.answer.attempt_id || evaluation.answer.name" class="border-t border-line-subtle pt-12" :gap="8">
    <Row x="between" wrap :gap="8">
     <Column :gap="4"><span class="text-sm font-semibold">{{ evaluation.answer.name || evaluation.answer.model_id }}</span><span class="text-xs text-muted break-all">模型 ID：{{ evaluation.answer.model_id }}</span></Column>
     <v-chip size="large" :color="evaluationColor(evaluation.decision)">{{ evaluationLabel(evaluation.decision) }}</v-chip>
    </Row>
    <Row wrap :gap="8" class="text-sm">
      <span>作答任务：{{ taskStatus(evaluation.answer.status) }}</span>
      <span v-if="evaluation.score">评分任务：{{ taskStatus(evaluation.score.score_status) }}</span>
      <v-btn v-if="evaluation.score?.score_attempt_id" size="small" variant="text" @click="openExecution(evaluation.score.score_attempt_id)">查看评分</v-btn>
      <span v-else>评分任务：等待执行</span>
      <template v-if="evaluation.score">
      <span v-if="typeof evaluation.score.score==='number' && typeof evaluation.score.max_score==='number'">{{ evaluation.score.score }} / {{ evaluation.score.max_score }} 分</span>
      <span v-if="evaluation.percentage!==null">百分制 {{ evaluation.percentage.toFixed(2) }} 分</span>
      </template>
      <span v-if="typeof evaluation.answer.minimum_score==='number'">分数上限 {{ evaluation.answer.minimum_score }}（百分制，低于通过）</span>
      <span v-if="evaluation.itemCounts">考点满分 {{ evaluation.itemCounts.fullScore }} 项，未满分 {{ evaluation.itemCounts.belowFull }} 项（共 {{ evaluation.itemCounts.total }} 项）</span>
      <span v-if="evaluation.decision==='passed'">低于上限，该模型通过</span>
      <span v-else-if="evaluation.decision==='not_passed'">达到或超过上限，该模型不通过</span>
      <span v-else-if="evaluation.score?.extraction_status==='unparsed'">评分已返回，未能提取总分；请查看原文，暂不参与通过判定</span>
      <span v-else-if="evaluation.decision==='invalid'">评分无效，暂不参与通过判定</span>
      <span v-else>等待作答或有效评分</span>
      <span v-if="evaluation.score?.score_status==='succeeded'&&evaluation.score.valid" class="text-muted">总分提取成功（未核验逐项评分内容）</span>
    </Row>
   </Column>
  </Column>
 </section>
 <v-dialog v-model="executionDialog" max-width="1080" scrollable>
  <v-card class="surface-card">
   <v-card-title>各模型评分</v-card-title>
   <v-card-text><Column :gap="12">
    <v-select v-model="selectedExecutionId" label="评分执行记录" :items="executionAttempts.map(item=>({title:`${dateLabel(item.started_at)} · ${taskStatus(item.status)}`,value:item.id}))" />
    <v-alert v-if="executionValidationIssues.length" type="warning" density="compact"><p>程序校验未通过，以下评分不参与达标判断：</p><ul class="pl-20"><li v-for="issue in executionValidationIssues" :key="issue">{{ issue }}</li></ul></v-alert>
    <template v-if="scoringOriginal"><p class="font-bold">评分原文</p><pre class="text-sm whitespace-pre-wrap break-words">{{ scoringOriginal }}</pre></template>
   </Column></v-card-text>
   <v-card-actions><v-spacer /><v-btn @click="executionDialog=false">关闭</v-btn></v-card-actions>
  </v-card>
 </v-dialog>
 <v-dialog v-model="answerDialog" max-width="1080" scrollable>
  <v-card v-if="answers.length" class="surface-card">
   <v-card-title><Row x="between" y="center" :gap="12"><h2 class="section-title">各模型作答</h2><v-btn icon="$close" aria-label="关闭模型作答" variant="text" @click="answerDialog=false" /></Row></v-card-title>
   <v-card-text>
    <v-tabs v-model="answerTab" color="primary"><v-tab v-for="answer in answers" :key="answer.model_id||answer.attempt_id||answer.name" :value="answer.model_id||answer.attempt_id||answer.name">{{ answer.name||answer.model_id }}</v-tab></v-tabs>
    <v-window v-model="answerTab" class="">
     <v-window-item v-for="answer in answers" :key="answer.model_id||answer.attempt_id||answer.name" :value="answer.model_id||answer.attempt_id||answer.name">
      <Column :gap="8"><pre class=" max-h-640px overflow-y-auto text-sm whitespace-pre-wrap break-words">{{ answer.answer||'该模型尚无已保存的作答文本。' }}</pre></Column>
     </v-window-item>
    </v-window>
   </v-card-text>
   <v-card-actions><v-spacer /><v-btn color="secondary" @click="answerDialog=false">关闭</v-btn></v-card-actions>
  </v-card>
 </v-dialog>
 <v-dialog v-model="failedScoreDialog" max-width="1180" scrollable>
  <v-card class="surface-card">
   <v-card-title><Row x="between" y="center" :gap="12"><h2 class="section-title">独立评分失败记录</h2><v-btn icon="$close" aria-label="关闭评分失败记录" variant="text" @click="failedScoreDialog=false" /></Row></v-card-title>
   <v-card-text>
    <p v-if="!failedScores.length" class="text-sm text-muted">当前没有失败的评分记录。</p>
    <Row v-else stack-on-mobile y="start" :gap="16" class="min-h-420px">
     <Column class="w-full sm:w-300px sm:flex-none max-h-600px overflow-y-auto border-r border-line-subtle pr-8" :gap="8">
      <v-btn v-for="attempt in failedScores" :key="attempt.id" :variant="attempt.id===selectedFailure?.id ? 'tonal':'text'" color="error" class="justify-start h-auto py-8" @click="selectedFailureId=attempt.id">
       <span class="text-sm text-left">{{ dateLabel(attempt.started_at) }}</span>
      </v-btn>
     </Column>
     <Column v-if="selectedFailure" class="min-w-0 flex-1" :gap="8">
      <span class="text-sm font-semibold">{{ failedModelName(selectedFailure) }} · 失败内容</span>
      <pre class="surface-panel max-h-550px overflow-y-auto p-12 text-sm whitespace-pre-wrap break-words">{{ failedText(selectedFailure) }}</pre>
     </Column>
    </Row>
   </v-card-text>
   <v-card-actions><v-spacer /><v-btn color="secondary" @click="failedScoreDialog=false">关闭</v-btn></v-card-actions>
  </v-card>
 </v-dialog>
</template>
