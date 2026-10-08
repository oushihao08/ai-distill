<script setup lang="ts">
import { api } from '../api/client';
import type { ProjectStage } from '../types/api';
const props=defineProps<{ projectId:string; step:ProjectStage }>();
const emit=defineEmits<{ saved:[];close:[] }>();
const editable=computed(()=>[3,4,5,6,7,9].includes(props.step.ordinal));
const model=shallowRef(props.step.config.model ?? (props.step.ordinal===5?'':'gpt-6.1-sol'));
const effort=shallowRef(props.step.config.reasoning_effort ?? 'medium');
const prompt=shallowRef(props.step.config.prompt??'');
const efforts=['low','medium','high','xhigh','max','ultra'];
const provider=shallowRef(props.step.config.provider??'qwen');
const providerOptions=[{title:'Qwen（OpenRouter）',value:'qwen'},{title:'OpenRouter',value:'openrouter'},{title:'Kimi原生',value:'kimi'},{title:'DeepSeek原生',value:'deepseek'},{title:'豆包原生',value:'doubao'}];
const baseUrl=shallowRef(props.step.config.base_url??'');
const thinking=shallowRef(props.step.config.enable_thinking===undefined?'default':props.step.config.enable_thinking?'enabled':'disabled');
const maxTokens=shallowRef<string|number>(props.step.config.max_tokens??'');
const requiredModels=shallowRef(props.step.config.required_models?.join(', ')??'');
const minimumScores=shallowRef(JSON.stringify(props.step.config.minimum_score_by_model??{},null,2));
const maxContentRevisions=shallowRef<number|string>(props.step.config.revision_budget?.max_content_revisions??3);
const maxTechnicalRetries=shallowRef<number|string>(props.step.config.revision_budget?.max_technical_retries??'');
const maxCalls=shallowRef<number|string>(props.step.config.revision_budget?.max_calls??'');
const maxDuration=shallowRef<number|string>(props.step.config.revision_budget?.max_duration_ms??'');
watch(provider,()=>{model.value='';baseUrl.value='';thinking.value='default';});
const busy=shallowRef(false);const error=shallowRef('');
async function save(){
 try{
  busy.value=true;error.value='';
  const config=props.step.ordinal===5?{provider:provider.value,...(baseUrl.value.trim()?{base_url:baseUrl.value.trim()}:{}),model:model.value,...(provider.value!=='qwen'||thinking.value==='default'?{}:{enable_thinking:thinking.value==='enabled'}),...(maxTokens.value===''?{}:{max_tokens:Number(maxTokens.value)})}:props.step.ordinal===7?{required_models:requiredModels.value.split(',').map(value=>value.trim()).filter(Boolean),minimum_score_by_model:JSON.parse(minimumScores.value),revision_budget:{max_content_revisions:Number(maxContentRevisions.value),...(maxTechnicalRetries.value===''?{}:{max_technical_retries:Number(maxTechnicalRetries.value)}),...(maxCalls.value===''?{}:{max_calls:Number(maxCalls.value)}),...(maxDuration.value===''?{}:{max_duration_ms:Number(maxDuration.value)})}}:{model:model.value,reasoning_effort:effort.value,...(props.step.ordinal===9?{provider:'codex',prompt:prompt.value}:{})};
  await api(`/projects/${props.projectId}/steps/${props.step.ordinal}/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
  emit('saved');emit('close');
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存失败';}finally{busy.value=false;}
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="save"><Column :gap="16">
 <Row x="between"><h2 class="section-title">{{ step.position }} · {{ step.name }}</h2><v-btn icon="$close" variant="text" aria-label="关闭步骤设置" :disabled="busy" @click="emit('close')" /></Row>
 <p class="text-sm text-muted">就绪 {{ step.ready }} · 排队 {{ step.queued }} · 运行 {{ step.running }} · 成功 {{ step.succeeded }} · 失败 {{ step.failed }}</p>
 <template v-if="editable">
  <v-alert type="info">{{ step.ordinal===9?'脱敏单独读取数据库中的原始文本，结果另存为脱敏产物；项目可独立调整此提示词。设置仅影响之后入队的任务。':step.ordinal===4?'出题和独立质检使用两个隔离的Codex会话；标答只提供给质检角色，不进入后续作答或评分输入。设置仅影响之后入队的任务。':step.ordinal===5?'作答模型只接收题面和脱敏附件；每次选择一个模型。设置仅影响之后入队的任务，密钥在服务端配置。':step.ordinal===6?'独立评分使用当前题目、脱敏附件、rubric和匿名完整答案。设置仅影响之后入队的任务，不向评分模型发送标答、目标分数或模型身份。':step.ordinal===7?'每个必需模型都必须有单独最低分。返修轮次默认最多三轮；技术重试、累计调用和有效耗时上限可按项目配置。':'此步骤的执行器尚未接入。' }}</v-alert>
  <template v-if="step.ordinal===7">
   <v-text-field v-model="requiredModels" label="必需模型 ID（逗号分隔）" placeholder="qwen-plus, deepseek-chat" :disabled="busy" />
   <v-textarea v-model="minimumScores" label="逐模型最低分 JSON" rows="5" :disabled="busy" />
   <v-text-field v-model="maxContentRevisions" label="内容返修上限" type="number" min="0" :disabled="busy" />
   <v-text-field v-model="maxTechnicalRetries" label="技术重试上限（留空则暂停等待配置）" type="number" min="0" :disabled="busy" />
   <v-text-field v-model="maxCalls" label="累计调用上限（可留空）" type="number" min="0" :disabled="busy" />
   <v-text-field v-model="maxDuration" label="有效执行时长上限（毫秒，可留空）" type="number" min="1" :disabled="busy" />
  </template>
  <template v-else>
   <v-select v-if="step.ordinal===5" v-model="provider" label="作答服务" :items="providerOptions" :disabled="busy" />
   <v-text-field v-if="step.ordinal!==6" v-model="model" label="模型 ID" required :disabled="busy" />
   <v-textarea v-if="step.ordinal===9" v-model="prompt" label="项目脱敏提示词" rows="8" required :disabled="busy" />
  </template>
  <template v-if="step.ordinal===5"><v-text-field v-model="baseUrl" label="兼容 API 地址（可留空使用服务端默认）" :disabled="busy" /><v-select v-if="provider==='qwen'" v-model="thinking" label="推理模式" :items="[{title:'模型默认',value:'default'},{title:'启用',value:'enabled'},{title:'关闭',value:'disabled'}]" :disabled="busy" /><v-text-field v-model="maxTokens" label="最大输出 Token（可留空）" type="number" min="1" :disabled="busy" /></template>
  <v-select v-else-if="step.ordinal!==7" v-model="effort" label="推理强度" :items="efforts" :disabled="busy" />
 </template>
 <p v-else class="text-sm text-muted">{{ step.ordinal===1?'DOCX/TXT/MD本地解析入库；PDF先完成OCR提取再入库。材料变化后先同步目录。':'此步骤不需要模型配置。' }}</p>
 <v-alert v-if="error" type="error">{{ error }}</v-alert>
 <Row x="end" :gap="8"><v-btn @click="emit('close')" :disabled="busy">关闭</v-btn><v-btn v-if="editable" type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy || (step.ordinal===7?!requiredModels.trim():step.ordinal===6?false:!model.trim()||step.ordinal===9&&!prompt.trim())">保存设置</v-btn></Row>
</Column></v-form></template>
