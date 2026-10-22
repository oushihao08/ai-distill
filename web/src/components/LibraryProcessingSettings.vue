<!-- 职责：维护所有材料包共用的模型、提示词及处理参数；saved/close用于材料库设置弹窗。
保存使用If-Match版本，任务派发读取共用设置并冻结，历史任务/题目不回写。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {defaultLibraryRedactionTemplateId,libraryRedactionTemplates,type LibraryRedactionTemplate} from '@shared/redaction-templates';
import type {ModelApiConfig} from '@shared/types';
const emit=defineEmits<{saved:[];close:[]}>();
interface Settings {redaction_templates?:LibraryRedactionTemplate[];version:1;extraction:Record<string,unknown>;redaction:{provider:'api'|'codex';api?:ModelApiConfig|null;model?:string;reasoning_effort?:string;prompt:string};execution:Record<string,number>;policy:{preserve_amounts:true;preserve_dates:true}}
interface Package {lock_version:number;processing_settings:Settings}
const draft=shallowRef<Package>();
const templates=ref<LibraryRedactionTemplate[]>([]),templateId=shallowRef('');
const currentTemplate=computed(()=>templates.value.find(t=>t.id===templateId.value));
const isPlan=computed(()=>currentTemplate.value?.workflow==='codex_plan');
function redactionDraft():Settings['redaction']{return isPlan.value?{provider:'codex',prompt:prompt.value}:backend.value==='api'?{provider:'api',prompt:prompt.value,api:{...config.value!,...(maxTokens.value===''?{max_tokens:undefined}:{max_tokens:Number(maxTokens.value)}),enable_thinking:config.value&&['qwen','openrouter'].includes(config.value.provider)&&thinking.value!=='default'?thinking.value==='enabled':undefined}}:{provider:'codex',prompt:prompt.value,model:model.value,reasoning_effort:effort.value};}
function commitTemplate(){if(currentTemplate.value)currentTemplate.value.redaction=redactionDraft();}
function selectTemplate(id:string){commitTemplate();templateId.value=id;const t=currentTemplate.value;if(t)apply({redaction:t.redaction} as Settings);}
function addTemplate(){commitTemplate();const t:LibraryRedactionTemplate={id:`template-${Date.now()}`,name:'新脱敏模板',workflow:currentTemplate.value?.workflow??'field_mapping',redaction:structuredClone(redactionDraft())};templates.value.push(t);templateId.value=t.id;}
function changeWorkflow(value:'field_mapping'|'codex_plan'){if(!currentTemplate.value)return;currentTemplate.value.workflow=value;if(value==='codex_plan'){backend.value='codex';currentTemplate.value.redaction={provider:'codex',prompt:prompt.value};}}
const backend=shallowRef<'api'|'codex'>('api'),prompt=shallowRef(''),model=shallowRef(''),effort=shallowRef('medium');
const config=shallowRef<ModelApiConfig|null>(null),maxTokens=shallowRef<number|string>(''),thinking=shallowRef('default');
const busy=shallowRef(false),loading=shallowRef(true),error=shallowRef('');
const options=shallowRef<{name:string;config:ModelApiConfig}[]>([]),agentModels=shallowRef<{slug:string;supported_reasoning_levels:{effort:string}[]}[]>([]);
const identity=(item:ModelApiConfig)=>JSON.stringify([item.provider,item.base_url,item.model]);
const apiItems=computed(()=>options.value.map(item=>({title:item.name,value:identity(item.config)})));
const selectedApi=computed({get:()=>config.value?identity(config.value):'',set:(value:string)=>{const item=options.value.find(item=>identity(item.config)===value);if(item)setApi(item.config);}});
const efforts=computed(()=>agentModels.value.find(item=>item.slug===model.value)?.supported_reasoning_levels.map(item=>item.effort)??[]);
const invalid=computed(()=>loading.value||!draft.value||!prompt.value.trim()||(!isPlan.value&&(backend.value==='api'?!config.value||maxTokens.value!==''&&(!Number.isSafeInteger(Number(maxTokens.value))||Number(maxTokens.value)<1):!model.value.trim()||!effort.value.trim())));
function setApi(value:ModelApiConfig|null|undefined){config.value=value?{...value}:null;maxTokens.value=value?.max_tokens??'';thinking.value=value?.enable_thinking===undefined?'default':value.enable_thinking?'enabled':'disabled';if(value&&!options.value.some(item=>identity(item.config)===identity(value)))options.value=[{name:`${value.model}（已保存）`,config:value},...options.value];}
function apply(settings:Settings){backend.value=settings.redaction.provider;prompt.value=settings.redaction.prompt;model.value=settings.redaction.model??'';effort.value=settings.redaction.reasoning_effort??'medium';setApi(settings.redaction.api);}
async function load(){
 try{loading.value=true;error.value='';const [pkg,catalog,agents]=await Promise.all([api<Package>('/material-library/processing-settings'),api<{models:{name:string;config:ModelApiConfig}[]}>('/llm-api/models'),api<{model_options:typeof agentModels.value}>('/agent/config')]);draft.value=pkg;options.value=catalog.models;agentModels.value=agents.model_options;templates.value=libraryRedactionTemplates(pkg.processing_settings);templateId.value=defaultLibraryRedactionTemplateId(templates.value);if(currentTemplate.value)apply({redaction:currentTemplate.value.redaction} as Settings);}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取共用处理设置失败';}finally{loading.value=false;}
}
async function defaults(){
 try{busy.value=true;error.value='';const settings=await api<Settings>('/material-library/processing-defaults');if(draft.value)draft.value={...draft.value,processing_settings:{...settings,redaction_templates:draft.value.processing_settings.redaction_templates}};const mask=templates.value.find(t=>t.id==='mask');if(mask)mask.redaction=settings.redaction;if(templateId.value==='mask')apply(settings);}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取系统默认失败';}finally{busy.value=false;}
}
async function save(){
 if(invalid.value||busy.value||!draft.value)return;
 try{busy.value=true;error.value='';commitTemplate();const redaction=templates.value.find(t=>t.id==='mask')!.redaction;
  await api('/material-library/processing-settings',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':String(draft.value.lock_version)},body:JSON.stringify({...draft.value.processing_settings,redaction,redaction_templates:templates.value.filter(t=>t.id!=='mask')})});emit('saved');emit('close');
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存共用处理设置失败';}finally{busy.value=false;}
}
onMounted(load);
</script>
<template><v-form class="surface-card p-20 max-h-[85vh] overflow-y-auto" @submit.prevent="save"><Column :gap="16">
 <Row x="between" y="center"><h2 class="section-title">共用处理设置</h2><v-btn :disabled="busy" @click="emit('close')">关闭</v-btn></Row>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert><p v-if="loading" class="text-muted">正在读取设置…</p>
 <template v-if="draft"><p class="text-sm text-muted">所有材料包的新任务共用这份设置。已派发任务、历史结果和题目快照保留原配置。金额和日期保留。</p>
 <Row :gap="8"><v-select :model-value="templateId" label="编辑脱敏模板" :items="templates.map(t=>({title:t.name,value:t.id}))" @update:model-value="selectTemplate"/><v-btn :disabled="busy" @click="addTemplate">新增模板</v-btn></Row>
 <template v-if="currentTemplate&&templateId!=='mask'"><v-text-field v-model="currentTemplate.name" label="模板名称"/><v-select :model-value="currentTemplate.workflow" label="处理流程" :items="[{title:'字段映射队列',value:'field_mapping'},{title:'Codex整包审阅计划',value:'codex_plan'}]" @update:model-value="changeWorkflow"/></template>
 <v-alert v-if="isPlan" type="info" density="compact">保存到共用配置数据库；每次派发读取并冻结本次提示词。默认Agent整包脱敏，模型沿用系统Agent设置，最多执行10分钟。私有主体表用于固定化名，法院名称保留。</v-alert>
 <v-select v-if="!isPlan" v-model="backend" label="脱敏执行方式" :items="[{title:'大模型 API',value:'api'},{title:'本地 Codex Agent',value:'codex'}]" :disabled="busy"/>
 <template v-if="!isPlan&&backend==='api'"><v-select v-model="selectedApi" label="脱敏模型" :items="apiItems" :disabled="busy"/><v-text-field v-model="maxTokens" label="最大输出 token（留空使用模型默认）" type="number" :disabled="busy"/><v-select v-if="config&&['qwen','openrouter'].includes(config.provider)" v-model="thinking" label="思考模式" :items="[{title:'模型默认',value:'default'},{title:'关闭',value:'disabled'},{title:'开启',value:'enabled'}]" :disabled="busy"/></template>
 <template v-else-if="!isPlan"><v-combobox v-model="model" label="Agent 模型" :items="agentModels.map(item=>item.slug)" :return-object="false" :disabled="busy"/><v-combobox v-model="effort" label="推理强度" :items="efforts" :return-object="false" :disabled="busy"/></template>
 <v-textarea v-model="prompt" label="脱敏提示词" rows="8" :disabled="busy"/>
 </template><Row x="end" wrap :gap="8"><v-btn :disabled="busy||loading" @click="defaults">恢复系统默认到草稿</v-btn><v-btn color="primary" type="submit" :loading="busy" :disabled="busy||invalid">保存设置</v-btn></Row>
</Column></v-form></template>
