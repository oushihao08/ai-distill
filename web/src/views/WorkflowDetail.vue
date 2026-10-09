<script setup lang="ts">
import RevisionHistory from '../components/RevisionHistory.vue';
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { dateLabel, fileSize } from '../utils/format';
import { statusLabels, type WorkflowDetail, type Material, type Step } from '../types/api';
import ModelEvaluationSummary from '../components/ModelEvaluationSummary.vue';
import MaterialRecordsTable from '../components/MaterialRecordsTable.vue';
const route = useRoute();
const { data, error, loading, refresh } = useResource<WorkflowDetail>(`/workflows/${route.params.id}`);
const submitting=shallowRef(false);
const clearOpen=shallowRef(false);
const activeTask=computed(()=>data.value?.attempts.some(a=>['waiting','running'].includes(a.status)));
const materialOpen=shallowRef(false);const replacement=shallowRef<Material|null>(null);const deleting=shallowRef<Material|null>(null);
const currentStep=computed(()=>data.value?.steps.find(step=>!['succeeded','skipped'].includes(step.status)));
const stepStatus=(ordinal:number)=>data.value?.steps.find(step=>step.ordinal===ordinal)?.status;
const answerDisabled=computed(()=>submitting.value || stepStatus(4)!=='succeeded' || data.value?.attempts.some(attempt=>attempt.ordinal===5 && attempt.input_revision===data.value?.workflow.input_revision && ['waiting','running'].includes(attempt.status)));
const authorDisabled=computed(()=>submitting.value || stepStatus(9)!=='succeeded' || data.value?.attempts.some(attempt=>attempt.ordinal===4 && attempt.input_revision===data.value?.workflow.input_revision && ['waiting','running'].includes(attempt.status)));
function editMaterial(material?:Material){replacement.value=material ?? null;materialOpen.value=true;}
async function intake(){try{submitting.value=true;await api(`/workflows/${route.params.id}/intake`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'接收失败';}finally{submitting.value=false;}}
async function removeMaterial(){if(!deleting.value)return;try{submitting.value=true;await api(`/workflows/${route.params.id}/materials/${deleting.value.id}`,{method:'DELETE'});deleting.value=null;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{submitting.value=false;}}
async function redact() {
 try { submitting.value=true; await api(`/workflows/${route.params.id}/redact`,{method:'POST'}); await refresh(); }
 catch(failure){ error.value=failure instanceof Error?failure.message:'脱敏任务提交失败'; }
 finally {submitting.value=false;}
}
async function clearGenerated(){try{submitting.value=true;const result=await api<{file_cleanup:string}>(`/workflows/${route.params.id}/generated`,{method:'DELETE'});clearOpen.value=false;await refresh();if(result.file_cleanup!=='completed')error.value='数据库已清理，但隔离文件清理未完成，请检查存储权限';}catch(cause){error.value=cause instanceof Error?cause.message:'清理失败';}finally{submitting.value=false;}}
async function author(){try{submitting.value=true;await api(`/workflows/${route.params.id}/author`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'出题与质检提交失败';}finally{submitting.value=false;}}
async function answer(){try{submitting.value=true;await api(`/workflows/${route.params.id}/answer`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'作答提交失败';}finally{submitting.value=false;}}
const scoreDisabled=computed(()=>submitting.value || stepStatus(5)!=='succeeded' || data.value?.attempts.some(attempt=>attempt.ordinal===6 && attempt.input_revision===data.value?.workflow.input_revision && ['waiting','running'].includes(attempt.status)));
async function score(){try{submitting.value=true;await api(`/workflows/${route.params.id}/score`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'评分提交失败';}finally{submitting.value=false;}}
const publishDisabled=computed(()=>submitting.value || stepStatus(7)!=='succeeded' || stepStatus(8)==='succeeded');
const attemptNames:Record<number,string>={1:'入库',2:'PDF文本提取（入库内部）',3:'项目规则版本绑定（自动）',4:'出题与质检',5:'模型作答',6:'独立评分',7:'达标或返修',8:'发布成果',9:'脱敏与检查'};
const artifactAttempts:Record<number,number[]>={1:[1,2],9:[9],4:[4],5:[5],6:[6],8:[8]};
function artifactsForStep(step:Step){
 const ordinals=new Set(artifactAttempts[step.ordinal]??[]);
 return (data.value?.artifacts??[]).filter(artifact=>{
  const attempt=data.value?.attempts.find(item=>item.id===artifact.attempt_id);
  return attempt?ordinals.has(attempt.ordinal):false;
 });
}
function artifactLabel(kind:string){return kind==='published_result'?'下载发布成果':kind==='authored_question'?'下载题目包文本':kind==='score_report'?'下载评分报告':kind==='model_answer'?'下载模型答案':kind==='redacted_markdown'?'下载脱敏文本':'下载页码索引';}
async function publish(){try{submitting.value=true;error.value='';await api(`/workflows/${route.params.id}/publish`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'成果发布失败';}finally{submitting.value=false;}}
let timer:ReturnType<typeof setInterval>|undefined;
watch(()=>data.value?.attempts.some(a=>a.input_revision===data.value?.workflow.input_revision && [1,2,3,4,5,6,9].includes(a.ordinal) && ['waiting','running'].includes(a.status)),active=>{
 if(timer)clearInterval(timer);
 if(active)timer=setInterval(()=>{if(!loading.value)refresh();},3000);
});
onUnmounted(()=>{if(timer)clearInterval(timer);});
</script>
<template><Column :gap="24">
 <RouterLink v-if="data" :to="`/projects/${data.project.id}`" class="link-text text-sm">← {{ data.project.name }}</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <p v-if="loading && !data" class="text-muted">正在读取工作流…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="16"><Column :gap="8"><Row wrap :gap="8"><h1 class="text-3xl font-bold text-ink-heading break-words">{{ data.workflow.title }}</h1><v-chip color="secondary">{{ currentStep ? `${currentStep.display_position ?? currentStep.position ?? currentStep.ordinal} · ${currentStep.name} · ${statusLabels[currentStep.status]}` : '全部完成' }}</v-chip></Row><p class="text-sm text-muted">创建于 {{ dateLabel(data.workflow.created_at) }} · {{ data.materials.length }} 份材料 · 当前材料版本 {{ data.workflow.input_revision }}</p></Column><Row wrap :gap="8"><v-btn color="error" variant="text" :disabled="submitting || activeTask" @click="clearOpen=true">重置整条工作流</v-btn><v-btn color="secondary" :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新状态</v-btn></Row></Row>
  <v-alert type="info">原件保留在本机。PDF由第一步调用智谱提取并入库，DOCX/TXT/MD本地解析入库；第二步由Codex读取数据库原文并独立脱敏。请核对脱敏产物与识别异常。</v-alert>
  <Row stack-on-mobile y="start" :gap="16">
   <StepTimeline :steps="data.steps" class="w-full lg:w-auto lg:flex-grow-primary">
    <template #actions="{step}">
     <v-btn v-if="step.ordinal===1 && stepStatus(1)!=='succeeded'" color="primary" variant="flat" :loading="submitting" :disabled="submitting || data.attempts.some(a=>[1,2].includes(a.ordinal) && a.input_revision===data.workflow.input_revision && ['waiting','running'].includes(a.status))" @click="intake">入库</v-btn>
     <v-btn v-if="step.ordinal===9" color="primary" variant="flat" :loading="submitting" :disabled="submitting || stepStatus(1)!=='succeeded' || stepStatus(9)==='succeeded' || data.attempts.some(a=>a.ordinal===9 && a.input_revision===data.workflow.input_revision && ['waiting','running'].includes(a.status))" @click="redact">脱敏</v-btn>
     <v-btn v-if="step.ordinal===4" color="primary" variant="flat" :loading="submitting" :disabled="authorDisabled" @click="author">出题与独立质检</v-btn>
     <v-btn v-if="step.ordinal===5" color="primary" variant="flat" :loading="submitting" :disabled="answerDisabled" @click="answer">分别派发所选模型作答</v-btn>
     <v-btn v-if="step.ordinal===6" color="primary" variant="flat" :loading="submitting" :disabled="scoreDisabled" @click="score">独立评分</v-btn>
     <v-btn v-if="step.ordinal===8" color="primary" variant="flat" :loading="submitting" :disabled="publishDisabled" @click="publish">发布成果</v-btn>
    </template>
    <template #artifacts="{step}">
     <Row v-if="artifactsForStep(step).length" wrap :gap="8" class="mt-8">
      <v-btn v-for="artifact in artifactsForStep(step)" :key="artifact.id" :href="`/api/artifacts/${artifact.id}/download`" color="secondary" variant="tonal">{{artifactLabel(artifact.kind)}} · {{dateLabel(artifact.created_at)}}{{artifact.question_version ? ` · 题目版本 ${artifact.question_version}` : ''}}</v-btn>
     </Row>
    </template>
   </StepTimeline>
   <Column class="w-full lg:w-auto min-w-0 flex-1" :gap="16">
    <Column v-if="!data.materials.length && data.workflow.source_manifest?.length" class="surface-panel p-16" :gap="8"><p class="text-xs text-muted">待入库目录材料：</p><span v-for="source in data.workflow.source_manifest" :key="source.name" class="text-xs text-muted break-all">{{ source.name }} · {{ fileSize(source.size) }}</span></Column>
    <MaterialRecordsTable :workflow-id="data.workflow.id" :materials="data.materials" :redaction-status="stepStatus(9)" :redaction-queued="data.attempts.some(attempt=>attempt.ordinal===9 && attempt.input_revision===data?.workflow.input_revision && attempt.status==='waiting')" :disabled="submitting" @add="editMaterial()" @edit="editMaterial" @delete="deleting=$event" />
    <ModelEvaluationSummary :steps="data.steps" />
    <RevisionHistory :key="data.workflow.id" :workflow-id="data.workflow.id" :input-revision="data.workflow.input_revision" :attempts="data.attempts" :disabled="submitting||activeTask" @updated="refresh" />
    <section class="surface-card p-16"><Column :gap="16"><Row x="between"><h2 class="section-title">执行历史</h2><span class="text-sm text-muted">{{ data.attempts.length }} 次</span></Row>
     <Column v-for="attempt in data.attempts" :key="attempt.id" class="border-t border-line-subtle pt-12" :gap="8"><Row wrap :gap="8"><span class="text-sm font-medium">{{ attemptNames[attempt.ordinal] ?? `步骤 ${attempt.ordinal}` }} · {{ statusLabels[attempt.status] }}</span><v-chip :color="attempt.input_revision === data.workflow.input_revision ? 'secondary' : 'warning'">材料版本 {{ attempt.input_revision }}{{ attempt.input_revision === data.workflow.input_revision ? '' : ' · 历史' }}</v-chip></Row><span class="text-xs text-muted">{{ dateLabel(attempt.started_at) }}</span><p v-if="attempt.error" class="text-sm text-danger">{{ attempt.error }}</p><details class="text-sm"><summary class="cursor-pointer link-text">查看输入与结果</summary><pre class="surface-panel text-xs whitespace-pre-wrap break-all mt-8">{{ JSON.stringify({ input: attempt.input, config: attempt.config, result: attempt.result }, null, 2) }}</pre></details></Column>
    </Column></section>
   </Column>
  </Row>
  <v-dialog v-model="clearOpen" max-width="520"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">重置整条工作流</h2><p class="text-sm text-muted">清除本题所有步骤记录与结果，包括入库记录、已提取文本、脱敏内容、规则绑定、生成成果和执行历史；清空 OCR 缓存。题目、附件入库记录及本机原始附件保留，之后可从入库重新开始。运行中的任务未结束时不能重置。</p><Row x="end" :gap="8"><v-btn :disabled="submitting" @click="clearOpen=false">取消</v-btn><v-btn color="error" :loading="submitting" @click="clearGenerated">确认重置</v-btn></Row></Column></v-dialog>
  <v-dialog v-model="materialOpen" max-width="520"><MaterialEditor v-if="materialOpen" :workflow-id="data.workflow.id" :replace-id="replacement?.id" :replace-name="replacement?.original_name" @saved="refresh" @close="materialOpen=false" /></v-dialog>
  <v-dialog :model-value="deleting!==null" max-width="460" @update:model-value="deleting=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">从当前版本移除附件</h2><p class="text-sm text-muted break-all">{{ deleting?.original_name }} 将从当前材料版本移除，历史记录和本机原件保留。移除后第一步会回到“入库”待执行；点击“入库”会重新读取题目目录，DOCX/TXT/MD 本地解析，PDF 提取文本，混合格式会分别处理。</p><Row x="end" :gap="8"><v-btn :disabled="submitting" @click="deleting=null">取消</v-btn><v-btn color="error" :loading="submitting" @click="removeMaterial">确认移除</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
