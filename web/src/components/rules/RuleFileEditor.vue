<!--
职责：读取、编辑或上传规则材料文件，并按指纹防止覆盖并发修改。
关键方法与用法：`load()` 读取文件与 SHA-256，`save()` 按文字或文件模式提交预期指纹；仅允许编辑 materials，skill 只读，保存后向 `ProjectRules` 发出事件。
-->

<script setup lang="ts">
import { api } from '@/api/client';
import type { RuleFile } from '@/types/api';
const props=defineProps<{projectId:string;file:RuleFile|null}>();
const emit=defineEmits<{saved:[];close:[]}>();
const path=shallowRef(props.file?.path??'');const content=shallowRef('');const mode=shallowRef('text');
const uploaded=shallowRef<File[]>([]);const busy=shallowRef(false);const loading=shallowRef(false);const error=shallowRef('');
const source=shallowRef<(RuleFile&{text:string|null;editable:boolean})|null>(null);
const material=computed(()=>!props.file||props.file.path.startsWith('materials/'));
const readable=computed(()=>!props.file||source.value?.text!==null);
const canEditText=computed(()=>!props.file||source.value?.editable===true);
const ready=computed(()=>!busy.value&&!loading.value&&material.value&&(!props.file||source.value!==null)&&(mode.value==='file'?uploaded.value.length===1:canEditText.value&&content.value.trim().length>0)&&(!props.file?path.value.trim().length>0||mode.value==='file':true));
const download=computed(()=>`/api/projects/${props.projectId}/rules/file?download=1&path=${encodeURIComponent(props.file?.path??'')}`);
const controller=new AbortController();
async function load(){
 if(!props.file)return;
 try{loading.value=true;source.value=await api(`/projects/${props.projectId}/rules/file?path=${encodeURIComponent(props.file.path)}`,{signal:controller.signal});content.value=source.value!.text??'';if(!source.value!.editable&&material.value)mode.value='file';}
 catch(cause){if(!controller.signal.aborted)error.value=cause instanceof Error?cause.message:'读取失败';}finally{loading.value=false;}
}
async function save(){
 if(!ready.value)return;
 try{
  busy.value=true;error.value='';const expected=source.value?.sha256??null;
  if(mode.value==='file'){
   const file=uploaded.value[0]!;const form=new FormData();form.append('file',file);form.append('path',path.value.trim()||`materials/${file.name}`);if(expected)form.append('expected_sha256',expected);
   await api(`/projects/${props.projectId}/rules/file`,{method:'POST',body:form});
  }else await api(`/projects/${props.projectId}/rules/file`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:path.value.trim(),text:content.value,expected_sha256:expected})});
  emit('saved');
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存失败，请重新读取当前文件';}finally{busy.value=false;}
}
onMounted(load);onUnmounted(()=>controller.abort());
</script>
<template><v-form class="surface-card p-20" @submit.prevent="save"><Column :gap="16">
 <Row x="between" :gap="8"><h2 class="section-title">{{ file?'查看资料':'增加规则资料' }}</h2><v-btn icon="$close" aria-label="关闭资料" variant="text" :disabled="busy" @click="emit('close')" /></Row>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert><p v-if="loading" class="text-sm text-muted">正在读取文件…</p>
 <v-text-field v-model="path" label="相对路径，例如 materials/评分规则.md" :readonly="!!file" :disabled="busy" hide-details />
 <v-tabs v-if="material" v-model="mode" color="primary"><v-tab value="text" :disabled="!!file&&!canEditText">文字编辑</v-tab><v-tab value="file">{{ file?'替换文件':'上传文件' }}</v-tab></v-tabs>
 <v-textarea v-if="mode==='text'&&readable&&!loading" v-model="content" :readonly="!canEditText" :disabled="busy" :rows="15" label="文件正文" hide-details class="font-mono text-sm" />
 <Column v-else-if="mode==='file'&&material" :gap="8"><v-file-input v-model="uploaded" label="选择一份文件（最大30MB）" accept=".md,.txt,.json,.csv,.docx,.xlsx,.pdf,.png,.jpg,.jpeg,.html" multiple chips :disabled="busy||loading" /><p class="text-xs text-muted">文件原样保存，不在此处识别或脱敏。</p></Column>
 <p v-else-if="!loading" class="text-sm text-muted">二进制或较大的文件请下载查看。</p>
 <Row x="between" wrap :gap="8"><a v-if="file&&source" :href="download" class="link-text text-sm">下载原文件</a><span v-else /><Row :gap="8"><v-btn :disabled="busy" @click="emit('close')">关闭</v-btn><v-btn v-if="material" type="submit" color="primary" variant="flat" :loading="busy" :disabled="!ready">保存资料</v-btn></Row></Row>
</Column></v-form></template>
