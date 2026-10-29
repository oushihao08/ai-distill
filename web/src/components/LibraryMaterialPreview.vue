<!-- 职责：列出指定提取任务或脱敏版本对应的全部文件，按文件切换查看正文。
props.revisionId、jobId/redactionId固定结果身份；脱敏预览使用该版本实际引用的提取任务，不拼接最新版本；close关闭。 -->
<script setup lang="ts">
import {api} from '../api/client';
const props=defineProps<{revisionId:string;jobId?:string;redactionId?:string}>();
const emit=defineEmits<{close:[]}>();
interface MaterialDocument {file_id:string;original_name:string;page_count:number;pages?:{page:number;text:string}[]}
const documents=shallowRef<MaterialDocument[]>([]),content=shallowRef(''),fileId=shallowRef('');
const validationWarning=shallowRef<Record<string,unknown>|null>(null);
const extractionId=shallowRef('');
const busy=shallowRef(false),error=shallowRef('');
let request=0;
let controller:AbortController|undefined;
async function readFile(id:string){
 if(id===fileId.value&&content.value&&!error.value)return;
 controller?.abort();const current=new AbortController();controller=current;
 const token=++request;fileId.value=id;busy.value=true;error.value='';content.value='';
 try{
  if(props.redactionId){
   const result=await api<{revision_id:string;extraction_job_id:string;pages:{page:number;text:string}[]}>(`/material-library/redactions/${props.redactionId}/preview?file_id=${id}`,{signal:current.signal});
   if(token!==request)return;
   if(result.revision_id!==props.revisionId||result.extraction_job_id!==extractionId.value)throw new Error('脱敏版本与文件来源不一致，请重新打开');
   content.value=result.pages.map(page=>page.text).join('\n\n');
  }else{
   const result=await api<{items:MaterialDocument[]}>(`/material-library/revisions/${props.revisionId}/documents?extraction_job_id=${extractionId.value}&file_id=${id}`,{signal:current.signal});
   if(token!==request)return;
   const item=result.items.find(item=>item.file_id===id);content.value=item?.pages?.map(page=>page.text).join('\n\n')??'';
  }
 }catch(cause){if(token===request)error.value=cause instanceof Error?cause.message:'读取材料正文失败';}
 finally{if(token===request)busy.value=false;}
}
async function load(){
 controller?.abort();const current=new AbortController();controller=current;
 const token=++request;busy.value=true;error.value='';documents.value=[];content.value='';validationWarning.value=null;fileId.value='';
 try{
  let job=props.jobId;
  if(props.redactionId){
   const result=await api<{revision_id:string;extraction_job_id:string;validation_report:Record<string,unknown>}>(`/material-library/redactions/${props.redactionId}/preview?metadata_only=true`,{signal:current.signal});
   if(token!==request)return;
   if(result.revision_id!==props.revisionId)throw new Error('脱敏版本与材料集合不一致');
   validationWarning.value=result.validation_report.usable_for_question===true?null:result.validation_report;
   job=result.extraction_job_id;
  }
  if(!job)throw new Error('缺少对应的成功提取版本');
  extractionId.value=job;
  const result=await api<{items:MaterialDocument[]}>(`/material-library/revisions/${props.revisionId}/documents?extraction_job_id=${job}`,{signal:current.signal});
  if(token!==request)return;
  documents.value=result.items;
  if(result.items[0])await readFile(result.items[0].file_id);
 }catch(cause){if(token===request)error.value=cause instanceof Error?cause.message:'读取材料清单失败';}
 finally{if(token===request)busy.value=false;}
}
watch(()=>[props.revisionId,props.jobId,props.redactionId],load,{immediate:true});
onUnmounted(()=>{request++;controller?.abort();});
</script>
<template>
 <Column class="surface-card p-20 max-h-[85vh] overflow-y-auto" :gap="12">
  <Row x="between" y="center" :gap="12"><h2 class="section-title">{{ redactionId?'脱敏附件':'提取正文' }} · {{ documents.length }} 份</h2><v-btn @click="emit('close')">关闭</v-btn></Row>
  <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
  <Row wrap :gap="8" aria-label="材料包全部附件"><v-btn v-for="item in documents" :key="item.file_id" :variant="fileId===item.file_id?'tonal':'text'" :color="fileId===item.file_id?'primary':undefined" :disabled="busy" class="max-w-full" @click="readFile(item.file_id)">{{ item.original_name }}（{{ item.page_count }}页）</v-btn></Row>
  <p v-if="busy" class="text-muted" role="status">正在读取正文…</p>
  <v-alert v-if="validationWarning" type="warning">脱敏结果的可用性校验未通过：<pre class="text-xs whitespace-pre-wrap break-words">{{ JSON.stringify(validationWarning,null,2) }}</pre></v-alert>
  <pre v-if="!busy&&!error" class="whitespace-pre-wrap break-words text-sm max-h-[55vh] overflow-y-auto border border-line rounded-md p-12">{{ documents.length?(content||'无正文'):'没有可查看的附件' }}</pre>
 </Column>
</template>
