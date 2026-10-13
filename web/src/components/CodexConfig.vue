<!--
职责：配置全局 Codex 凭证目录、模型和推理强度。
关键方法与用法：`load()` 读取目录与设置，`save()` 保存选择，`test()` 探测连接；在项目列表页作为工作区级设置面板使用。
-->

<script setup lang="ts">
import {api} from '../api/client';

interface CodexModelOption {slug:string;supported_reasoning_levels:{effort:string}[]}
interface CodexConfig {credential_home:string|null;model:string;reasoning_effort:string;model_options:CodexModelOption[]}
interface CodexProbe {connected:boolean;model:string;reasoning_effort:string;duration_ms:number}
const path=shallowRef('');
const savedPath=shallowRef('');
const model=shallowRef('gpt-6.1-sol');
const savedModel=shallowRef('gpt-6.1-sol');
const effort=shallowRef('medium');
const savedEffort=shallowRef('medium');
const availableModels=shallowRef<CodexModelOption[]>([]);
const busy=shallowRef(false);
const loading=shallowRef(true);
const error=shallowRef('');
const probe=shallowRef<CodexProbe|null>(null);
const probeFailed=shallowRef(false);
const modelItems=computed(()=>availableModels.value.map(item=>({title:item.slug,value:item.slug})));
const effortItems=computed(()=>availableModels.value.find(item=>item.slug===model.value)?.supported_reasoning_levels.map(level=>level.effort)??[]);
const canSaveDefaults=computed(()=>Boolean((model.value??'').trim()&&(effort.value??'').trim()));
watch(model,clearProbe);watch(effort,clearProbe);
const changed=computed(()=>path.value!==savedPath.value||model.value!==savedModel.value||effort.value!==savedEffort.value);

function applyConfig(config:CodexConfig){
 path.value=config.credential_home??'';savedPath.value=path.value;
 availableModels.value=config.model_options??[];
 model.value=config.model??'';
 savedModel.value=model.value;
 effort.value=config.reasoning_effort??'';
 savedEffort.value=effort.value;
}
function requestBody(){
 return{credential_home:path.value.trim()||null,...(canSaveDefaults.value?{model:model.value,reasoning_effort:effort.value}:{})};
}

async function load(){
 try{
  loading.value=true;error.value='';
  const config=await api<CodexConfig>('/agent/config');
  applyConfig(config);
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取Codex设置失败';}
 finally{loading.value=false;}
}
async function save(){
 try{
  busy.value=true;error.value='';probe.value=null;probeFailed.value=false;
  const config=await api<CodexConfig>('/agent/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody())});
  applyConfig(config);
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存Codex设置失败';}
 finally{busy.value=false;}
}
function clearProbe(){probe.value=null;probeFailed.value=false;error.value='';}
async function test(){
 try{
  busy.value=true;error.value='';probe.value=null;probeFailed.value=false;
  const config=await api<CodexConfig>('/agent/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody())});
  applyConfig(config);
  probe.value=await api<CodexProbe>('/agent/test',{method:'POST'});
 }catch(cause){probeFailed.value=true;error.value=cause instanceof Error?cause.message:'Codex连通性测试失败';}
 finally{busy.value=false;}
}
onMounted(load);
</script>

<template><section class="surface-card p-16"><Column :gap="12">
 <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">Codex 凭证</h2><p class="text-xs text-muted">路径保存在本地数据库；凭证文件内容不会上传或展示。</p></Column><v-chip v-if="probe" color="success" size="small">已连通</v-chip><v-chip v-else-if="probeFailed" color="error" size="small">测试失败</v-chip></Row>
 <v-text-field v-model="path" density="compact" variant="outlined" hide-details label="Codex凭证目录或 auth.json 路径" placeholder="留空使用当前运行环境默认凭证" :disabled="loading||busy" @update:model-value="clearProbe" />
 <p class="text-xs text-muted">接受绝对路径或 ~/ 开头路径；填写 auth.json 时自动取其所在目录。</p>
 <Column class="border-t border-line-subtle pt-12" :gap="8">
  <Column :gap="4"><h3 class="text-sm font-semibold">默认 Codex 模型</h3><p class="text-xs text-muted">仅作为未单独设置模型的后续任务默认值；项目步骤自定义设置和已入队任务保持不变。</p></Column>
  <Row wrap :gap="12"><v-combobox :return-object="false" v-model="model" label="默认模型" :items="modelItems" hide-details :disabled="loading||busy" @update:model-value="clearProbe" /><v-combobox :return-object="false" v-model="effort" label="默认推理强度" :items="effortItems" hide-details :disabled="loading||busy" @update:model-value="clearProbe" /></Row>
  <p v-if="!loading&&!modelItems.length" class="text-xs text-warning">本机模型建议暂不可用，可直接输入模型和推理强度；实际可用性由执行时反馈。</p>
 </Column>
 <v-alert v-if="error" :type="probeFailed?'error':'warning'" density="compact">{{ error }}</v-alert>
 <p v-if="probe" class="text-sm text-success">连接正常 · {{ probe.model }} · 推理 {{ probe.reasoning_effort }} · {{ (probe.duration_ms/1000).toFixed(1) }} 秒</p>
 <Row x="between" wrap :gap="8"><span class="text-xs text-muted">{{ savedPath?'已配置自定义凭证目录':'使用运行环境默认凭证' }}</span><Row :gap="8"><v-btn size="small" :disabled="loading||busy||!changed||!canSaveDefaults" @click="save">保存设置</v-btn><v-btn size="small" color="primary" variant="flat" :loading="busy" :disabled="loading||busy||!canSaveDefaults" @click="test">保存并测试</v-btn></Row></Row>
</Column></section></template>
