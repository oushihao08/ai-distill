<!-- 文件职责：在项目目录首页维护脱敏、出题、模型作答和独立评分的系统默认提示词；仅新建项目复制这些值。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {AUTHORING_FIXED_PROMPT} from '@shared/step-prompts';
type PromptKey='4'|'5'|'6'|'9';
type PromptSet=Record<PromptKey,string>;
const labels:Record<PromptKey,string>={'9':'脱敏','4':'出题','5':'模型作答','6':'独立评分'};
const order:PromptKey[]=['4','5','6'];
const prompts=shallowRef<PromptSet>({'4':'','5':'','6':'','9':''});
const saved=shallowRef<PromptSet>({'4':'','5':'','6':'','9':''});
const authoringDefaults=ref({model:'gpt-6.1-sol',reasoning_effort:'low'});
const savedAuthoring=shallowRef('');
const selected=shallowRef<PromptKey>('4');
const open=shallowRef(false),loading=shallowRef(false),busy=shallowRef(false),error=shallowRef('');
const dirty=computed(()=>order.some(key=>prompts.value[key]!==saved.value[key])||JSON.stringify(authoringDefaults.value)!==savedAuthoring.value);
async function show(){
 try{loading.value=true;error.value='';const result=await api<{prompts:PromptSet;authoring_defaults:{model:string;reasoning_effort:string}}>('/system/step-prompts');authoringDefaults.value={...result.authoring_defaults};savedAuthoring.value=JSON.stringify(authoringDefaults.value);prompts.value={...result.prompts};saved.value={...result.prompts};open.value=true;}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取系统提示词失败';open.value=true;}
 finally{loading.value=false;}
}
async function save(){
 try{busy.value=true;error.value='';const result=await api<{prompts:PromptSet}>('/system/step-prompts',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompts:prompts.value,authoring_defaults:authoringDefaults.value})});prompts.value={...result.prompts};saved.value={...result.prompts};savedAuthoring.value=JSON.stringify(authoringDefaults.value);}
 catch(cause){error.value=cause instanceof Error?cause.message:'保存系统提示词失败';}
 finally{busy.value=false;}
}
</script>
<template>
 <v-btn color="secondary" variant="outlined" :loading="loading" :disabled="loading" @click="show">系统提示词配置</v-btn>
 <v-dialog v-model="open" max-width="1000" scrollable>
  <v-card class="surface-card max-h-[90vh] overflow-hidden">
   <v-card-title class="p-20 pb-8"><Row x="between" y="center"><Column :gap="4"><h2 class="section-title">系统级提示词</h2><p class="text-xs text-muted">固定通用出题规则随新派发生效；本页可配置的步骤默认提示词只用于新建项目，不回写已有项目。</p></Column><v-btn icon="$close" variant="text" aria-label="关闭系统提示词配置" :disabled="busy" @click="open=false" /></Row></v-card-title>
   <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
    <Column :gap="16">
     <v-tabs v-model="selected" color="primary"><v-tab v-for="key in order" :key="key" :value="key">{{ labels[key] }}</v-tab></v-tabs>
     <v-window v-model="selected"><v-window-item v-for="key in order" :key="key" :value="key">
      <Column v-if="key==='4'" :gap="8" class="mb-12 rounded border border-line-subtle p-12"><strong class="text-sm">系统固定通用出题规则</strong><pre class="max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-xs">{{ AUTHORING_FIXED_PROMPT }}</pre></Column>
      <Row v-if="key==='4'" :gap="12"><v-text-field v-model="authoringDefaults.model" label="新期出题默认模型" :disabled="busy||loading"/><v-select v-model="authoringDefaults.reasoning_effort" label="新期出题推理强度" :items="['none','minimal','low','medium','high','xhigh','max','ultra']" :disabled="busy||loading"/></Row>
      <v-textarea v-model="prompts[key]" :label="key==='4'?'新项目出题默认要求（可定制）':`${labels[key]}系统提示词`" rows="20" no-resize maxlength="12000" counter="12000" :disabled="busy||loading" />
     </v-window-item></v-window>
     <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
    </Column>
   </v-card-text>
   <v-card-actions class="p-20 pt-8"><Row x="end" :gap="8" class="w-full"><v-btn :disabled="busy" @click="open=false">关闭</v-btn><v-btn color="primary" variant="flat" :loading="busy" :disabled="busy||loading||!dirty||order.some(key=>!prompts[key].trim())" @click="save">保存系统默认</v-btn></Row></v-card-actions>
  </v-card>
 </v-dialog>
</template>
