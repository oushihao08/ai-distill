<!--
职责：展示材料整理与使用范围结果并触发可选Agent整理；明确文书计数、可见性和支持范围。
关键入口：按包/版本/来源读取整理记录，展示总摘要、逐份摘要和多组支持范围。
使用场景：材料库详情页及期次建题弹窗；人工预览保留全文，模型与DOCX按可见标记取用。
-->
<script setup lang="ts">
import {api,apiPostIntent} from '../api/client';
import {preparationCounts} from '@shared/material-preparation-counts';
import type {MaterialPreparationResult,PreparedSelectionDocument} from '@shared/material-preparation-result';
const emit=defineEmits<{refresh:[]}>();
const props=defineProps<{packageId:string;revisionId:string;redactionId?:string|null;projectId?:string}>();
type Item={id:string;revision_id:string;redaction_id:string|null;project_id:string|null;result:MaterialPreparationResult};
const items=shallowRef<Item[]>([]),selectedId=shallowRef(''),busy=shallowRef(false),error=shallowRef(''),notice=shallowRef(''),available=shallowRef(true),jobId=shallowRef('');
const content=shallowRef<PreparedSelectionDocument[]>([]),selected=computed(()=>items.value.find(x=>x.id===selectedId.value));
const countLabel=computed(()=>{
 if(!selected.value)return'';
 const counts=preparationCounts(selected.value.result);
 return counts.known?`完整文书 ${counts.document_count} 份；未归类内容 ${counts.unassigned_group_count} 组（${counts.unassigned_block_count} 个结构块）`:`整理记录 ${counts.entry_count} 条（摘要非空 ${counts.summary_count} 条）；来源未确认完整文书分类，按材料记录展示`;
});
let generation=0;
async function load(){
 const version=++generation;
 try{busy.value=true;error.value='';const r=await api<{available:boolean;items:Item[]}>(`/material-library/packages/${props.packageId}/preparations?revision_id=${props.revisionId}&redaction_id=${props.redactionId??''}&project_id=${props.projectId??''}`);if(version!==generation)return;
  available.value=r.available;items.value=r.items.filter(i=>i.revision_id===props.revisionId&&i.redaction_id===(props.redactionId??null)&&(!props.projectId||!i.project_id||i.project_id===props.projectId));selectedId.value=items.value.some(x=>x.id===selectedId.value)?selectedId.value:items.value[0]?.id??'';
  emit('refresh');
  if(!jobId.value){
   const revisions=await api<{items:{id:string;jobs:{id:string;kind:string;status:string}[]}[]}>(`/material-library/packages/${props.packageId}/revisions`);
   if(version!==generation)return;
   jobId.value=revisions.items.find(item=>item.id===props.revisionId)?.jobs.find(job=>job.kind==='prepare')?.id??'';
  }
  if(jobId.value){
   const j=await api<{status:string;started_at?:string;finished_at?:string;progress?:{phase?:string;phase_started_at?:string;material_count?:number};execution?:{label:string};error_message?:string}>(`/material-library/jobs/${jobId.value}`);
   if(version!==generation)return;
   const labels:Record<string,string>={prepare_input:'准备材料输入',agent_analyzing:'Agent分析中，等待完整JSON返回',parse_result:'解析并核对返回结果',publish_result:'正在入库'};
   const elapsed=j.started_at?Math.max(0,Math.floor(((j.finished_at?Date.parse(j.finished_at):Date.now())-Date.parse(j.started_at))/1000)):0;
   const phase=j.status==='succeeded'?'已完成入库':j.status==='failed'?'执行失败':j.status==='cancelled'?'已取消':j.progress?.phase?labels[j.progress.phase]??j.progress.phase:j.status==='running'?'执行中（旧任务未记录阶段）':j.execution?.label??j.status;
   notice.value=`整理任务：${phase}${j.started_at?` · 已耗时 ${Math.floor(elapsed/60)}分${elapsed%60}秒`:''}${j.progress?.material_count!==undefined?` · ${j.progress.material_count}条材料`:''}${j.error_message?` · ${j.error_message}`:''}（截至本次刷新）`;
   if(j.status==='succeeded'&&items.value.some(item=>item.id===jobId.value))selectedId.value=jobId.value;
  }
 }catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'整理结果读取失败，可直接跳过';}finally{if(version===generation)busy.value=false;}
}
async function start(){
 const version=generation,packageId=props.packageId,revisionId=props.revisionId;
 try{busy.value=true;error.value='';const revision=await api<{items:{id:string;jobs:{id:string;kind:string;status:string}[]}[]}>(`/material-library/packages/${packageId}/revisions`);
  if(version!==generation)return;
  const extraction=revision.items.find(r=>r.id===revisionId)?.jobs.find(j=>j.kind==='extract'&&j.status==='succeeded');
  if(!props.redactionId&&!extraction)throw new Error('尚无成功提取结果；可继续其他操作');
  const result=await apiPostIntent<{id:string;reused:boolean}>(`/material-library/revisions/${revisionId}/prepare`,{force:!!selected.value,...(props.redactionId?{redaction_id:props.redactionId}:{extraction_job_id:extraction!.id}),...(props.projectId?{project_id:props.projectId}:{})});if(version!==generation)return;jobId.value=result.id;notice.value=result.reused?'已复用现有整理任务或结果，点击刷新查看。':'整理任务已派发，完成后点击刷新查看结果。';emit('refresh');
 }catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'整理派发失败，可继续使用完整材料';}finally{if(version===generation)busy.value=false;}
}
async function preview(){if(!selected.value)return;const id=selected.value.id,version=generation;try{busy.value=true;const r=await api<{documents:PreparedSelectionDocument[]}>(`/material-library/preparations/${selected.value.id}?include_content=true`);if(version===generation&&selected.value?.id===id)content.value=r.documents;}catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'材料正文读取失败';}finally{if(version===generation)busy.value=false;}}
watch(()=>[props.packageId,props.revisionId,props.redactionId,props.projectId],()=>{generation++;items.value=[];selectedId.value='';jobId.value='';notice.value='';void load();},{immediate:true});
watch(selectedId,()=>{content.value=[];});
onBeforeUnmount(()=>{generation++;});
</script>
<template><Column :gap="20">
 <Row wrap x="between" y="center" :gap="12"><p class="text-sm text-muted flex-1 min-w-0">整理材料摘要、文书清单与可支持的任务范围，可跳过此步骤。</p><Row :gap="8"><v-btn variant="text" :loading="busy" :disabled="busy" @click="load">刷新</v-btn><v-btn color="primary" :disabled="busy||!available" @click="start">{{ selected?'重新整理':'Agent整理' }}</v-btn></Row></Row>
 <v-alert v-if="!available" type="info" variant="tonal">当前服务尚未启用材料整理，可继续创建题目。</v-alert>
 <v-alert v-if="notice" type="info" variant="tonal" role="status">{{ notice }}</v-alert>
 <v-alert v-if="error" type="warning" variant="tonal" role="alert">{{ error }}。可继续使用完整材料。</v-alert>
 <v-select v-if="items.length>1" v-model="selectedId" label="整理记录" :items="items.map((i,n)=>({title:`整理 ${items.length-n} · ${i.id.slice(0,8)}`,value:i.id}))" hide-details/>
 <p class="text-xs text-muted">整理记录的选择仅用于浏览；建题自动采用匹配本期来源的当前引擎结果。</p>
 <p v-if="busy&&!selected" class="text-sm text-muted" role="status">正在读取整理结果…</p>
 <Column v-else-if="!selected&&available&&!error" x="center" :gap="8" class="p-24 bg-surface-soft rounded-md"><strong class="text-sm">尚无当前版本的整理结果</strong><p class="text-sm text-muted">点击“Agent整理”生成材料摘要和使用范围。</p></Column>
 <template v-if="selected">
  <section class="bg-surface-soft rounded-md p-16"><Column :gap="8"><h3 class="text-base font-semibold">材料包摘要</h3><p class="text-xs text-muted">{{ countLabel }}</p><p class="text-sm leading-relaxed whitespace-pre-wrap break-words">{{ selected.result.package_summary||'未提供材料包总摘要' }}</p></Column></section>
  <v-alert v-if="selected.result.warnings.length" type="warning" variant="tonal"><ul class="pl-16"><li v-for="(warning,i) in selected.result.warnings" :key="i" class="text-sm leading-relaxed">{{ warning }}</li></ul></v-alert>
  <Column :gap="8"><Row wrap x="between" y="center" :gap="8"><h3 class="text-base font-semibold">文书清单 <span class="text-sm text-muted">{{ selected.result.documents.length }} 条</span></h3><span class="text-xs text-muted">隐藏内容仅供人工查看，不用于模型和合并DOCX。</span></Row>
   <v-table class="border border-line rounded-md preparation-table"><caption class="sr-only">文书摘要、类型和使用范围</caption><thead><tr><th scope="col" class="w-1/4">文书</th><th scope="col" class="w-1/2">摘要与说明</th><th scope="col">类型与标签</th><th scope="col">使用范围</th></tr></thead><tbody><tr v-for="doc in selected.result.documents" :key="doc.id"><td><strong class="text-sm">{{ doc.title }}</strong><p v-if="doc.unit_kind" class="text-xs text-muted mt-4">{{ doc.unit_kind==='unassigned'?'未归类内容':'文书' }}</p></td><td><p class="text-sm leading-relaxed whitespace-pre-wrap">{{ doc.summary||'未提供摘要' }}</p><details v-if="doc.visibility_reason||doc.notes" class="mt-8"><summary class="cursor-pointer link-text text-xs focus-visible:outline-auto">查看说明</summary><p v-if="doc.visibility_reason" class="text-xs text-muted mt-8">使用范围理由：{{ doc.visibility_reason }}</p><p v-if="doc.notes" class="text-xs text-muted mt-8 whitespace-pre-wrap">{{ doc.notes }}</p></details></td><td><p class="text-sm">{{ doc.document_type||'未标注' }}</p><p class="text-xs text-muted mt-4">{{ doc.tags.join(' · ') }}</p></td><td><v-chip size="small" :color="doc.visibility==='hidden'?'warning':'success'" variant="tonal">{{ doc.visibility==='hidden'?'仅人工查看':doc.visibility==='visible'?'模型可用':'默认可用' }}</v-chip></td></tr></tbody></v-table>
  </Column>
  <Column :gap="8"><h3 class="text-base font-semibold">候选工作分析与任务组合</h3><p class="text-xs text-muted">按本包材料提出候选工作、成果用途和核验建议，供出题选择组合；不是每题必做清单。历史记录可能仅含原有范围说明。</p><v-table v-if="selected.result.combinations.length" class="border border-line rounded-md preparation-table"><caption class="sr-only">材料支持的方向、立场、场景、工作及交付</caption><thead><tr><th scope="col">方向与立场</th><th scope="col">场景与时点</th><th scope="col">核心工作</th><th scope="col">成果与用途</th></tr></thead><tbody><tr v-for="item in selected.result.combinations" :key="item.id"><td><strong class="text-sm">{{ item.direction }}</strong><p class="text-sm text-muted mt-4">{{ item.party }}</p></td><td><p v-for="(scene,index) in item.scenes" :key="index" class="text-sm mb-4">{{ scene.scene }}<span v-if="scene.as_of" class="text-xs text-muted"> · {{ scene.as_of }}</span></p></td><td><p class="text-sm leading-relaxed whitespace-pre-wrap">{{ item.core_work }}</p><p class="text-xs text-muted mt-4">依据：{{ item.document_ids.map(id=>selected!.result.documents.find(doc=>doc.id===id)?.title??id).join('、') }}</p><p v-if="item.notes" class="text-sm leading-relaxed whitespace-pre-wrap mt-8"><strong>工作关系、核验与适用说明：</strong>{{ item.notes }}</p><p v-else class="text-xs text-muted mt-8">本条未提供工作关系或核验说明。</p></td><td><ul class="pl-16 text-sm leading-relaxed"><li v-for="(deliverable,index) in item.deliverables" :key="index">{{ deliverable }}</li></ul></td></tr></tbody></v-table><p v-else class="text-sm text-muted">暂无范围建议，出题时仍可依据可见材料设计。</p></Column>
  <Column :gap="8"><Row x="between" y="center" :gap="8"><h3 class="text-base font-semibold">人工核对原文</h3><v-btn variant="text" :disabled="busy" @click="preview">{{ content.length?'重新读取全文':'读取完整材料' }}</v-btn></Row><details v-for="doc in content" :key="doc.id" class="border border-line rounded-md p-12"><summary class="text-sm cursor-pointer focus-visible:outline-auto">{{ doc.title }}</summary><pre class="text-sm leading-relaxed whitespace-pre-wrap break-words mt-12">{{ doc.text }}</pre></details></Column>
 </template>
</Column></template>
<style scoped>
.preparation-table :deep(th), .preparation-table :deep(td) { vertical-align: top; white-space: normal; overflow-wrap: anywhere; padding-top: 12px; padding-bottom: 12px; }
.preparation-table :deep(table) { min-width: 640px; }
</style>
