<!--
职责：把用户选择的项目目录按题目子目录分组并批量上传 PDF、DOCX、TXT 和 MD。
关键方法与用法：`selectDirectory()` 建立题目分组，`importFolders()` 并发上传并逐题更新状态；接收 `projectId`／`projectName`，通过 `imported`／`close` 通知项目详情页。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { fileSize } from '../utils/format';
const props = defineProps<{ projectId: string; projectName: string }>();
const emit = defineEmits<{ imported: []; close: [] }>();
type Folder = { key: string; files: File[]; bytes: number; status: string; error?: string };
const picker = useTemplateRef<HTMLInputElement>('picker');
const folders = shallowRef<Folder[]>([]);
const busy = shallowRef(false);
const error = shallowRef('');
const ignored = shallowRef(0);
const rootMaterialCount = shallowRef(0);
const finished = computed(() => folders.value.filter(folder => ['已创建', '已复用', '已更新'].includes(folder.status)).length);
function selectDirectory(event: Event) {
 error.value = ''; ignored.value = 0; rootMaterialCount.value = 0;
 const selected = Array.from((event.target as HTMLInputElement).files ?? []);
 const grouped = new Map<string, File[]>();
 for (const file of selected) {
  if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) { ignored.value += 1; continue; }
  const parts = file.webkitRelativePath.split('/');
  if (parts.length < 3) { rootMaterialCount.value += 1; continue; }
  const key = parts[1]!;
  grouped.set(key, [...(grouped.get(key) ?? []), file]);
 }
 folders.value = [...grouped].sort(([a], [b]) => a.localeCompare(b, 'zh-CN', { numeric: true })).map(([key, files]) => ({ key, files, bytes: files.reduce((sum, file) => sum + file.size, 0), status: '待导入' }));
 if (!folders.value.length) error.value = '未找到题目子目录中的材料。请选择包含“题目目录/材料”的项目目录。';
 else if (folders.value.length > 100) error.value = '一次最多导入100个题目目录，请分批选择。';
}
function updateFolder(key: string, patch: Partial<Folder>) {
 folders.value = folders.value.map(folder => folder.key === key ? { ...folder, ...patch } : folder);
}
async function importFolders() {
 busy.value = true; error.value = '';
 try {
  const pending = folders.value.filter(folder => ['待导入', '失败'].includes(folder.status));
  let next = 0;
  const upload = async () => {
   while (next < pending.length) {
    const folder = pending[next++]!;
    updateFolder(folder.key, { status: '导入中', error: undefined });
    try {
     const form = new FormData();
     form.append('title', `${props.projectName}-${folder.key}`);
     form.append('source_key', folder.key);
     for (const file of folder.files) form.append('files', file);
     const result = await api<{ id: string; reused?: boolean; updated?: boolean }>(`/projects/${props.projectId}/workflows`, { method: 'POST', body: form });
     updateFolder(folder.key, { status: result.reused ? '已复用' : result.updated ? '已更新' : '已创建' });
    } catch (failure) {
     updateFolder(folder.key, { status: '失败', error: failure instanceof Error ? failure.message : '导入失败' });
    }
   }
  };
  await Promise.all([upload(), upload()]);
  emit('imported');
 } catch (failure) { error.value = failure instanceof Error ? failure.message : '目录导入失败'; }
 finally { busy.value = false; }
}
</script>
<template>
 <Column class="surface-card p-24" :gap="16">
  <Row x="between"><h2 class="section-title">按题目目录导入</h2><v-btn icon="$close" variant="text" aria-label="关闭目录导入" :disabled="busy" @click="emit('close')" /></Row>
  <p class="text-sm text-muted">选择项目目录，每个直接子目录建立一条工作流，目录内的 PDF、DOCX、TXT、MD 归入同一题目。再次导入时比较文件指纹；未变化则复用，变化则更新附件并重新处理。</p>
  <input ref="picker" type="file" webkitdirectory multiple class="hidden" :disabled="busy" @change="selectDirectory" />
  <Row wrap :gap="8"><v-btn color="secondary" :disabled="busy" @click="picker?.click()">选择项目目录</v-btn><span class="text-sm text-muted">{{ folders.length }} 个题目目录 · 已完成 {{ finished }}</span></Row>
  <v-alert v-if="ignored || rootMaterialCount" type="info" density="compact">已忽略 {{ ignored }} 个不支持的文件。{{ rootMaterialCount ? `项目根目录另有 ${rootMaterialCount} 份材料，请先放入对应题目子目录再导入。` : '' }}</v-alert>
  <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
  <Column class="max-h-320 overflow-auto" :gap="8">
   <Column v-for="folder in folders" :key="folder.key" class="border-t border-line-subtle pt-8" :gap="4">
    <Row x="between" wrap><span class="font-medium text-sm break-all">{{ folder.key }}</span><span class="text-xs text-muted">{{ folder.files.length }} 份材料 · {{ fileSize(folder.bytes) }} · {{ folder.status }}</span></Row>
    <p v-if="folder.error" class="text-sm text-danger">{{ folder.error }}</p>
   </Column>
  </Column>
  <Row x="end" :gap="8"><v-btn color="secondary" :disabled="busy" @click="emit('close')">关闭</v-btn><v-btn color="primary" variant="flat" :loading="busy" :disabled="busy || !!error || !folders.length || finished === folders.length" @click="importFolders">导入目录 / 重试失败项</v-btn></Row>
 </Column>
</template>
