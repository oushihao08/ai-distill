<!--
职责：创建单题工作流并上传该题的 PDF 材料包。
关键方法与用法：`submit()` 校验名称和文件后提交幂等请求；接收 `projectId`，成功发出 `uploaded` 工作流 ID，供项目详情页跳转或刷新。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { fileSize } from '../utils/format';
const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ uploaded: [id: string]; close: [] }>();
const title = shallowRef(''); const files = shallowRef<File[]>([]); const busy = shallowRef(false); const error = shallowRef('');
let requestId = crypto.randomUUID();
watch(files, () => { requestId = crypto.randomUUID(); });
watch(title, () => { requestId = crypto.randomUUID(); });
async function submit() {
 if (busy.value) return;
 busy.value = true; error.value = '';
 try {
  const form = new FormData(); form.append('title', title.value); for (const file of files.value) form.append('files', file);
  const result = await api<{ id: string }>(`/projects/${props.projectId}/workflows`, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: form });
  emit('uploaded', result.id);
 } catch (cause) { error.value = cause instanceof Error ? cause.message : '上传失败'; }
 finally { busy.value = false; }
}
</script>
<template>
 <v-form class="surface-card p-24" @submit.prevent="submit"><Column :gap="16">
  <Row x="between" wrap><h2 class="section-title">上传材料包</h2><v-btn icon="$close" variant="text" aria-label="关闭上传材料" :disabled="busy" @click="emit('close')" /></Row>
  <p class="text-sm text-muted">将同一案件的相关 PDF 放在一个材料包中，上传后建立一条工作流。</p>
  <v-text-field v-model="title" label="材料包名称" required maxlength="180" :disabled="busy" placeholder="例如：房屋买卖案 · 卷宗1与卷宗2" />
  <v-file-input v-model="files" label="选择 PDF 文件" accept=".pdf,application/pdf" multiple chips show-size clearable :disabled="busy" variant="outlined" density="compact" hide-details="auto" hint="最多100份，单文件50MB，材料包总计100MB。" persistent-hint />
  <ul v-if="files.length" class="m-0 pl-20 text-sm"><li v-for="(file,index) in files" :key="index" class="break-all">{{ file.name }} · {{ fileSize(file.size) }}</li></ul>
  <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
  <Row x="end"><v-btn color="secondary" :disabled="busy" @click="emit('close')">取消</v-btn><v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy || !files.length || !title.trim()">保存并创建工作流</v-btn></Row>
 </Column></v-form>
</template>
