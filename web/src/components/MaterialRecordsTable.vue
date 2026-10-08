<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel, fileSize } from '../utils/format';
import type { Material, MaterialTextDetail } from '../types/api';

const props = defineProps<{ workflowId: string; materials: Material[]; disabled?: boolean }>();
const emit = defineEmits<{ add: []; edit: [material: Material]; delete: [material: Material] }>();
const detailOpen = shallowRef(false);
const detailBusy = shallowRef(false);
const detailError = shallowRef('');
const selectedMaterial = shallowRef<Material>();
const detail = shallowRef<MaterialTextDetail>();
const showingRedacted = shallowRef(false);

function statusLabel(status: string) {
 if (status === 'received') return '原件已入库，待提取';
 if (status === 'text_extracted') return '全文已入库';
 if (status === 'redacted') return '已脱敏';
 return status;
}

async function viewFullText(material: Material) {
 if (detailBusy.value) return;
 selectedMaterial.value = material;
 detail.value = undefined;
 detailError.value = '';
 showingRedacted.value = false;
 detailOpen.value = true;
 try {
  detailBusy.value = true;
  detail.value = await api<MaterialTextDetail>(`/workflows/${props.workflowId}/materials/${material.id}/extracted-text`);
 } catch (cause) {
  detailError.value = cause instanceof Error ? cause.message : '读取附件全文失败';
 } finally {
  detailBusy.value = false;
 }
}
</script>

<template>
 <section class="surface-card p-16 min-w-0">
  <Column :gap="16">
   <Row x="between" wrap :gap="8">
    <h2 class="section-title">附件入库记录</h2>
    <Row :gap="8"><v-chip color="secondary">{{ materials.length }} 份</v-chip><v-btn :disabled="disabled" @click="emit('add')">增加附件</v-btn></Row>
   </Row>
   <Column v-if="!materials.length" class="surface-panel p-16" :gap="8">
    <span class="text-sm text-muted">当前材料版本还没有入库附件。</span>
   </Column>
   <Column v-else class="w-full overflow-x-auto">
    <v-table density="comfortable" class="min-w-900px">
     <thead>
      <tr><th scope="col">附件</th><th scope="col">入库状态</th><th scope="col">脱敏状态</th><th scope="col">大小</th><th scope="col">入库时间</th><th scope="col">操作</th></tr>
     </thead>
     <tbody>
      <tr v-for="material in materials" :key="material.id">
       <td class="min-w-220px">
        <Column :gap="4">
         <span class="font-medium text-sm break-all">{{ material.original_name }}</span>
         <span class="text-xs text-muted">{{ material.content_type.toUpperCase() }}</span>
         <details class="text-xs">
          <summary class="cursor-pointer link-text">查看文件指纹</summary>
          <code class="block mt-8 text-muted break-all">SHA-256 {{ material.sha256 }}</code>
         </details>
        </Column>
       </td>
       <td><v-chip :color="material.processing_status === 'received' ? 'warning' : 'success'">{{ statusLabel(material.processing_status) }}</v-chip></td>
       <td><v-chip :color="material.processing_status === 'redacted' ? 'success' : 'warning'">{{ material.processing_status === 'redacted' ? '已脱敏' : material.processing_status === 'received' ? '待提取' : '未脱敏' }}</v-chip></td>
       <td class="whitespace-nowrap">{{ fileSize(material.size_bytes) }}</td>
       <td class="whitespace-nowrap">{{ dateLabel(material.created_at) }}</td>
       <td>
        <Row wrap :gap="4">
         <v-btn color="primary" variant="text" :disabled="disabled || detailBusy || material.processing_status === 'received'" :loading="detailBusy && selectedMaterial?.id === material.id" @click="viewFullText(material)">查看全文</v-btn>
         <v-btn color="secondary" variant="text" :href="`/api/materials/${material.id}/download`">下载原件</v-btn>
         <v-btn variant="text" :disabled="disabled" @click="emit('edit', material)">替换</v-btn>
         <v-btn color="error" variant="text" :disabled="disabled" @click="emit('delete', material)">删除</v-btn>
        </Row>
       </td>
      </tr>
     </tbody>
    </v-table>
   </Column>
  </Column>

  <v-dialog v-model="detailOpen" max-width="1080" scrollable>
   <Column class="surface-card p-20" :gap="16">
    <Row x="between" wrap :gap="12">
     <Column :gap="4" class="min-w-0">
      <h2 class="section-title">附件全文</h2>
      <span class="text-sm text-muted break-all">{{ selectedMaterial?.original_name }}</span>
     </Column>
     <v-btn icon="$close" aria-label="关闭附件全文" variant="text" @click="detailOpen = false" />
    </Row>
    <Row v-if="detail" wrap :gap="8">
     <v-chip :color="detail.redaction_status === 'redacted' ? 'success' : 'warning'">{{ detail.redaction_status === 'redacted' ? '已完成脱敏' : '尚未脱敏' }}</v-chip>
     <v-btn size="small" :variant="!showingRedacted ? 'flat' : 'text'" @click="showingRedacted = false">原始提取文本</v-btn>
     <v-btn size="small" :disabled="detail.redaction_status !== 'redacted' || !detail.redacted_pages" :variant="showingRedacted ? 'flat' : 'text'" @click="showingRedacted = true">脱敏后文本</v-btn>
    </Row>
    <v-alert v-if="detail && !showingRedacted" type="warning" density="compact">当前显示原始提取文本，包含未脱敏信息，请注意权限与使用范围。</v-alert>
    <v-alert v-if="detail && showingRedacted && !detail.redacted_pages" type="info" density="compact">此记录已标记脱敏，但旧版索引没有保存附件级正文，当前无法在这里展示脱敏文本。可在工作流步骤产物中下载整卷脱敏文本。</v-alert>
    <v-alert v-if="detailError" type="error" role="alert">{{ detailError }}</v-alert>
    <span v-else-if="detailBusy" class="text-sm text-muted">正在读取已入库全文…</span>
    <Column v-else-if="detail" class="max-h-560px overflow-y-auto" :gap="16">
     <span class="text-xs text-muted">{{ detail.format.toUpperCase() }} · {{ detail.provider }} · {{ detail.pages.length }} 页</span>
     <Column v-for="page in (showingRedacted ? detail.redacted_pages ?? [] : detail.pages)" :key="page.page" class="border-t border-line-subtle pt-12" :gap="8">
      <Row x="between" wrap :gap="8">
       <span class="text-sm font-medium">第 {{ page.page }} 页 · {{ page.method }}</span>
       <v-chip v-if="page.issues?.length" color="warning">{{ page.issues.length }} 项待核</v-chip>
      </Row>
      <pre class="surface-panel p-12 text-sm whitespace-pre-wrap break-words">{{ page.text || '（本页未提取到文字）' }}</pre>
      <span v-if="page.issues?.length" class="text-xs text-danger">{{ page.issues.join('、') }}</span>
     </Column>
     <span v-if="!detail.pages.length" class="text-sm text-muted">已入库记录没有页级文本。</span>
    </Column>
   </Column>
  </v-dialog>
 </section>
</template>
