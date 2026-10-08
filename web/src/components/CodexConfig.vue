<script setup lang="ts">
import {api} from '../api/client';

interface CodexConfig {credential_home:string|null}
interface CodexProbe {connected:boolean;model:string;duration_ms:number}
const path=shallowRef('');
const savedPath=shallowRef('');
const busy=shallowRef(false);
const loading=shallowRef(true);
const error=shallowRef('');
const probe=shallowRef<CodexProbe|null>(null);
const probeFailed=shallowRef(false);

async function load(){
 try{
  loading.value=true;error.value='';
  const config=await api<CodexConfig>('/codex/config');
  path.value=config.credential_home??'';savedPath.value=path.value;
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取Codex设置失败';}
 finally{loading.value=false;}
}
async function save(){
 try{
  busy.value=true;error.value='';probe.value=null;probeFailed.value=false;
  const config=await api<CodexConfig>('/codex/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:path.value.trim()||null})});
  path.value=config.credential_home??'';savedPath.value=path.value;
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存Codex设置失败';}
 finally{busy.value=false;}
}
function clearProbe(){probe.value=null;probeFailed.value=false;error.value='';}
async function test(){
 try{
  busy.value=true;error.value='';probe.value=null;probeFailed.value=false;
  const config=await api<CodexConfig>('/codex/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:path.value.trim()||null})});
  path.value=config.credential_home??'';savedPath.value=path.value;
  probe.value=await api<CodexProbe>('/codex/test',{method:'POST'});
 }catch(cause){probeFailed.value=true;error.value=cause instanceof Error?cause.message:'Codex连通性测试失败';}
 finally{busy.value=false;}
}
onMounted(load);
</script>

<template><section class="surface-card p-16"><Column :gap="12">
 <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">Codex 凭证</h2><p class="text-xs text-muted">路径保存在本地数据库；凭证文件内容不会上传或展示。</p></Column><v-chip v-if="probe" color="success" size="small">已连通</v-chip><v-chip v-else-if="probeFailed" color="error" size="small">测试失败</v-chip></Row>
 <v-text-field v-model="path" density="compact" variant="outlined" hide-details label="Codex凭证目录或 auth.json 路径" placeholder="留空使用当前运行环境默认凭证" :disabled="loading||busy" @update:model-value="clearProbe" />
 <p class="text-xs text-muted">接受绝对路径或 ~/ 开头路径；填写 auth.json 时自动取其所在目录。保存并测试会调用 gpt-6.1-sol 发起一次短请求。</p>
 <v-alert v-if="error" :type="probeFailed?'error':'warning'" density="compact">{{ error }}</v-alert>
 <p v-if="probe" class="text-sm text-success">连接正常 · {{ probe.model }} · {{ (probe.duration_ms/1000).toFixed(1) }} 秒</p>
 <Row x="between" wrap :gap="8"><span class="text-xs text-muted">{{ savedPath?'已配置自定义凭证目录':'使用运行环境默认凭证' }}</span><Row :gap="8"><v-btn size="small" :disabled="loading||busy||path===savedPath" @click="save">保存设置</v-btn><v-btn size="small" color="primary" variant="flat" :loading="busy" :disabled="loading||busy" @click="test">保存并测试</v-btn></Row></Row>
</Column></section></template>
