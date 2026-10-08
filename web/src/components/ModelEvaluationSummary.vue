<script setup lang="ts">
import { computed } from 'vue';
import { statusLabels, type Step, type StepStatus } from '../types/api';

interface ModelAnswer {
 model_id:string;
 name:string;
 minimum_score?:number|null;
 attempt_id?:string|null;
 status:string;
 answer?:string|null;
}
interface ModelScore {
 model_id:string;
 name:string;
 answer_status:string;
 score_status:string;
 score?:number|null;
 max_score?:number|null;
 valid?:boolean;
}

const props=defineProps<{steps:Step[]}>();
const answers=computed(()=>{
 const models=props.steps[4]?.result?.models;
 return Array.isArray(models)?models as ModelAnswer[]:[];
});
const scores=computed(()=>{
 const models=props.steps[5]?.result?.models;
 return Array.isArray(models)?models as ModelScore[]:[];
});
const evaluations=computed(()=>answers.value.map(answer=>({answer,score:scores.value.find(item=>item.model_id===answer.model_id)})));
function label(status:string){return statusLabels[status as StepStatus]??status;}
function color(status:string){return status==='succeeded'?'success':status==='failed'?'error':status==='running'?'primary':'secondary';}
</script>

<template>
 <section v-if="answers.length" class="surface-card p-16">
  <Column :gap="16">
   <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">本轮模型评测</h2><span class="text-xs text-muted">答案与评分按模型分别记录</span></Column><v-chip color="secondary">{{ answers.length }} 个模型</v-chip></Row>
   <Column v-for="evaluation in evaluations" :key="evaluation.answer.model_id || evaluation.answer.attempt_id || evaluation.answer.name" class="border-t border-line-subtle pt-12" :gap="8">
    <Row x="between" wrap :gap="8">
     <Column :gap="4"><span class="text-sm font-semibold">{{ evaluation.answer.name || evaluation.answer.model_id }}</span><span class="text-xs text-muted break-all">模型 ID：{{ evaluation.answer.model_id }}</span></Column>
     <v-chip :color="color(evaluation.answer.status)">{{ label(evaluation.answer.status) }}</v-chip>
    </Row>
    <template v-if="evaluation.score">
     <Row wrap :gap="8" class="text-sm">
      <span>评分：{{ label(evaluation.score.score_status) }}</span>
      <span v-if="typeof evaluation.score.score==='number' && typeof evaluation.score.max_score==='number'">{{ evaluation.score.score }} / {{ evaluation.score.max_score }} 分</span>
      <span v-if="typeof evaluation.answer.minimum_score==='number'">达标线 {{ evaluation.answer.minimum_score }} 分</span>
      <v-chip v-if="evaluation.score.score_status==='succeeded'" size="small" :color="evaluation.score.valid?'success':'warning'">{{ evaluation.score.valid?'评分有效':'评分无效' }}</v-chip>
     </Row>
    </template>
    <details v-if="evaluation.answer.answer" class="text-sm"><summary class="cursor-pointer link-text">查看该模型答案</summary><pre class="surface-panel text-xs whitespace-pre-wrap break-all mt-8">{{ evaluation.answer.answer }}</pre></details>
   </Column>
  </Column>
 </section>
</template>
