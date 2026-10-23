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
const prompt=shallowRef('');
const busy=shallowRef(false),loading=shallowRef(true),error=shallowRef('');
const invalid=computed(()=>loading.value||!draft.value||!prompt.value.trim()||!currentTemplate.value?.name.trim());
function commitTemplate(){if(currentTemplate.value)currentTemplate.value.redaction={provider:'codex',prompt:prompt.value};}
function selectTemplate(id:string){commitTemplate();templateId.value=id;prompt.value=currentTemplate.value?.redaction.prompt??'';}
function addTemplate(){
 commitTemplate();
 const template:LibraryRedactionTemplate={id:`template-${Date.now()}`,name:'新化名模板',workflow:'codex_plan',redaction:{provider:'codex',prompt:prompt.value}};
 templates.value.push(template);templateId.value=template.id;
}
async function load(){
 try{loading.value=true;error.value='';const pkg=await api<Package>('/material-library/processing-settings');draft.value=pkg;templates.value=libraryRedactionTemplates(pkg.processing_settings);templateId.value=defaultLibraryRedactionTemplateId(templates.value);prompt.value=currentTemplate.value?.redaction.prompt??'';}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取共用处理设置失败';}finally{loading.value=false;}
}
async function defaults(){
 try{busy.value=true;error.value='';const settings=await api<Settings>('/material-library/processing-defaults');const defaults=libraryRedactionTemplates(settings);prompt.value=defaults.find(t=>t.id==='aliases')?.redaction.prompt??'';}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取系统默认失败';}finally{busy.value=false;}
}
async function save(){
 if(invalid.value||busy.value||!draft.value)return;
 try{busy.value=true;error.value='';commitTemplate();
  await api('/material-library/processing-settings',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':String(draft.value.lock_version)},body:JSON.stringify({...draft.value.processing_settings,redaction_templates:templates.value})});emit('saved');emit('close');
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存共用处理设置失败';}finally{busy.value=false;}
}
onMounted(load);
</script>
<template><v-form class="surface-card p-20 max-h-[85vh] overflow-y-auto" @submit.prevent="save"><Column :gap="16">
 <Row x="between" y="center"><h2 class="section-title">共用处理设置</h2><v-btn :disabled="busy" @click="emit('close')">关闭</v-btn></Row>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert><p v-if="loading" class="text-muted">正在读取设置…</p>
 <template v-if="draft"><p class="text-sm text-muted">所有材料包的新任务共用这份设置。已派发任务、历史结果和题目快照保留原配置。金额和日期保留。</p>
 <Row :gap="8"><v-select :model-value="templateId" label="编辑脱敏模板" :items="templates.map(t=>({title:t.name,value:t.id}))" @update:model-value="selectTemplate"/><v-btn :disabled="busy" @click="addTemplate">新增模板</v-btn></Row>
 <v-text-field v-if="currentTemplate" v-model="currentTemplate.name" label="模板名称" :disabled="busy"/>
 <v-alert type="info" density="compact">新脱敏任务统一使用Agent整包化名。模型沿用系统Agent设置，最多执行10分钟；私有主体表固定化名，法院名称保留。历史结果与题目快照不改写。</v-alert>
 <v-textarea v-model="prompt" label="脱敏提示词" rows="8" auto-grow :disabled="busy"/>
 </template><Row x="end" wrap :gap="8"><v-btn :disabled="busy||loading" @click="defaults">恢复系统默认到草稿</v-btn><v-btn color="primary" type="submit" :loading="busy" :disabled="busy||invalid">保存设置</v-btn></Row>
</Column></v-form></template>
