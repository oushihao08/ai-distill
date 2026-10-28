<!-- 职责：组织材料包文件版本、文件选择和三步处理操作，阅读交给LibraryFileReader。
props.revisions固定文件版本；busy限制写操作；run通知父页面派发真实任务，refresh用于刷新任务状态。 -->
<script setup lang="ts">
import type {MaterialProcessingMode} from '@shared/material-library';
import type {LibraryRevision} from '../types/material-library';
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
import {defaultLibraryRedactionTemplateId} from '@shared/redaction-templates';
const props=defineProps<{revisions:LibraryRevision[];busy:boolean;processingMode?:MaterialProcessingMode}>();
const emit=defineEmits<{run:[revision:LibraryRevision,kind:'intake'|'extract'|'redact',templateId?:string];refresh:[]}>();
const templates=shallowRef<{id:string;name:string;workflow:string}[]>([]),templateId=shallowRef(''),templateError=shallowRef('');
const selectedTemplate=computed(()=>props.processingMode==='mask'?undefined:templates.value.find(t=>t.id===templateId.value));
onMounted(async()=>{try{templates.value=(await api<{items:typeof templates.value}>('/material-library/redaction-templates')).items;templateId.value=defaultLibraryRedactionTemplateId(templates.value);}catch(error){templateError.value=error instanceof Error?error.message:'读取模板失败';}});
const revisionId=shallowRef(''),fileId=shallowRef('');
type FileMode='source'|'redacted'|'compare';
const fileMode=shallowRef<FileMode>('source'),redactionId=shallowRef('');
const revision=computed(()=>props.revisions.find(item=>item.id===revisionId.value)??props.revisions[0]);
const file=computed(()=>revision.value?.files.find(item=>item.id===fileId.value)??revision.value?.files[0]);
const revisionSelection=computed({get:()=>revision.value?.id??'',set:(id:string)=>{revisionId.value=id;fileId.value='';}});
const fileSelection=computed({get:()=>file.value?.id??'',set:(id:string)=>{fileId.value=id;}});
const selectedRedaction=computed(()=>revision.value?.redactions.find(item=>item.id===redactionId.value)??revision.value?.redactions.find(item=>item.usable_for_question===true||item.usable_for_question==='true')??revision.value?.redactions[0]);
const redactionSelection=computed({get:()=>selectedRedaction.value?.id??'',set:(id:string)=>{redactionId.value=id;}});
const redactionItems=computed(()=>revision.value?.redactions.map((item,index)=>({title:`脱敏版本 ${revision.value!.redactions.length-index} · ${item.redaction_template_name??'原有处理'} · ${dateLabel(item.created_at)}`,value:item.id}))??[]);
watch(()=>[revision.value?.id,file.value?.id],()=>{fileMode.value='source';});
const extracted=computed(()=>revision.value?.jobs.some(item=>item.kind==='extract'&&item.status==='succeeded')??false);
const usable=computed(()=>revision.value?.redactions.some(item=>item.usable_for_question===true||item.usable_for_question==='true')??false);
const active=computed(()=>revision.value?.jobs.find(item=>item.kind!=='prepare'&&['queued','running'].includes(item.status)));
const names={intake:'入库',extract:'识别原文',redact:'脱敏',prepare:'材料整理'};
</script>
<template><Column :gap="0" class="min-w-0">
 <Row wrap y="center" :gap="8" class="px-8 py-8 border-b border-line">
  <span class="text-xs whitespace-nowrap" :class="revision?.state==='ready'?'text-success':'text-muted'">{{ revision?.state==='ready'?'已入库':'待入库' }}</span>
  <span class="text-xs whitespace-nowrap" :class="extracted?'text-success':'text-muted'">{{ extracted?'原文已识别':'待识别原文' }}</span>
  <span v-if="props.processingMode!=='original'" class="text-xs whitespace-nowrap" :class="usable?'text-success':'text-muted'">{{ usable?'已脱敏':'待完成脱敏' }}</span>
  <template v-if="revision">
   <v-btn v-if="revision.state==='pending'" :disabled="busy||!!active" @click="emit('run',revision,'intake')">入库</v-btn>
   <v-btn v-else :disabled="busy||!!active" @click="emit('run',revision,'extract')">{{ extracted?'重新识别':'识别原文' }}</v-btn>
   <v-btn v-if="props.processingMode!=='original'" color="primary" :disabled="busy||!!active||!extracted||!selectedTemplate" @click="emit('run',revision,'redact',templateId)">{{ usable?'重新脱敏':'脱敏' }}</v-btn>
   <v-select v-if="props.processingMode!=='original'&&props.processingMode!=='mask'" v-model="templateId" label="脱敏模板" :items="templates.map(t=>({title:t.name,value:t.id}))" hide-details class="w-full sm:w-220px sm:flex-none"/>
   <span v-if="revisions.length===1" class="text-sm text-muted whitespace-nowrap">第 1 版 · {{ revision.file_count }} 份文件</span>
   <v-select v-else v-model="revisionSelection" label="文件版本" :items="revisions.map((item,index)=>({title:`第 ${revisions.length-index} 版 · ${dateLabel(item.created_at)}`,value:item.id}))" hide-details class="w-full sm:w-220px sm:flex-none"/>
   <v-select v-model="fileSelection" label="选择文件" :items="revision.files.map(item=>({title:item.original_name,value:item.id}))" hide-details class="w-full sm:w-240px sm:flex-none"/>
   <v-select v-if="(fileMode==='redacted'||fileMode==='compare')&&revision.redactions.length" v-model="redactionSelection" label="脱敏版本" :items="redactionItems" hide-details class="w-full sm:w-260px sm:flex-none"/>
  </template>
 </Row>
 <p v-if="props.processingMode" class="px-12 py-8 text-sm text-muted">本期设置：{{ props.processingMode==='original'?'不脱敏，后续使用提取原文':props.processingMode==='mask'?'历史遮挡模式已退役，请先修改本期设置':'Agent 主导化名脱敏' }}</p>
 <v-alert v-if="templateError" type="error" density="compact">{{ templateError }}</v-alert>
 <v-alert v-if="selectedTemplate?.workflow==='codex_plan'" type="info" density="compact">Agent按整包主体表统一化名、保留法院名称并划分文书。使用数据库中本次保存的模板；单次执行使用本次冻结预算，到限停止并保留进度。</v-alert>
 <Row v-if="active" x="between" wrap y="center" :gap="12" class="px-16 py-12 bg-primary-soft"><span class="text-sm">{{ names[active.kind] }}任务{{ active.status==='queued'?'排队中':'执行中' }}。</span><v-btn size="small" variant="text" @click="emit('refresh')">刷新状态</v-btn></Row>
 <LibraryFileReader v-if="file&&revision" :key="`${revision.id}-${file.id}`" v-model:mode="fileMode" :file="file" :revision="revision" :redaction-id="redactionSelection"/>
 <Column v-else x="center" y="center" :gap="12" class="p-32 min-h-320"><UiIcon name="file" class="text-muted"/><p class="text-sm text-muted">这个材料包还没有文件，请选择材料文件夹导入。</p></Column>
</Column></template>
