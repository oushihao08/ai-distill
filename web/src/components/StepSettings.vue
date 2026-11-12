<!--
职责：编辑项目某一步骤的执行方式、模型或提示词。
关键方法与用法：`save()` 保存步骤覆盖，`inheritDefaults()` 清除覆盖并恢复项目／全局继承；接收项目与步骤配置，保存后发出 `saved` 供父页面刷新。
-->

<script setup lang="ts">
import ProjectAnswerModelsSummary from './ProjectAnswerModelsSummary.vue';
import WorkflowPolicyEditor from './WorkflowPolicyEditor.vue';
import type {WorkflowConfig} from '@shared/workflow-config';
import { api } from '../api/client';
import type { ProjectStage } from '../types/api';
import type {ModelApiConfig} from '@shared/types';
import {AUTHORING_FIXED_PROMPT,resolveScoreStepPrompt} from '@shared/step-prompts';
import {resolveMaterialProcessingMode,materialProcessingSourceMode,type MaterialProcessingMode} from '@shared/material-library';
const props=defineProps<{ projectId:string; step:ProjectStage; materialSourceMode:'redacted'|'original'; allowOriginalMaterialMode:boolean }>();
const emit=defineEmits<{ saved:[];close:[];openModels:[] }>();
const editable=computed(()=>[4,5,6].includes(props.step.ordinal));
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
const authorTimeoutMinutes=shallowRef<number|string>(props.step.config.timeout_ms?props.step.config.timeout_ms/60000:'');
const authoringProcessingMode=shallowRef<MaterialProcessingMode>(resolveMaterialProcessingMode(props.step.config));
const openedPrompt=props.step.config.prompt??'';
const prompt=shallowRef(props.step.ordinal===6?resolveScoreStepPrompt(props.step.config.prompt):openedPrompt);
const scoreInstructions=shallowRef<{developer_instructions:string;task_prompt:string;isolation_config:Record<string,unknown>}|null>(null);
interface ModelOption {slug:string;supported_reasoning_levels:{effort:string}[]}
const modelOptions=shallowRef<ModelOption[]>([]),loadingModels=shallowRef(false);
const isApiScoring=computed(()=>props.step.ordinal===6&&backend.value==='api');
const isCodexStep=computed(()=>props.step.ordinal===4||props.step.ordinal===6&&backend.value==='codex');
const invalidConfig=computed(()=>props.step.ordinal===5?!prompt.value.trim():(isApiScoring.value)?!apiConfig.value||!prompt.value.trim():isCodexStep.value?!model.value||!(effort.value??'').trim()||!prompt.value.trim()||props.step.ordinal===4&&authorTimeoutMinutes.value!==''&&(!Number.isInteger(Number(authorTimeoutMinutes.value))||Number(authorTimeoutMinutes.value)<1||Number(authorTimeoutMinutes.value)>120):false);
const modelItems=computed(()=>modelOptions.value.map(item=>({title:item.slug,value:item.slug})));
const effortItems=computed(()=>modelOptions.value.find(item=>item.slug===model.value)?.supported_reasoning_levels.map(level=>level.effort)??[]);
const modelSourceLabel=computed(()=>props.step.config_source==='step'?'步骤单独设置':props.step.config_source==='project'?'项目默认':'Codex 全局默认');
const workflowDraft=shallowRef<WorkflowConfig|undefined>(props.step.config.workflow);
const workflowInvalid=shallowRef(false);
const busy=shallowRef(false);const error=shallowRef('');
async function loadModels(force=false){
 if(loadingModels.value||(!force&&modelOptions.value.length))return;
 try{
  loadingModels.value=true;
  if(props.step.ordinal===6)scoreInstructions.value=await api('/agent/scoring-instructions');
  const config=await api<{model_options:ModelOption[];agent_drivers?:{id:string;label:string;model_options:ModelOption[]}[];model:string}>('/agent/config');
  modelOptions.value=config.agent_drivers?.length?config.agent_drivers.flatMap(d=>d.model_options):config.model_options??[];
 }
 catch(cause){error.value=cause instanceof Error?cause.message:'读取Agent模型清单失败';}finally{loadingModels.value=false;}
}
watch(isCodexStep,enabled=>{if(enabled)void loadModels();},{immediate:true});
async function loadApiModels(){
 if(loadingApiModels.value||apiOptions.value.length)return;
 try{
  loadingApiModels.value=true;
  // Reuse the same deployed registry endpoint as the answer-model selector.
  const registered=(await api<{models:{name:string;config:ModelApiConfig;is_default:boolean}[]}>('/llm-api/models')).models;
  const models=registered.map(item=>({name:item.name,config:item.config,is_default:item.is_default}));
  const current=apiConfig.value;
  apiOptions.value=current&&!models.some(item=>apiIdentity(item.config)===apiIdentity(current))?[{name:`${current.model}（已保存）`,config:current,is_default:false},...models]:models;
  const recommended=models.find(item=>item.is_default);
  if(!current&&recommended)apiConfig.value={...recommended.config};
  if(!apiOptions.value.length)throw new Error('系统模型目录为空，请先登记API模型');
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取API模型目录失败';}finally{loadingApiModels.value=false;}
}
watch(()=>isApiScoring.value,enabled=>{if(enabled)void loadApiModels();},{immediate:true});
async function save(){
 try{
  busy.value=true;error.value='';
  if(props.step.ordinal===5){
   await api(`/projects/${props.projectId}/steps/5/prompt`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prompt.value,expected_prompt:openedPrompt})});
   await api(`/projects/${props.projectId}/steps/5/workflow`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow:workflowDraft.value??null})});
   emit('saved');emit('close');return;
  }
  const apiSettings=isApiScoring.value?{provider:apiConfig.value!.provider,model:apiConfig.value!.model,base_url:apiConfig.value!.base_url,...(apiMaxTokens.value===''?{}:{max_tokens:Number(apiMaxTokens.value)}),...(['qwen','openrouter'].includes(apiConfig.value!.provider)&&apiThinking.value!=='default'?{enable_thinking:apiThinking.value==='enabled'}:{})}:undefined;
  const config=isApiScoring.value?{provider:'api',prompt:prompt.value,api:apiSettings}:{model:model.value,reasoning_effort:effort.value,prompt:prompt.value};
  const endpoint=`/${isCodexStep.value?'agent/':''}projects/${props.projectId}/steps/${props.step.ordinal}/config`;
  await api(endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...config,expected_prompt:openedPrompt,...(props.step.ordinal===4?{material_processing_mode:authoringProcessingMode.value,material_source_mode:materialProcessingSourceMode(authoringProcessingMode.value)}:{}),...(props.step.ordinal===4&&authorTimeoutMinutes.value!==''?{timeout_ms:Number(authorTimeoutMinutes.value)*60000}:{}),...([4,6].includes(props.step.ordinal)&&workflowDraft.value?{workflow:workflowDraft.value}:{})})});
  emit('saved');emit('close');
 }catch(cause){
  error.value=cause instanceof Error?cause.message:'保存失败';
 }finally{busy.value=false;}
}
async function inheritDefaults(){
 try{busy.value=true;error.value='';await api(`/projects/${props.projectId}/steps/${props.step.ordinal}/config`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_prompt:openedPrompt})});emit('saved');emit('close');}
 catch(cause){error.value=cause instanceof Error?cause.message:'恢复默认设置失败';}finally{busy.value=false;}
}
</script>
<template><v-form class="surface-card max-h-[calc(100dvh-48px)] min-h-0 flex flex-col overflow-hidden" @submit.prevent="save">
 <Row x="between" class="p-20 pb-12 shrink-0"><h2 class="section-title">{{ step.position }} · {{ step.name }}</h2><v-btn icon="$close" variant="text" aria-label="关闭步骤设置" :disabled="busy" @click="emit('close')" /></Row>
 <Column :gap="16" class="min-h-0 overflow-y-auto px-20 pb-16">
 <p class="text-sm text-muted">就绪 {{ step.ready }} · 排队 {{ step.queued }} · 运行 {{ step.running }} · 成功 {{ step.succeeded }} · 失败 {{ step.failed }}</p>
 <Column v-if="step.ordinal===5" :gap="8"><ProjectAnswerModelsSummary :project-id="projectId" /><v-alert type="info">点击“模型作答”会为项目模型集合中的每个已选模型分别派发作答任务，随后逐份评分。每题只读取创建题目时冻结的材料版本，脱敏或未脱敏由题目快照决定；请在出题前为本期选择新题材料版本。请在项目的“作答模型”页选择并保存多个模型；这里无需选择单个模型。同一主项目各期共用本提示词，保存会同步到其他期次，但只影响之后创建的作答任务。</v-alert><v-textarea v-model="prompt" label="模型作答步骤提示词" rows="8" required :disabled="busy" /><Row x="end"><v-btn color="primary" variant="flat" @click="emit('openModels')">配置作答模型</v-btn></Row></Column>
 <template v-else-if="editable">
  <Column v-if="step.ordinal===4" :gap="8" class="rounded border border-line-subtle p-12"><strong class="text-sm">系统固定通用出题规则</strong><pre class="max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-xs">{{ AUTHORING_FIXED_PROMPT }}</pre></Column>
  <v-alert v-if="step.ordinal===4&&authoringProcessingMode==='mask'" type="warning">本期仍为历史遮挡设置，请明确选择Agent化名或原文；保存不会将旧结果改标为化名。</v-alert>
  <v-select v-if="step.ordinal===4&&props.allowOriginalMaterialMode" v-model="authoringProcessingMode" label="本期材料处理方式" :items="[{title:'Agent 主导化名脱敏',value:'aliases'},{title:'不脱敏，使用提取原文',value:'original'}]" :disabled="busy" />
  <v-select v-if="step.ordinal===6" v-model="backend" label="执行方式" :items="[{title:'本地 Agent（Codex）',value:'codex'},{title:'大模型 API',value:'api'}]" :disabled="busy" />
  <v-combobox :return-object="false" v-if="isCodexStep" v-model="effort" label="推理强度" :items="effortItems" :disabled="busy||loadingModels" />
   <template v-if="isApiScoring">
    <v-select v-model="selectedApiModel" label="评分 API 模型" :items="apiModelItems" :loading="loadingApiModels" :disabled="busy||loadingApiModels" required />
    <p class="text-xs text-muted">API评分使用独立API并发，不占用Codex Agent并发；题面、rubric、匿名答案、本题冻结的{{ props.materialSourceMode==='original'?'未脱敏':'脱敏' }}附件和提示词按本次冻结内容发送，逐项评分仍使用现有校验。</p>
    <v-text-field v-model="apiMaxTokens" label="最大输出 token（可留空）" type="number" min="1" :disabled="busy" />
    <v-select v-if="apiConfig&&['qwen','openrouter'].includes(apiConfig.provider)" v-model="apiThinking" label="思考模式" :items="[{title:'模型默认',value:'default'},{title:'关闭',value:'disabled'},{title:'开启',value:'enabled'}]" :disabled="busy" />
   </template>
    <v-combobox :return-object="false" v-if="isCodexStep" v-model="model" label="模型" :items="modelItems" :loading="loadingModels" required :disabled="busy||loadingModels" />
   <v-text-field v-else-if="step.ordinal!==6" v-model="model" label="模型 ID" required :disabled="busy" />
   <v-textarea v-if="step.ordinal===9" v-model="prompt" label="脱敏步骤提示词" rows="8" required :disabled="busy" />
   <v-textarea v-if="[4,6].includes(step.ordinal)" v-model="prompt" :label="step.ordinal===4?'本项目出题提示词（可定制）':'评分步骤提示词'" rows="8" required :disabled="busy" />
   <v-text-field v-if="step.ordinal===4" v-model="authorTimeoutMinutes" label="出题时限（分钟，留空为默认 30）" type="number" min="1" max="120" step="1" :disabled="busy" />
   <Column v-if="step.ordinal===6&&scoreInstructions" :gap="8">
    <p class="text-xs text-muted">每次评分使用新会话，完整题目、各份附件及待评答案分别放入临时文件，由 Agent 完整读取；消息包含文件用途和上方原样提示词。结束后删除临时文件，保留评分原文及发送记录。记忆和外部资料访问关闭。</p>
    <details><summary class="text-sm cursor-pointer">查看程序调用说明与隔离参数</summary><pre class="text-xs whitespace-pre-wrap break-words">{{ scoreInstructions.task_prompt }}\n{{ JSON.stringify(scoreInstructions.isolation_config,null,2) }}</pre></details>
   </Column>
  <p v-if="isCodexStep" class="text-xs text-muted">当前来源：{{ modelSourceLabel }}。保存后此步骤将独立覆盖默认值。</p>
  <v-alert v-if="isCodexStep&&!loadingModels&&!modelItems.length" type="warning">本机模型建议暂不可用，可直接输入模型和推理强度；实际可用性由执行时反馈。</v-alert>
 </template>
 <p v-else-if="!editable && step.ordinal!==5" class="text-sm text-muted">{{ step.ordinal===9?'旧字段映射设置已退役；请在材料库使用Agent化名或提取原文。':step.ordinal===1?'TXT/MD本地解析；PDF/DOCX先完成结构化提取再入库。材料变化后先同步目录。':'此步骤不需要模型配置。' }}</p>
 <WorkflowPolicyEditor v-if="[4,5,6].includes(step.ordinal)" :initial="step.config.workflow" :ordinal="step.ordinal" :disabled="busy" @change="workflowDraft=$event" @invalid="workflowInvalid=$event" />
 <v-alert v-if="error" type="error">{{ error }}</v-alert>
 </Column>
 <Row x="end" :gap="8" wrap class="shrink-0 p-20 pt-12 border-t border-line-subtle"><v-btn v-if="isCodexStep&&step.config_source==='step'" @click="inheritDefaults" :disabled="busy">恢复默认设置</v-btn><v-btn @click="emit('close')" :disabled="busy">关闭</v-btn><v-btn v-if="editable" type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy||invalidConfig||workflowInvalid">保存设置</v-btn></Row>
</v-form></template>
