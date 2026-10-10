<!--
职责：编辑项目某一步骤的执行方式、模型、提示词或返修配置。
关键方法与用法：`save()` 保存步骤覆盖，`inheritDefaults()` 清除覆盖并恢复项目／全局继承；接收项目与步骤配置，保存后发出 `saved` 供父页面刷新。
-->

<script setup lang="ts">
import { api } from '../api/client';
import type { ProjectStage } from '../types/api';
import {DEFAULT_MODEL_API_MODEL,type ModelApiConfig} from '@shared/types';
import {resolveScoreStepPrompt} from '@shared/step-prompts';
const props=defineProps<{ projectId:string; step:ProjectStage }>();
const emit=defineEmits<{ saved:[];close:[];openModels:[] }>();
const editable=computed(()=>[4,6,7,9].includes(props.step.ordinal));
const backend=shallowRef(props.step.config.provider==='codex'?'codex':'api');
interface ApiModelOption {name:string;config:ModelApiConfig;is_default:boolean}
const apiConfig=shallowRef<ModelApiConfig|undefined>(props.step.config.api);
const apiOptions=shallowRef<ApiModelOption[]>([]),loadingApiModels=shallowRef(false);
const apiMaxTokens=shallowRef<number|string>(props.step.config.api?.max_tokens??'');
const apiThinking=shallowRef(props.step.config.api?.enable_thinking===undefined?'default':props.step.config.api.enable_thinking?'enabled':'disabled');
const apiIdentity=(config:ModelApiConfig)=>JSON.stringify([config.provider,config.base_url,config.model]);
const apiModelItems=computed(()=>apiOptions.value.map(item=>({title:`${item.name}${item.is_default?'（默认推荐）':''}`,value:apiIdentity(item.config)})));
const selectedApiModel=computed({get:()=>apiConfig.value?apiIdentity(apiConfig.value):'',set:(value:string)=>{const option=apiOptions.value.find(item=>apiIdentity(item.config)===value);if(option){apiConfig.value={...option.config};apiMaxTokens.value=option.config.max_tokens??'';apiThinking.value=option.config.enable_thinking===undefined?'default':option.config.enable_thinking?'enabled':'disabled';}}});
const model=shallowRef(props.step.config.model ?? 'gpt-6.1-sol');
const effort=shallowRef(props.step.config.reasoning_effort ?? 'medium');
const prompt=shallowRef(props.step.ordinal===6?resolveScoreStepPrompt(props.step.config.prompt):props.step.config.prompt??'');
const scoreInstructions=shallowRef<{developer_instructions:string;task_prompt:string;isolation_config:Record<string,unknown>}|null>(null);
interface ModelOption {slug:string;supported_reasoning_levels:{effort:string}[]}
const modelOptions=shallowRef<ModelOption[]>([]),loadingModels=shallowRef(false);
const isApiRedaction=computed(()=>props.step.ordinal===9&&backend.value==='api');
const isCodexStep=computed(()=>[4,6].includes(props.step.ordinal)||props.step.ordinal===9&&backend.value==='codex');
const invalidConfig=computed(()=>isApiRedaction.value?!apiConfig.value||!prompt.value.trim():isCodexStep.value?!model.value||!effortItems.value.includes(effort.value)||!prompt.value.trim():false);
const modelItems=computed(()=>modelOptions.value.map(item=>({title:item.slug,value:item.slug})));
const effortItems=computed(()=>modelOptions.value.find(item=>item.slug===model.value)?.supported_reasoning_levels.map(level=>level.effort)??[]);
const modelSourceLabel=computed(()=>props.step.config_source==='step'?'步骤单独设置':props.step.config_source==='project'?'项目默认':'Codex 全局默认');
const maxContentRevisions=shallowRef<number|string>(props.step.config.revision_budget?.max_content_revisions??3);
const maxTechnicalRetries=shallowRef<number|string>(props.step.config.revision_budget?.max_technical_retries??'');
const maxCalls=shallowRef<number|string>(props.step.config.revision_budget?.max_calls??'');
const maxDuration=shallowRef<number|string>(props.step.config.revision_budget?.max_duration_ms??'');
const busy=shallowRef(false);const error=shallowRef('');
watch(model,selected=>{const supported=modelOptions.value.find(item=>item.slug===selected)?.supported_reasoning_levels.map(level=>level.effort)??[];if(!supported.includes(effort.value))effort.value=supported.includes('medium')?'medium':supported[0]??'';});
async function loadModels(force=false){
 if(loadingModels.value||(!force&&modelOptions.value.length))return;
 try{
  loadingModels.value=true;
  if(props.step.ordinal===6)scoreInstructions.value=await api('/agent/scoring-instructions');
  const config=await api<{model_options:ModelOption[];model:string}>('/agent/config');
  modelOptions.value=config.model_options??[];
  if(!modelOptions.value.some(item=>item.slug===model.value))model.value=modelOptions.value.some(item=>item.slug===config.model)?config.model:modelOptions.value[0]?.slug??'';
 }
 catch(cause){error.value=cause instanceof Error?cause.message:'读取Agent模型清单失败';}finally{loadingModels.value=false;}
}
watch(isCodexStep,enabled=>{if(enabled)void loadModels();},{immediate:true});
async function loadApiModels(){
 if(loadingApiModels.value||apiOptions.value.length)return;
 try{
  loadingApiModels.value=true;
  // Reuse the same deployed registry endpoint as the answer-model selector.
  const registered=await api<{name:string;config:ModelApiConfig;enabled:boolean}[]>('/answer-models');
  const models=registered.filter(item=>item.enabled).map(item=>({name:item.name,config:item.config,is_default:item.config.provider==='openrouter'&&item.config.model===DEFAULT_MODEL_API_MODEL}));
  const current=apiConfig.value;
  apiOptions.value=current&&!models.some(item=>apiIdentity(item.config)===apiIdentity(current))?[{name:`${current.model}（已保存）`,config:current,is_default:false},...models]:models;
  const recommended=models.find(item=>item.is_default);
  if(!current&&recommended)apiConfig.value={...recommended.config};
  if(!apiOptions.value.length)throw new Error('系统模型目录为空，请先登记API模型');
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取API模型目录失败';}finally{loadingApiModels.value=false;}
}
watch(isApiRedaction,enabled=>{if(enabled)void loadApiModels();},{immediate:true});
async function save(){
 try{
  busy.value=true;error.value='';
  const config=props.step.ordinal===7?{revision_budget:{max_content_revisions:Number(maxContentRevisions.value),...(maxTechnicalRetries.value===''?{}:{max_technical_retries:Number(maxTechnicalRetries.value)}),...(maxCalls.value===''?{}:{max_calls:Number(maxCalls.value)}),...(maxDuration.value===''?{}:{max_duration_ms:Number(maxDuration.value)})}}:isApiRedaction.value?{provider:'api',prompt:prompt.value,api:{provider:apiConfig.value!.provider,model:apiConfig.value!.model,base_url:apiConfig.value!.base_url,...(apiMaxTokens.value===''?{}:{max_tokens:Number(apiMaxTokens.value)}),...(['qwen','openrouter'].includes(apiConfig.value!.provider)&&apiThinking.value!=='default'?{enable_thinking:apiThinking.value==='enabled'}:{})}}:{model:model.value,reasoning_effort:effort.value,...(props.step.ordinal===9?{provider:'codex',prompt:prompt.value}:{prompt:prompt.value})};
  const endpoint=`/${isCodexStep.value?'agent/':''}projects/${props.projectId}/steps/${props.step.ordinal}/config`;
  await api(endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
  emit('saved');emit('close');
 }catch(cause){
  error.value=cause instanceof Error?cause.message:'保存失败';
  if(isCodexStep.value&&error.value==='模型不在当前Codex可用模型清单中'){
   error.value='';
   await loadModels(true);
   if(!error.value)error.value='Codex模型清单已刷新，请确认模型选择后重新保存。';
  }
 }finally{busy.value=false;}
}
async function inheritDefaults(){
 try{busy.value=true;error.value='';await api(`/projects/${props.projectId}/steps/${props.step.ordinal}/config`,{method:'DELETE'});emit('saved');emit('close');}
 catch(cause){error.value=cause instanceof Error?cause.message:'恢复默认设置失败';}finally{busy.value=false;}
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="save"><Column :gap="16">
 <Row x="between"><h2 class="section-title">{{ step.position }} · {{ step.name }}</h2><v-btn icon="$close" variant="text" aria-label="关闭步骤设置" :disabled="busy" @click="emit('close')" /></Row>
 <p class="text-sm text-muted">就绪 {{ step.ready }} · 排队 {{ step.queued }} · 运行 {{ step.running }}<template v-if="step.ordinal===7"> · 达标 {{ step.succeeded }} · 需返修 {{ step.needs_repair }} · 隔离 {{ step.quarantined }}</template><template v-else> · 成功 {{ step.succeeded }}</template> · 失败 {{ step.failed }}</p>
 <Column v-if="step.ordinal===5" :gap="8"><v-alert type="info">点击“模型作答”会为项目模型集合中的每个已选模型分别派发作答任务，随后逐份评分。请在项目的“作答模型”页选择并保存多个模型；这里无需选择单个模型。</v-alert><Row x="end"><v-btn color="primary" variant="flat" @click="emit('openModels')">配置作答模型</v-btn></Row></Column>
 <template v-else-if="editable">
  <v-alert type="info">{{ step.ordinal===9?'脱敏读取数据库中的原始文本。可选择大模型 API 或本地 Agent；保存执行方式、模型或提示词后，原脱敏及后续结果失效，需要重新执行。':step.ordinal===4?'出题 Agent 每次读取当前项目 skill 和资料、数据库中的脱敏文本及本步提示词，生成并自检题目草稿；标答不会进入模型作答输入。':step.ordinal===6?'独立评分只读取同版题面、rubric、数据库脱敏附件、匿名完整答案和评分提示词；不向评分 Agent 提供作答思路或标准答案，逐项证据须来自待评答案原文。不读取项目 skill、历史评分或个人记忆。下方显示当前服务发送的应用指令，历史实际指令请查看评分执行记录。':'模型集合及各自的百分制分数上限在项目“作答模型”中设置。按得分/满分换算后，低于该模型上限才算该模型通过；全部所选模型通过，题目才达标。此处仅设置返修预算。' }}</v-alert>
  <template v-if="step.ordinal===7">
   <Row x="end"><v-btn variant="outlined" color="primary" @click="emit('openModels')">配置作答模型与分数上限</v-btn></Row>
   <v-text-field v-model="maxContentRevisions" label="内容返修上限" type="number" min="0" :disabled="busy" />
   <v-text-field v-model="maxTechnicalRetries" label="技术重试上限（留空则暂停等待配置）" type="number" min="0" :disabled="busy" />
   <v-text-field v-model="maxCalls" label="累计调用上限（可留空）" type="number" min="0" :disabled="busy" />
   <v-text-field v-model="maxDuration" label="有效执行时长上限（毫秒，可留空）" type="number" min="1" :disabled="busy" />
  </template>
  <template v-else>
   <v-select v-if="step.ordinal===9" v-model="backend" label="执行方式" :items="[{title:'大模型 API（默认）',value:'api'},{title:'本地 Agent（Codex）',value:'codex'}]" :disabled="busy" />
  <v-select v-if="isCodexStep" v-model="effort" label="推理强度" :items="effortItems" :disabled="busy||loadingModels||!effortItems.length" />
   <template v-if="isApiRedaction">
    <v-select v-model="selectedApiModel" label="脱敏模型" :items="apiModelItems" :loading="loadingApiModels" :disabled="busy||loadingApiModels" required />
    <p class="text-xs text-muted">复用统一 API 配置，无需在此填写地址或密钥。默认推荐 GLM-5.3-Flash，可选择系统已登记的其他模型。</p>
    <v-text-field v-model="apiMaxTokens" label="最大输出 token（可留空）" type="number" min="1" :disabled="busy" />
    <v-select v-if="apiConfig&&['qwen','openrouter'].includes(apiConfig.provider)" v-model="apiThinking" label="思考模式" :items="[{title:'模型默认',value:'default'},{title:'关闭',value:'disabled'},{title:'开启',value:'enabled'}]" :disabled="busy" />
   </template>
    <v-select v-if="isCodexStep" v-model="model" label="模型" :items="modelItems" :loading="loadingModels" required :disabled="busy||loadingModels||!modelItems.length" />
   <v-text-field v-else-if="!isApiRedaction&&step.ordinal!==6" v-model="model" label="模型 ID" required :disabled="busy" />
   <v-textarea v-if="step.ordinal===9" v-model="prompt" label="脱敏步骤提示词" rows="8" required :disabled="busy" />
   <v-textarea v-if="[4,6].includes(step.ordinal)" v-model="prompt" :label="step.ordinal===4?'出题步骤提示词':'评分步骤提示词'" rows="8" required :disabled="busy" />
   <Column v-if="step.ordinal===6&&scoreInstructions" :gap="8">
    <p class="text-xs text-muted">每次评分使用新会话，完整题目、各份附件及待评答案分别放入临时文件，由 Agent 完整读取；消息包含文件用途和上方原样提示词。结束后删除临时文件，保留评分原文及发送记录。记忆和外部资料访问关闭。</p>
    <details><summary class="text-sm cursor-pointer">查看程序调用说明与隔离参数</summary><pre class="text-xs whitespace-pre-wrap break-words">{{ scoreInstructions.task_prompt }}\n{{ JSON.stringify(scoreInstructions.isolation_config,null,2) }}</pre></details>
   </Column>
  </template>
  <p v-if="isCodexStep" class="text-xs text-muted">当前来源：{{ modelSourceLabel }}。保存后此步骤将独立覆盖默认值。</p>
  <v-alert v-if="isCodexStep&&!loadingModels&&!modelItems.length" type="warning">本机 Codex 模型清单不可用，请先登录并刷新模型清单。</v-alert>
 </template>
 <p v-else-if="!editable && step.ordinal!==5" class="text-sm text-muted">{{ step.ordinal===1?'DOCX/TXT/MD本地解析入库；PDF先完成OCR提取再入库。材料变化后先同步目录。':'此步骤不需要模型配置。' }}</p>
 <v-alert v-if="error" type="error">{{ error }}</v-alert>
 <Row x="end" :gap="8"><v-btn v-if="(isCodexStep||step.ordinal===9)&&step.config_source==='step'" @click="inheritDefaults" :disabled="busy">恢复默认设置</v-btn><v-btn @click="emit('close')" :disabled="busy">关闭</v-btn><v-btn v-if="editable" type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy||invalidConfig">保存设置</v-btn></Row>
</Column></v-form></template>
