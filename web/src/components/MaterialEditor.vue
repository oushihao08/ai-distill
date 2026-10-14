<!--
职责：为单题工作流新增 PDF、DOCX、TXT、MD 或替换指定附件。
关键方法与用法：`save()` 以 FormData 提交当前文件；接收 `workflowId` 和可选替换信息，成功时发出 `saved`／`close` 事件供工作流详情页刷新。
-->

<script setup lang="ts">
import { api } from '../api/client';
const props=defineProps<{workflowId:string;replaceId?:string;replaceName?:string}>();
const emit=defineEmits<{saved:[];close:[]}>();
const files=shallowRef<File[]>([]);const busy=shallowRef(false);const error=shallowRef('');
async function save(){
 try{
  busy.value=true;error.value='';const form=new FormData();for(const file of files.value)form.append('files',file);if(props.replaceId)form.append('replace_id',props.replaceId);
  await api(`/workflows/${props.workflowId}/materials`,{method:'POST',body:form});emit('saved');emit('close');
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存失败';}finally{busy.value=false;}
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="save"><Column :gap="16"><Row x="between"><h2 class="section-title">{{ replaceId?'替换材料':'增加材料' }}</h2><v-btn icon="$close" aria-label="关闭材料编辑" variant="text" :disabled="busy" @click="emit('close')" /></Row><p v-if="replaceName" class="text-sm text-muted break-all">替换：{{ replaceName }}</p><p class="text-xs text-muted">支持 PDF、DOCX、TXT、MD；单文件最大 50MB，单题材料总量最多 100MB。材料变化会使后续结果失效，本地来源文件夹中的原件不修改。</p><v-file-input v-model="files" accept=".pdf,.docx,.txt,.md" :label="replaceId?'选择一份替换材料':'选择材料'" multiple chips :disabled="busy" /><v-alert v-if="error" type="error">{{ error }}</v-alert><Row x="end" :gap="8"><v-btn :disabled="busy" @click="emit('close')">取消</v-btn><v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy||!files.length||(!!replaceId&&files.length!==1)">保存材料</v-btn></Row></Column></v-form></template>
