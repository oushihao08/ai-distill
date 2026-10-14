<!--
职责：在材料包详情中选择成功脱敏版本并创建独立题目。
Props：packageId 指定材料包、projectTags 指定本期可选标签；事件：created 返回新题目 ID，供父页面刷新或导航。
-->
<script setup lang="ts">
import {api} from '../api/client';
const props=defineProps<{packageId:string;projectTags:string[]}>();
const emit=defineEmits<{created:[id:string]}>();
type Version={id:string;attempt:number;finished_at:string;redacted_sha256:string};
const versions=shallowRef<Version[]>([]),versionId=shallowRef(''),title=shallowRef(''),scenario=shallowRef(''),role=shallowRef(''),tags=shallowRef<string[]>([]),direction=shallowRef(''),busy=shallowRef(false),error=shallowRef('');
async function load(){try{error.value='';versions.value=await api<Version[]>(`/material-packages/${props.packageId}/versions`);versionId.value=versions.value[0]?.id??'';}catch(cause){error.value=cause instanceof Error?cause.message:'读取脱敏版本失败';}}
async function create(){
 if(!versionId.value||!title.value.trim())return;
 try{
  busy.value=true;error.value='';
  const result=await api<{id:string}>(`/material-packages/${props.packageId}/questions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title.value.trim(),redaction_attempt_id:versionId.value,scenario:scenario.value.trim()||null,role_perspective:role.value.trim()||null,question_tags:tags.value,authoring_direction:direction.value.trim()||null})});
  emit('created',result.id);
 }catch(cause){error.value=cause instanceof Error?cause.message:'创建题目失败';}finally{busy.value=false;}
}
onMounted(load);
</script>
<template><Column class="surface-card p-16" :gap="12">
 <Row x="between" y="center"><h2 class="section-title">从材料包创建题目</h2><v-btn variant="text" :disabled="busy" @click="load">刷新版本</v-btn></Row>
 <p class="text-sm text-muted">每题固定所选的整包脱敏结果。新题不会重新入库或脱敏；后续补充材料不会改变已建题目。</p>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <p v-if="!versions.length" class="text-sm text-muted">暂无可用的成功脱敏版本。请先完成材料包的入库和脱敏。</p>
 <template v-else>
  <v-select v-model="versionId" :items="versions.map(item=>({title:`第 ${item.attempt} 次脱敏 · ${new Date(item.finished_at).toLocaleString()} · ${item.redacted_sha256.slice(0,12)}`,value:item.id}))" label="材料版本" :disabled="busy" />
  <v-text-field v-model="title" label="题目名称" :maxlength="180" :disabled="busy" />
  <Row stack-on-mobile :gap="8"><v-text-field v-model="scenario" label="场景（选填）" :maxlength="180" :disabled="busy" /><v-text-field v-model="role" label="角色视角（选填）" :maxlength="180" :disabled="busy" /></Row>
  <v-select v-model="tags" :items="projectTags" label="本期出题标签（选填）" multiple chips closable-chips clearable :disabled="busy||!projectTags.length" :hint="projectTags.length?'每道题可选择多个标签；标签在项目编辑中维护。':'本期尚无标签；可先在项目编辑中创建。'" persistent-hint />
  <v-textarea v-model="direction" label="出题方向（选填）" :maxlength="4000" rows="3" auto-grow :disabled="busy" />
  <p class="text-xs text-muted">场景、角色和标签是本题创建时的出题设计输入。</p>
  <Row x="end"><v-btn color="primary" variant="flat" :loading="busy" :disabled="busy||!title.trim()||!versionId" @click="create">创建题目</v-btn></Row>
 </template>
</Column></template>
