<!--
职责：展示材料整理与使用范围结果并触发可选Agent整理；不代替出题Agent选择最终场景。
关键入口：按包/版本/来源读取整理记录，展示总摘要、逐份摘要和多组支持范围。
使用场景：材料库详情页及期次建题弹窗；结果只作后续出题参考，不过滤完整材料。
-->
<script setup lang="ts">
import {api,apiPostIntent} from '../api/client';
import type {MaterialPreparationResult,PreparedSelectionDocument} from '@shared/material-preparation-result';
const props=defineProps<{packageId:string;revisionId:string;redactionId?:string|null;projectId?:string}>();
type Item={id:string;revision_id:string;redaction_id:string|null;project_id:string|null;result:MaterialPreparationResult};
const items=shallowRef<Item[]>([]),selectedId=shallowRef(''),busy=shallowRef(false),error=shallowRef(''),notice=shallowRef(''),available=shallowRef(true),jobId=shallowRef('');
const content=shallowRef<PreparedSelectionDocument[]>([]),selected=computed(()=>items.value.find(x=>x.id===selectedId.value));
let generation=0;
async function load(){
 const version=++generation;
 try{busy.value=true;error.value='';const r=await api<{available:boolean;items:Item[]}>(`/material-library/packages/${props.packageId}/preparations`);if(version!==generation)return;
  available.value=r.available;items.value=r.items.filter(i=>i.revision_id===props.revisionId&&i.redaction_id===(props.redactionId??null)&&(!props.projectId||!i.project_id||i.project_id===props.projectId));selectedId.value=items.value.some(x=>x.id===selectedId.value)?selectedId.value:items.value[0]?.id??'';
  if(jobId.value){const j=await api<{status:string;execution?:{label:string};error_message?:string}>(`/material-library/jobs/${jobId.value}`);if(version===generation)notice.value=`整理任务：${j.execution?.label??j.status}${j.error_message?` · ${j.error_message}`:''}`;}
 }catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'整理结果读取失败，可直接跳过';}finally{if(version===generation)busy.value=false;}
}
async function start(){
 try{busy.value=true;error.value='';const revision=await api<{items:{id:string;jobs:{id:string;kind:string;status:string}[]}[]}>(`/material-library/packages/${props.packageId}/revisions`);
  const extraction=revision.items.find(r=>r.id===props.revisionId)?.jobs.find(j=>j.kind==='extract'&&j.status==='succeeded');
  if(!props.redactionId&&!extraction)throw new Error('尚无成功提取结果；可继续其他操作');
  const result=await apiPostIntent<{id:string}>(`/material-library/revisions/${props.revisionId}/prepare`,{...(props.redactionId?{redaction_id:props.redactionId}:{extraction_job_id:extraction!.id}),...(props.projectId?{project_id:props.projectId}:{})});jobId.value=result.id;notice.value='整理任务已派发；完成后可刷新。整理不阻断建题。';
 }catch(cause){error.value=cause instanceof Error?cause.message:'整理派发失败，可继续使用完整材料';}finally{busy.value=false;}
}
async function preview(){if(!selected.value)return;try{busy.value=true;const r=await api<{documents:PreparedSelectionDocument[]}>(`/material-library/preparations/${selected.value.id}?include_content=true`);content.value=r.documents;}catch(cause){error.value=cause instanceof Error?cause.message:'材料正文读取失败';}finally{busy.value=false;}}
watch(()=>[props.packageId,props.revisionId,props.redactionId,props.projectId],()=>{generation++;items.value=[];selectedId.value='';jobId.value='';notice.value='';void load();},{immediate:true});
onBeforeUnmount(()=>{generation++;});
</script>
<template><Column class="border border-line rounded-md p-12" :gap="8">
 <Row wrap x="between" y="center" :gap="8"><strong class="text-sm">材料整理与使用范围（可跳过）</strong><Row :gap="8"><v-btn size="small" variant="text" :loading="busy" @click="load">刷新</v-btn><v-btn size="small" variant="outlined" :disabled="busy||!available" @click="start">Agent整理</v-btn></Row></Row>
 <p class="text-xs text-muted">生成材料包总摘要、逐份材料摘要与多组可支持范围。建题时自动冻结给出题Agent参考，最终方向、场景和交付由出题Agent决定；完整材料始终保留。</p>
 <p v-if="!available" class="text-xs text-muted">当前服务尚未启用整理接口，可直接创建题目。</p><p v-if="notice" class="text-xs text-muted" role="status">{{ notice }}</p><v-alert v-if="error" type="info" density="compact">{{ error }}。可继续使用完整材料。</v-alert>
 <template v-if="items.length">
  <v-select v-if="items.length>1" v-model="selectedId" label="整理记录" :items="items.map((i,n)=>({title:`整理 ${items.length-n} · ${i.id.slice(0,8)}`,value:i.id}))" hide-details/>
  <template v-if="selected">
   <p class="text-sm whitespace-pre-wrap">{{ selected.result.package_summary||'未提供材料包总摘要' }}</p>
   <p v-for="(warning,i) in selected.result.warnings" :key="i" class="text-xs text-muted">{{ warning }}</p>
   <Column class="max-h-280px overflow-y-auto" :gap="8"><Column v-for="doc in selected.result.documents" :key="doc.id" :gap="4" class="border-b border-line-subtle pb-8"><strong class="text-sm">{{ doc.title }}</strong><p class="text-sm whitespace-pre-wrap">{{ doc.summary||'未提供摘要' }}</p><p class="text-xs text-muted">{{ [doc.document_type,...doc.tags].filter(Boolean).join(' · ') }}</p><p v-if="doc.notes" class="text-xs text-muted">{{ doc.notes }}</p></Column></Column>
   <strong class="text-sm">材料支持的方向、场景与交付组合</strong>
   <Column v-if="selected.result.combinations.length" :gap="8"><article v-for="item in selected.result.combinations" :key="item.id" class="border border-line-subtle rounded p-8"><p class="text-sm"><b>方向：</b>{{ item.direction }} · <b>主体/立场：</b>{{ item.party }}</p><p class="text-sm"><b>场景：</b>{{ item.scenes.map(s=>`${s.scene}${s.as_of?`（${s.as_of}）`:''}`).join('、') }}</p><p class="text-sm"><b>核心工作：</b>{{ item.core_work }}</p><p class="text-sm"><b>交付：</b>{{ item.deliverables.join('、') }}</p></article></Column><p v-else class="text-xs text-muted">当前没有范围建议；出题Agent仍可依据完整材料独立设计。</p>
   <v-btn size="small" variant="text" :disabled="busy" @click="preview">查看完整材料</v-btn><details v-for="doc in content" :key="doc.id"><summary class="text-sm cursor-pointer">{{ doc.title }}</summary><pre class="text-sm whitespace-pre-wrap max-h-280px overflow-y-auto">{{ doc.text }}</pre></details>
  </template>
 </template>
</Column></template>
