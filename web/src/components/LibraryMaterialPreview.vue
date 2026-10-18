<!-- 职责：按需阅读成功提取任务的单文件正文/识别问题，或指定脱敏结果全文。
props.revisionId、jobId/redactionId 固定结果身份；close 关闭。纯文本显示避免把材料HTML当成页面执行。 -->
<script setup lang="ts">
import {api} from '../api/client';
const props=defineProps<{revisionId:string;jobId?:string;redactionId?:string}>();
const emit=defineEmits<{close:[]}>();
interface Document {file_id:string;original_name:string;page_count:number;issues:unknown[];pages?:{page:number;text:string;issues:unknown[]}[]}
const documents=shallowRef<Document[]>([]),content=shallowRef(''),issues=shallowRef<unknown[]>([]),fileId=shallowRef('');
const busy=shallowRef(false),error=shallowRef('');
let request=0;
async function readFile(id:string){
 const token=++request;busy.value=true;error.value='';content.value='';issues.value=[];
 try{const result=await api<{items:Document[]}>(`/material-library/revisions/${props.revisionId}/documents?extraction_job_id=${props.jobId}&file_id=${id}`);if(token!==request)return;const item=result.items[0];content.value=item?.pages?.map(page=>page.text).join('\n\n')??'';issues.value=item?.issues??[];}
 catch(cause){if(token===request)error.value=cause instanceof Error?cause.message:'读取提取正文失败';}finally{if(token===request)busy.value=false;}
}
async function load(){
 try{busy.value=true;error.value='';if(props.redactionId){const result=await api<{markdown:string;validation_report:Record<string,unknown>}>(`/material-library/redactions/${props.redactionId}/preview`);content.value=result.markdown;issues.value=result.validation_report.usable_for_question===true?[]:[result.validation_report];}else{const result=await api<{items:Document[]}>(`/material-library/revisions/${props.revisionId}/documents?extraction_job_id=${props.jobId}`);documents.value=result.items;fileId.value=result.items[0]?.file_id??'';if(fileId.value)await readFile(fileId.value);}}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取材料预览失败';}finally{busy.value=false;}
}
onMounted(load);
</script>
<template><Column class="surface-card p-20 max-h-[85vh] overflow-y-auto" :gap="12"><Row x="between" y="center"><h2 class="section-title">{{ redactionId?'脱敏结果':'提取正文与识别问题' }}</h2><v-btn @click="emit('close')">关闭</v-btn></Row><v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert><v-select v-if="!redactionId" v-model="fileId" label="材料文件" :items="documents.map(item=>({title:`${item.original_name}（${item.page_count}页）`,value:item.file_id}))" :disabled="busy" @update:model-value="readFile"/><p v-if="busy" class="text-muted">正在读取正文…</p><v-alert v-if="issues.length" type="warning">该结果有 {{ issues.length }} 项识别或可用性问题。<pre class="text-xs whitespace-pre-wrap break-words">{{ JSON.stringify(issues,null,2) }}</pre></v-alert><pre v-if="!busy" class="whitespace-pre-wrap break-words text-sm max-h-[55vh] overflow-y-auto border border-line rounded-md p-12">{{ content||'无正文' }}</pre></Column></template>
