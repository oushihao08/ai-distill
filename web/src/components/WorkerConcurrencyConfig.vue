<!--
职责：编辑系统级 Agent 与大模型 API worker 并发上限。
关键方法与用法：`load()` 读取已保存及当前生效设置，`save()` 将安全范围内的上限写入本地并发配置库。
使用场景：由系统设置页承载；配置在 API 与 worker 重启后生效。
-->
<script setup lang="ts">
import {api} from '../api/client';

interface ConcurrencySettings {agent:number;llmApi:number}
interface ConcurrencyResponse {settings:ConcurrencySettings;active:ConcurrencySettings;limits:ConcurrencySettings}
const settings=ref<ConcurrencySettings>({agent:2,llmApi:8});
const active=ref<ConcurrencySettings>({agent:2,llmApi:8});
const limits=ref<ConcurrencySettings>({agent:10,llmApi:12});
const loading=shallowRef(true);
const saving=shallowRef(false);
const error=shallowRef('');
const saved=shallowRef(false);
const changed=computed(()=>settings.value.agent!==active.value.agent||settings.value.llmApi!==active.value.llmApi);
const agentOptions=computed(()=>Array.from({length:limits.value.agent},(_,index)=>index+1));
const apiOptions=computed(()=>Array.from({length:limits.value.llmApi},(_,index)=>index+1));

async function load(){
 try{
  loading.value=true;error.value='';
  const result=await api<ConcurrencyResponse>('/system/concurrency-settings');
  limits.value={...result.limits};
  settings.value={agent:Math.min(result.settings.agent,result.limits.agent),llmApi:Math.min(result.settings.llmApi,result.limits.llmApi)};
  active.value={...result.active};
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取并发设置失败';}
 finally{loading.value=false;}
}
async function save(){
 try{
  saving.value=true;error.value='';saved.value=false;
  const result=await api<ConcurrencyResponse & {restart_required:boolean}>('/system/concurrency-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings.value)});
  settings.value={...result.settings};active.value={...result.active};limits.value={...result.limits};saved.value=true;
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存并发设置失败';}
 finally{saving.value=false;}
}
onMounted(load);
</script>

<template><section class="surface-card p-16"><Column :gap="12">
 <Column :gap="4"><h2 class="section-title">Agent / API 并发</h2><p class="text-xs text-muted">设置所有项目共享的同时执行上限。Agent 覆盖出题、评分及 Agent 脱敏；API 覆盖模型作答及 API 脱敏。</p></Column>
 <Row wrap :gap="12"><v-select v-model="settings.agent" label="Agent 同时执行数" :items="agentOptions" hide-details :disabled="loading||saving" @update:model-value="saved=false" /><v-select v-model="settings.llmApi" label="API 同时执行数" :items="apiOptions" hide-details :disabled="loading||saving" @update:model-value="saved=false" /></Row>
 <p class="text-xs text-muted">可设置范围：Agent 1–{{ limits.agent }}，API 1–{{ limits.llmApi }}。请结合机器资源设置；降低设置不会中断正在运行的任务。</p>
 <v-alert v-if="changed" type="warning" density="compact">当前生效：Agent {{ active.agent }}、API {{ active.llmApi }}。保存后需重启 API 和 worker，之后的新任务才会使用新上限。</v-alert>
 <v-alert v-if="saved" type="success" density="compact">并发设置已保存。按提示重启 API 和 worker 后生效。</v-alert>
 <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
 <Row x="between" wrap :gap="8"><span class="text-xs text-muted">较低可用内存时，worker 会暂停领取新任务</span><v-btn size="small" color="primary" variant="flat" :loading="saving" :disabled="loading||saving||!changed" @click="save">保存并发设置</v-btn></Row>
</Column></section></template>
