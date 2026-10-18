<!-- 职责：组织材料包文件版本、文件选择和三步处理操作，阅读交给LibraryFileReader。
props.revisions固定文件版本；busy限制写操作；run通知父页面派发真实任务，refresh用于刷新任务状态。 -->
<script setup lang="ts">
import type {LibraryRevision} from '../types/material-library';
import {dateLabel} from '../utils/format';
const props=defineProps<{revisions:LibraryRevision[];busy:boolean}>();
const emit=defineEmits<{run:[revision:LibraryRevision,kind:'intake'|'extract'|'redact'];refresh:[]}>();
const revisionId=shallowRef(''),fileId=shallowRef('');
const revision=computed(()=>props.revisions.find(item=>item.id===revisionId.value)??props.revisions[0]);
const file=computed(()=>revision.value?.files.find(item=>item.id===fileId.value)??revision.value?.files[0]);
const revisionSelection=computed({get:()=>revision.value?.id??'',set:(id:string)=>{revisionId.value=id;fileId.value='';}});
const fileSelection=computed({get:()=>file.value?.id??'',set:(id:string)=>{fileId.value=id;}});
const extracted=computed(()=>revision.value?.jobs.some(item=>item.kind==='extract'&&item.status==='succeeded')??false);
const usable=computed(()=>revision.value?.redactions.some(item=>item.usable_for_question===true||item.usable_for_question==='true')??false);
const active=computed(()=>revision.value?.jobs.find(item=>['queued','running'].includes(item.status)));
const names={intake:'入库',extract:'识别原文',redact:'脱敏'};
</script>
<template><Column :gap="0" class="min-w-0">
 <Row x="between" wrap y="center" :gap="12" class="p-12 border-b border-line">
  <Column :gap="8" class="min-w-0"><Row wrap :gap="12" class="text-xs"><span :class="revision?.state==='ready'?'text-success':'text-muted'">{{ revision?.state==='ready'?'已入库':'待入库' }}</span><span :class="extracted?'text-success':'text-muted'">{{ extracted?'原文已识别':'待识别原文' }}</span><span :class="usable?'text-success':'text-muted'">{{ usable?'已脱敏':'待完成脱敏' }}</span></Row></Column>
  <Row wrap :gap="8" v-if="revision"><v-btn v-if="revision.state==='pending'" :disabled="busy||!!active" @click="emit('run',revision,'intake')">入库</v-btn><v-btn v-else :disabled="busy||!!active" @click="emit('run',revision,'extract')">{{ extracted?'重新识别':'识别原文' }}</v-btn><v-btn color="primary" :disabled="busy||!!active||!extracted" @click="emit('run',revision,'redact')">{{ usable?'重新脱敏':'脱敏' }}</v-btn></Row>
 </Row>
 <Row v-if="active" x="between" wrap y="center" :gap="12" class="px-16 py-12 bg-primary-soft"><span class="text-sm">{{ names[active.kind] }}任务{{ active.status==='queued'?'排队中':'执行中' }}。</span><v-btn size="small" variant="text" @click="emit('refresh')">刷新状态</v-btn></Row>
 <Row v-if="revision" wrap y="center" :gap="12" class="px-16 py-12 border-b border-line">
  <v-select v-if="revisions.length>1" v-model="revisionSelection" label="文件版本" :items="revisions.map((item,index)=>({title:`第 ${revisions.length-index} 版 · ${dateLabel(item.created_at)}`,value:item.id}))" hide-details class="w-full max-w-300"/>
  <span v-else class="text-sm text-muted">第 1 版 · {{ revision.file_count }} 份文件</span>
  <v-select v-model="fileSelection" label="选择文件" :items="revision.files.map(item=>({title:item.original_name,value:item.id}))" hide-details class="flex-1 min-w-0 w-full"/>
 </Row>
 <LibraryFileReader v-if="file&&revision" :key="`${revision.id}-${file.id}`" :file="file" :revision="revision"/>
 <Column v-else x="center" y="center" :gap="12" class="p-32 min-h-320"><UiIcon name="file" class="text-muted"/><p class="text-sm text-muted">这个材料包还没有文件，请选择材料文件夹导入。</p></Column>
</Column></template>
