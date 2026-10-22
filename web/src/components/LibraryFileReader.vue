<!-- 职责：在同一阅读区查看识别原文、脱敏文本及逐页对照。
props.file/revision固定文件与文件集合，v-model:mode由父级控制、redactionId固定所选脱敏版本并通过update:mode同步查看方式；对照始终读取该版本实际引用的提取任务，禁止按各自“最新”拼接。原文件仅提供显式下载，不在阅读区预览。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
import type {LibraryFile,LibraryRevision} from '../types/material-library';
type Mode='source'|'redacted'|'compare';
const props=defineProps<{file:LibraryFile;revision:LibraryRevision;mode:Mode;redactionId:string}>();
const emit=defineEmits<{ 'update:mode':[value:Mode] }>();
const mode=computed({get:()=>props.mode,set:(value:Mode)=>emit('update:mode',value)});
interface Page {page:number;text:string;issues?:unknown[]}
const extractionId=shallowRef('');
const source=shallowRef<Page[]>([]),redacted=shallowRef<Page[]>([]);
const busy=shallowRef(false),error=shallowRef('');
const extractions=computed(()=>props.revision.jobs.filter(item=>item.kind==='extract'&&item.status==='succeeded'));
const selectedRedaction=computed(()=>props.revision.redactions.find(item=>item.id===props.redactionId)??props.revision.redactions.find(item=>item.usable_for_question===true||item.usable_for_question==='true')??props.revision.redactions[0]);
const selectedExtraction=computed(()=>extractions.value.find(item=>item.id===extractionId.value)?.id??selectedRedaction.value?.extraction_job_id??extractions.value[0]?.id);
const effectiveExtraction=computed(()=>mode.value==='compare'?selectedRedaction.value?.extraction_job_id:selectedExtraction.value);
const extractionItems=computed(()=>extractions.value.map((item,index)=>({title:`识别版本 ${extractions.value.length-index} · ${dateLabel(item.created_at)}`,value:item.id})));
const extractionSelection=computed({get:()=>selectedExtraction.value??'',set:(id:string)=>{extractionId.value=id;}});
const comparePages=computed(()=>source.value.map(page=>({source:page,redacted:redacted.value.find(item=>item.page===page.page)})));
const issueCount=computed(()=>source.value.reduce((sum,page)=>sum+(page.issues?.length??0),0));
const emptyMessage=computed(()=>mode.value==='source'?(effectiveExtraction.value?'':'此文件尚未识别原文，请先执行“识别原文”。'):!selectedRedaction.value?'此文件尚无成功的脱敏版本，请先完成脱敏。':'');
let controller:AbortController|undefined;
async function load(){
 controller?.abort();const current=new AbortController();controller=current;
 busy.value=true;error.value='';source.value=[];redacted.value=[];
 try{
  if(emptyMessage.value)return;
  const needsSource=mode.value==='source'||mode.value==='compare',needsRedacted=mode.value==='redacted'||mode.value==='compare';
  const [originalResult,redactedResult]=await Promise.all([
   needsSource?api<{items:{pages:Page[]}[]}>(`/material-library/revisions/${props.revision.id}/documents?extraction_job_id=${effectiveExtraction.value}&file_id=${props.file.id}`,{signal:current.signal}):Promise.resolve(undefined),
   needsRedacted?api<{revision_id:string;extraction_job_id:string;pages:Page[]}>(`/material-library/redactions/${selectedRedaction.value!.id}/preview?file_id=${props.file.id}`,{signal:current.signal}):Promise.resolve(undefined),
  ]);
  if(current.signal.aborted)return;
  if(redactedResult&&(redactedResult.revision_id!==props.revision.id||redactedResult.extraction_job_id!==selectedRedaction.value?.extraction_job_id))throw new Error('脱敏结果与识别来源不一致，请刷新后重试');
  source.value=originalResult?.items[0]?.pages??[];redacted.value=redactedResult?.pages??[];
  if(mode.value==='compare'&&(source.value.length!==redacted.value.length||source.value.some(page=>!redacted.value.some(item=>item.page===page.page))))throw new Error('对照版本的页码不一致，请查看处理记录');
 }catch(cause){if(!current.signal.aborted)error.value=cause instanceof Error?cause.message:'读取文件内容失败';}
 finally{if(controller===current)busy.value=false;}
}
watch(()=>[props.file.id,props.revision.id,mode.value,selectedRedaction.value?.id,effectiveExtraction.value],load,{immediate:true});
onUnmounted(()=>{controller?.abort();});
</script>
<template><Column :gap="0" class="min-w-0">
 <Row x="between" wrap y="center" :gap="8" class="border-b border-line px-8"><v-tabs v-model="mode" color="primary" aria-label="文件查看方式" class="min-w-0 flex-1"><v-tab value="source">识别原文</v-tab><v-tab value="redacted">脱敏文本</v-tab><v-tab value="compare">原文与脱敏对照</v-tab></v-tabs><a :href="`/api/material-library/files/${file.id}/content`" class="link-text text-sm shrink-0 px-8 py-4">下载原文件</a></Row>
 <Row v-if="mode==='source'&&extractions.length" wrap y="center" :gap="12" class="px-16 py-8 border-b border-line">
  <v-select v-if="mode==='source'&&extractions.length" v-model="extractionSelection" :items="extractionItems" label="识别版本" hide-details class="max-w-380 w-full"/>
 </Row>
 <v-alert v-if="error" type="error" class="ma-16" role="alert">{{ error }}</v-alert>
 <v-alert v-if="!busy&&issueCount" type="warning" class="ma-16">识别结果包含 {{ issueCount }} 项问题，请结合原件核对。</v-alert>
 <section :aria-busy="busy" aria-label="文件内容" class="min-w-0 h-[60vh] min-h-320 overflow-y-auto bg-surface-soft">
  <Column v-if="busy" x="center" y="center" :gap="12" class="h-full p-24"><v-progress-circular indeterminate color="primary" :size="28"/><p class="text-sm text-muted">正在读取文件内容…</p></Column>
  <Column v-else-if="!error&&emptyMessage" x="center" y="center" :gap="12" class="h-full p-24"><UiIcon name="file" class="text-muted"/><p class="text-sm text-muted text-center">{{ emptyMessage }}</p></Column>
  <Column v-else-if="mode==='compare'&&!error" :gap="16" class="p-12"><Row stack-on-mobile :gap="16" y="start"><strong class="text-sm flex-1">识别原文</strong><strong class="text-sm flex-1 text-success">脱敏文本</strong></Row><Row v-for="page in comparePages" :key="page.source.page" stack-on-mobile :gap="16" y="stretch"><article v-for="(side,index) in [page.source,page.redacted]" :key="index" class="min-w-0 flex-1 w-full bg-surface border border-line rounded-md p-12"><p class="text-xs text-muted mb-12">{{ index===0?'原文':'脱敏' }} · 第 {{ side?.page }} 页</p><pre class="text-sm leading-relaxed whitespace-pre-wrap break-words">{{ side?.text||'（本页无正文）' }}</pre></article></Row></Column>
  <Column v-else-if="!error" :gap="16" class="p-12"><article v-for="page in mode==='source'?source:redacted" :key="page.page" class="bg-surface border border-line rounded-md p-12"><p class="text-xs text-muted mb-12">第 {{ page.page }} 页</p><pre class="text-sm leading-relaxed whitespace-pre-wrap break-words">{{ page.text||'（本页无正文）' }}</pre></article></Column>
 </section>
</Column></template>
