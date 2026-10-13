<!--
职责：管理项目级 Codex 默认模型和推理强度，并可恢复继承全局设置。
关键方法与用法：`load()` 读取项目设置与模型能力，`save()` 写入覆盖，`inherit()` 删除项目覆盖；项目详情页以 `projectId` 加载此面板。
-->

<script setup lang="ts">
import {api} from '../api/client';
interface ModelOption {slug:string;supported_reasoning_levels:{effort:string}[]}
interface Settings {model:string;reasoning_effort:string;source:'project'|'system'}
const props=defineProps<{projectId:string}>();
const model=shallowRef(''),effort=shallowRef(''),source=shallowRef<'project'|'system'>('system');
const options=shallowRef<ModelOption[]>([]),loading=shallowRef(true),busy=shallowRef(false),error=shallowRef('');
const modelItems=computed(()=>options.value.map(item=>({title:item.slug,value:item.slug})));
const effortItems=computed(()=>options.value.find(item=>item.slug===model.value)?.supported_reasoning_levels.map(level=>level.effort)??[]);
const canSave=computed(()=>Boolean((model.value??'').trim()&&(effort.value??'').trim()));
function apply(settings:Settings){model.value=settings.model;effort.value=settings.reasoning_effort;source.value=settings.source;}
async function load(){
 try{loading.value=true;error.value='';const [catalog,settings]=await Promise.all([api<{model_options:ModelOption[]}>('/agent/config'),api<Settings>(`/projects/${props.projectId}/agent-settings`)]);options.value=catalog.model_options??[];apply(settings);}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取项目Codex设置失败';}finally{loading.value=false;}
}
async function save(){
 try{busy.value=true;error.value='';apply(await api<Settings>(`/projects/${props.projectId}/agent-settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model.value,reasoning_effort:effort.value})}));}
 catch(cause){error.value=cause instanceof Error?cause.message:'保存项目Codex设置失败';}finally{busy.value=false;}
}
async function inherit(){
 try{busy.value=true;error.value='';apply(await api<Settings>(`/projects/${props.projectId}/agent-settings`,{method:'DELETE'}));}
 catch(cause){error.value=cause instanceof Error?cause.message:'恢复全局默认失败';}finally{busy.value=false;}
}
onMounted(load);
</script>
<template><section class="surface-card p-16"><Column :gap="10">
 <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">项目 Codex 默认</h2><p class="text-xs text-muted">项目默认用于本项目的 Codex 步骤；步骤单独设置优先级更高。</p></Column><v-chip size="small" :color="source==='project'?'primary':'secondary'">{{ source==='project'?'项目默认':'跟随全局默认' }}</v-chip></Row>
 <Row wrap :gap="10"><v-combobox :return-object="false" v-model="model" label="默认模型" :items="modelItems" :loading="loading" :disabled="loading||busy" /><v-combobox :return-object="false" v-model="effort" label="默认推理强度" :items="effortItems" :disabled="loading||busy" /><v-btn color="primary" variant="flat" :loading="busy" :disabled="loading||busy||!canSave" @click="save">保存项目默认</v-btn><v-btn v-if="source==='project'" :disabled="busy" @click="inherit">恢复全局默认</v-btn></Row>
 <p v-if="!loading&&!modelItems.length" class="text-xs text-warning">本机模型建议暂不可用，可直接输入模型和推理强度；实际可用性由执行时反馈。</p><v-alert v-if="error" type="error">{{ error }}</v-alert>
</Column></section></template>
