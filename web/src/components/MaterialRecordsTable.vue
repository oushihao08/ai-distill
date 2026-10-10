<!--
职责：展示当前附件的入库／脱敏进度，并按需查看原文、脱敏全文或 PDF 原件。
关键方法与用法：`progressLabel()`／`progressColor()` 计算行状态，`viewFullText()` 按需读取正文；接收材料与步骤数据，通过 `add`／`delete` 事件交由项目步骤弹层或工作流详情处理。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { fileSize } from '../utils/format';
import type { Material, MaterialTextDetail, Step } from '../types/api';

const props = defineProps<{ workflowId: string; materials: Material[]; steps?: Step[]; redactionStatus?: string; disabled?: boolean; readOnly?: boolean; preferRedacted?: boolean; redactionQueued?: boolean }>();
const emit = defineEmits<{ add: []; delete: [material: Material] }>();
const detailOpen = shallowRef(false);
const detailBusy = shallowRef(false);
const detailError = shallowRef('');
const selectedMaterial = shallowRef<Material>();
const detail = shallowRef<MaterialTextDetail>();
const showingRedacted = shallowRef(false);
const detailTab = shallowRef<'text'|'pdf'>('text');
const isPdf = computed(() => selectedMaterial.value?.original_name.toLowerCase().endsWith('.pdf') ?? false);
const pdfPreviewUrl = shallowRef('');
const pdfPreviewBusy = shallowRef(false);
const pdfPreviewError = shallowRef('');
const pdfPreviewRequest = shallowRef<AbortController>();

function clearPdfPreview() {
 pdfPreviewRequest.value?.abort();
 pdfPreviewRequest.value = undefined;
 pdfPreviewBusy.value = false;
 if (pdfPreviewUrl.value) URL.revokeObjectURL(pdfPreviewUrl.value);
 pdfPreviewUrl.value = '';
 pdfPreviewError.value = '';
}

async function loadPdfPreview() {
 const material = selectedMaterial.value;
 if (!material || pdfPreviewUrl.value || pdfPreviewBusy.value || !isPdf.value) return;
 const controller = new AbortController();
 pdfPreviewRequest.value = controller;
 pdfPreviewBusy.value = true;
 pdfPreviewError.value = '';
 try {
  const response = await fetch(`/api/materials/${material.id}/download`, { signal: controller.signal });
  if (!response.ok) {
   let message = `PDF 加载失败（HTTP ${response.status}）`;
   try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') message = body.error;
   } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
   }
   throw new Error(message);
  }
  const blob = await response.blob();
  if (!detailOpen.value || detailTab.value !== 'pdf' || selectedMaterial.value?.id !== material.id) return;
  if (blob.type !== 'application/pdf') throw new Error('附件内容不是 PDF，无法预览');
  pdfPreviewUrl.value = URL.createObjectURL(blob);
 } catch (cause) {
  if (!controller.signal.aborted && detailOpen.value && detailTab.value === 'pdf' && selectedMaterial.value?.id === material.id) {
   pdfPreviewError.value = cause instanceof Error ? cause.message : 'PDF 加载失败';
  }
 } finally {
  if (pdfPreviewRequest.value === controller) {
   pdfPreviewRequest.value = undefined;
   pdfPreviewBusy.value = false;
  }
 }
}

watch(detailTab, tab => { if (tab === 'pdf') void loadPdfPreview(); });
watch(detailOpen, open => { if (!open) clearPdfPreview(); });
onBeforeUnmount(clearPdfPreview);

const intakeStep = computed(() => props.steps?.find(step => step.ordinal === 1));
function progressLabel(material: Material) {
 if (material.processing_status === 'redacted') return '脱敏 · 成功';
 if (material.processing_status === 'text_extracted') {
  if (props.redactionQueued) return '脱敏 · 排队中';
  if (props.redactionStatus === 'running') return '脱敏 · 识别中';
  if (props.redactionStatus === 'failed') return '脱敏 · 失败';
  if (props.redactionStatus === 'succeeded') return '脱敏 · 待核';
  return '入库 · 成功';
 }
 if (intakeStep.value?.status === 'running') return material.original_name.toLowerCase().endsWith('.pdf') ? '入库 · 识别中' : '入库 · 处理中';
 if (intakeStep.value?.status === 'failed') return '入库 · 失败';
 if (intakeStep.value?.status === 'succeeded') return '入库 · 待核';
 return '入库 · 待处理';
}
function progressColor(material: Material) {
 const label = progressLabel(material);
 if (label.endsWith('成功')) return 'success';
 if (label.endsWith('失败')) return 'error';
 return 'warning';
}
function textActionLabel(material:Material){
 return props.preferRedacted&&material.processing_status==='redacted'?'查看文本':'查看文本';
}

async function viewFullText(material: Material) {
 if (detailBusy.value) return;
 clearPdfPreview();
 selectedMaterial.value = material;
 detailTab.value = 'text';
 detail.value = undefined;
 detailError.value = '';
 showingRedacted.value = Boolean(props.preferRedacted);
 detailOpen.value = true;
 try {
  detailBusy.value = true;
  detail.value = await api<MaterialTextDetail>(`/workflows/${props.workflowId}/materials/${material.id}/extracted-text`);
  showingRedacted.value = Boolean(props.preferRedacted && detail.value.redaction_status === 'redacted' && detail.value.redacted_text !== undefined);
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
    <h2 class="section-title">附件处理情况</h2>
    <Row :gap="8"><v-chip color="secondary">{{ materials.length }} 份</v-chip><v-btn v-if="!readOnly" :disabled="disabled" @click="emit('add')">增加附件</v-btn></Row>
   </Row>
   <Column v-if="!materials.length" class="surface-panel p-16" :gap="8">
    <span class="text-sm text-muted">这道题还没有入库附件。</span>
   </Column>
   <Column v-else class="w-full overflow-x-auto">
    <v-table density="compact" class="min-w-0">
     <thead>
      <tr><th scope="col">附件</th><th scope="col">当前进度</th><th scope="col">操作</th></tr>
     </thead>
     <tbody>
      <tr v-for="material in materials" :key="material.id">
       <td class="min-w-0">
        <Row :gap="4">
         <span class="font-medium text-sm break-all">{{ material.original_name }}</span>
         <span class="text-xs text-muted">{{ fileSize(material.size_bytes) }}</span>
        </Row>
       </td>
       <td class="whitespace-nowrap"><v-chip size="small" :color="progressColor(material)">{{ progressLabel(material) }}</v-chip></td>
       <td>
        <Row wrap :gap="4">
         <v-btn color="primary" variant="text" :disabled="disabled || detailBusy || material.processing_status === 'received'" :loading="detailBusy && selectedMaterial?.id === material.id" @click="viewFullText(material)">{{ textActionLabel(material) }}</v-btn>
         <v-btn v-if="!readOnly" color="error" variant="text" :disabled="disabled" @click="emit('delete', material)">删除</v-btn>
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
    <v-tabs v-if="selectedMaterial" v-model="detailTab" color="primary" density="compact">
     <v-tab value="text">附件全文</v-tab>
     <v-tab v-if="isPdf" value="pdf">PDF 预览</v-tab>
    </v-tabs>
    <template v-if="detailTab === 'text'">
     <Row v-if="detail" wrap :gap="8">
     <v-chip :color="detail.redaction_status === 'redacted' ? 'success' : 'warning'">{{ detail.redaction_status === 'redacted' ? '已完成脱敏' : '尚未脱敏' }}</v-chip>
     <v-btn size="small" :variant="!showingRedacted ? 'flat' : 'text'" @click="showingRedacted = false">原始提取文本</v-btn>
     <v-btn size="small" :disabled="detail.redaction_status !== 'redacted' || detail.redacted_text === undefined" :variant="showingRedacted ? 'flat' : 'text'" @click="showingRedacted = true">脱敏后文本</v-btn>
    </Row>
    <v-alert v-if="detail && !showingRedacted" type="warning" density="compact">当前显示原始提取文本，包含未脱敏信息，请注意权限与使用范围。</v-alert>
    <v-alert v-if="detail && showingRedacted && detail.redacted_text === undefined" type="info" density="compact">此记录已标记脱敏，但索引中没有附件级正文，当前无法在这里展示脱敏文本。可在工作流步骤产物中下载整卷脱敏文本。</v-alert>
    <v-alert v-if="detailError" type="error" role="alert">{{ detailError }}</v-alert>
    <span v-else-if="detailBusy" class="text-sm text-muted">正在读取已入库全文…</span>
    <Column v-else-if="detail" class="max-h-560px overflow-y-auto" :gap="16">
     <span class="text-xs text-muted">{{ detail.format.toUpperCase() }} · {{ detail.provider }} · {{ detail.pages.length }} 页</span>
     <template v-if="showingRedacted && detail.redacted_text !== undefined && !detail.redacted_pages?.length">
      <span class="text-xs text-muted">脱敏后全文</span>
      <pre class="surface-panel p-12 text-sm whitespace-pre-wrap break-words">{{ detail.redacted_text || '（脱敏文本为空）' }}</pre>
     </template>
     <Column v-else v-for="page in (showingRedacted ? detail.redacted_pages ?? [] : detail.pages)" :key="page.page" class="border-t border-line-subtle pt-12" :gap="8">
      <Row x="between" wrap :gap="8">
       <span class="text-sm font-medium">第 {{ page.page }} 页 · {{ page.method }}</span>
       <v-chip v-if="page.issues?.length" color="warning">{{ page.issues.length }} 项待核</v-chip>
      </Row>
      <pre class="surface-panel p-12 text-sm whitespace-pre-wrap break-words">{{ page.text || '（本页未提取到文字）' }}</pre>
      <span v-if="page.issues?.length" class="text-xs text-danger">{{ page.issues.join('、') }}</span>
     </Column>
     <span v-if="!detail.pages.length" class="text-sm text-muted">已入库记录没有页级文本。</span>
    </Column>
    </template>
    <template v-else-if="isPdf">
     <v-alert v-if="pdfPreviewError" type="error" density="compact">{{ pdfPreviewError }}</v-alert>
     <span v-else-if="pdfPreviewBusy" class="text-sm text-muted">正在加载 PDF…</span>
     <iframe v-else-if="pdfPreviewUrl" :src="`${pdfPreviewUrl}#toolbar=1`" :title="`${selectedMaterial?.original_name ?? '附件'} PDF 预览`" class="w-full border border-line-subtle rounded" style="height:70vh;min-height:420px" />
    </template>
   </Column>
  </v-dialog>
 </section>
</template>
