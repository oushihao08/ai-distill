<!--
职责：读取并保存项目的模型作答请求上限、推理增量认定阈值及免评分开关。
关键方法：`refresh()` 只读读取当前或默认策略，`save()` 仅写入之后新建的作答任务设置。
使用场景：由项目详情的作答模型设置弹窗传入 projectId；不修改模型集合、历史尝试或评分结果。
-->
<script setup lang="ts">
import {api} from '../api/client';

const props=defineProps<{projectId:string}>();
interface AnswerGenerationPolicyView{
 request_timeout_minutes:number;
 reasoning_threshold_minutes:number;
 skip_scoring_on_qualified_timeout:boolean;
 source:'default'|'project';
}
const requestTimeoutMinutes=shallowRef(45);
const reasoningThresholdMinutes=shallowRef(40);
const skipScoringOnQualifiedTimeout=shallowRef(true);
const source=shallowRef<'default'|'project'>('default');
const loading=shallowRef(false);const saving=shallowRef(false);const error=shallowRef('');const message=shallowRef('');
async function refresh(){
 try{
  loading.value=true;error.value='';
  const policy=await api<AnswerGenerationPolicyView>(`/projects/${props.projectId}/answer-generation-policy`);
  requestTimeoutMinutes.value=policy.request_timeout_minutes;
  reasoningThresholdMinutes.value=policy.reasoning_threshold_minutes;
  skipScoringOnQualifiedTimeout.value=policy.skip_scoring_on_qualified_timeout;
  source.value=policy.source;
 }catch(cause){error.value=cause instanceof Error?cause.message:'作答时长设置读取失败';}
 finally{loading.value=false;}
}
async function save(){
 try{
  saving.value=true;error.value='';message.value='';
  const policy=await api<AnswerGenerationPolicyView>(`/projects/${props.projectId}/answer-generation-policy`,{
   method:'PUT',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({request_timeout_minutes:Number(requestTimeoutMinutes.value),reasoning_threshold_minutes:Number(reasoningThresholdMinutes.value),skip_scoring_on_qualified_timeout:skipScoringOnQualifiedTimeout.value}),
  });
  requestTimeoutMinutes.value=policy.request_timeout_minutes;
  reasoningThresholdMinutes.value=policy.reasoning_threshold_minutes;
  skipScoringOnQualifiedTimeout.value=policy.skip_scoring_on_qualified_timeout;
  source.value=policy.source;message.value='设置已保存，仅用于之后新建的作答任务';
 }catch(cause){error.value=cause instanceof Error?cause.message:'作答时长设置保存失败';}
 finally{saving.value=false;}
}
onMounted(refresh);
</script>

<template>
 <Column :gap="12" class="border-t border-line-subtle pt-16">
  <Row x="between" wrap :gap="8"><Column :gap="4"><h3 class="text-sm font-semibold">本期作答时长与免评分</h3><p class="text-xs text-muted">当前值来自{{ source==='project'?'本期设置':'安全默认值' }}；保存只影响之后新建的作答任务。</p></Column><v-btn :loading="loading" :disabled="saving" @click="refresh">刷新</v-btn></Row>
  <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
  <v-alert v-if="message" type="success" density="compact">{{ message }}</v-alert>
  <Row stack-on-mobile :gap="12">
   <v-text-field :model-value="requestTimeoutMinutes" type="number" min="2" max="35791" step="1" label="单次作答请求上限（分钟）" :disabled="loading||saving" @update:model-value="requestTimeoutMinutes=Number($event)" />
   <v-text-field :model-value="reasoningThresholdMinutes" type="number" min="1" max="35790" step="1" label="推理增量认定阈值（分钟）" :disabled="loading||saving" @update:model-value="reasoningThresholdMinutes=Number($event)" />
  </Row>
  <v-switch v-model="skipScoringOnQualifiedTimeout" color="primary" hide-details label="持续生成达上限时免评分直接通过" />
  <p class="text-xs text-muted">只有本地请求到达上限，且可识别的推理增量持续超过阈值、最后活动仍在 2 分钟内、事件间隔不超过 2 分钟时，才会免评分直接通过。断流、失联、心跳异常、无活动证据或其他超时仍按技术失败处理。</p>
  <Row x="end"><v-btn color="primary" variant="flat" :loading="saving" :disabled="loading||saving" @click="save">保存作答策略</v-btn></Row>
 </Column>
</template>
