<!--
职责：作为项目详情路由，编排材料包／题目列表、设置弹窗、步骤派发、分页题目记录及导出。
关键方法与用法：`runStep()` 派发步骤，`syncFolder()` 同步来源目录，`removeProject()` 删除项目，`exportProject()` 先按每题冻结的材料模式补齐附件 DOCX，再生成并下载 Excel；路由参数 `id` 指定项目。
-->

<script setup lang="ts">
import {usePageBreadcrumbs} from '../composables/usePageBreadcrumbs';
import ProjectStepRecords from '../components/ProjectStepRecords.vue';
import ProjectQuestionRecords from '../components/ProjectQuestionRecords.vue';
import ProjectMaterialRecords from '../components/ProjectMaterialRecords.vue';
import PhasePreparation from '../components/PhasePreparation.vue';
import ProjectLibraryMaterials from '../components/ProjectLibraryMaterials.vue';
import AcceptedQuestionList from '../components/AcceptedQuestionList.vue';
import ProjectAnswerModelsSummary from '../components/ProjectAnswerModelsSummary.vue';
import AnswerGenerationPolicySettings from '../components/AnswerGenerationPolicySettings.vue';
import { api } from '../api/client';
import {dispatchWorkflowBatch} from '../api/batch-dispatch';
import {acceptanceBatchSummary,batchStepIssue,type BatchStepResult} from '../utils/workflow-status';
import {resolveMaterialProcessingMode,materialProcessingSourceMode} from '@shared/material-library';
import { useResource } from '../composables/useResource';
import { type ProjectDetail,type ProjectStage } from '../types/api';
const answerModelsVersion=shallowRef(0);
const route=useRoute();const router=useRouter();
const {data,error,loading,refresh}=useResource<ProjectDetail>(`/projects/${route.params.id}`);
// 模型摘要由设置保存事件刷新，任务状态刷新不重复读取配置。
usePageBreadcrumbs(()=>{const project=data.value?.project;return [{title:'出题项目',to:'/'},...(project?.project_group_id?[{title:project.parent_name||'主项目',to:`/project-groups/${project.project_group_id}`}]:[]),{title:project?.phase_name||project?.name||'期次工作区'}];});
const editOpen=shallowRef(false);const tagsOpen=shallowRef(false);const deleteOpen=shallowRef(false);const modelSettingsOpen=shallowRef(false);const materialsSettingsOpen=shallowRef(false);
const recordsStep=shallowRef<ProjectStage|null>(null);
const settings=shallowRef<ProjectStage|null>(null);const busy=shallowRef<number|string|null>(null);const message=shallowRef('');
const exportError=shallowRef('');const actionError=shallowRef('');
const feedbackOrdinal=shallowRef<number|null>(null);
// 活动任务只在可见页面中串行刷新；终态、卸载及操作中不叠加读取。
let activityTimer:ReturnType<typeof setTimeout>|undefined;
let activityDisposed=false;
function scheduleActivityRefresh(){
 clearTimeout(activityTimer);
 if(activityDisposed||!data.value?.steps.some(step=>step.running>0||step.queued>0))return;
 activityTimer=setTimeout(async()=>{
  try{if(!document.hidden&&busy.value===null&&!loading.value)await refresh();}
  finally{scheduleActivityRefresh();}
 },10000);
}
watch(()=>data.value,scheduleActivityRefresh);
onBeforeUnmount(()=>{activityDisposed=true;clearTimeout(activityTimer);});
const loadedMaterialCount=shallowRef<number|null>(null);
const usableMaterialCount=shallowRef<number|null>(null);
function loadedMaterials(count:number,usable:number|null){loadedMaterialCount.value=count;usableMaterialCount.value=usable;}
function openAuthoringSettings(){const stage=data.value?.steps.find(step=>step.ordinal===4);if(stage)settings.value=stage;}
function viewPhaseMaterials(){document.getElementById('phase-materials')?.scrollIntoView({behavior:'smooth',block:'start'});}
const batchFailures=shallowRef<{workflow_id:string;title:string;reason:string}[]>([]);
const syncMessage=shallowRef('');const syncError=shallowRef('');
const materialPackages=computed(()=>data.value?.workflows.filter(flow=>flow.workflow_kind==='material_package')??[]);
const questionWorkflows=computed(()=>data.value?.workflows.filter(flow=>flow.workflow_kind!=='material_package')??[]);
const qualifiedQuestionCount=computed(()=>questionWorkflows.value.filter(flow=>flow.acceptance_result?.decision==='accepted').length);
const questionCount=computed(()=>questionWorkflows.value.length);
const qualifiedProgressPercent=computed(()=>questionCount.value?Math.round(qualifiedQuestionCount.value/questionCount.value*100):0);
const isGroupedMaterialPhase=computed(()=>Boolean(data.value?.project.project_group_id)&&data.value?.project.material_mode==='material_packages');
// Any project may load a shared material package; the selected mode applies to
// newly created library-backed questions, while existing legacy workflows keep their frozen source.
const supportsOriginalMaterialMode=true;
const questionProcessingMode=computed(()=>resolveMaterialProcessingMode(data.value?.steps.find(step=>step.ordinal===4)?.config));
const questionMaterialMode=computed(()=>materialProcessingSourceMode(questionProcessingMode.value));
const authorablePackages=computed(()=>questionMaterialMode.value==='redacted'?materialPackages.value.filter(pkg=>pkg.material_redaction_status==='succeeded'&&!questionWorkflows.value.some(question=>question.source_workflow_id===pkg.id)):[]);
const recordsWorkflows=computed(()=>recordsStep.value&&[1,9].includes(recordsStep.value.ordinal)&&data.value?.project.material_mode==='material_packages'?materialPackages.value:questionWorkflows.value);
async function exportProject(){
 try{
  exportError.value='';feedbackOrdinal.value=null;busy.value='export';
  const accepted=questionWorkflows.value.filter(flow=>flow.current_ordinal===7&&flow.current_decision==='accepted');
  let generated=0,reused=0;
  for(let index=0;index<accepted.length;index++){
   const flow=accepted[index]!;message.value=`正在检查并准备当前材料 DOCX（${index+1}/${accepted.length}）：${flow.title}`;
   const result=await api<{reused:boolean}>(`/workflows/${flow.id}/material-docx`,{method:'POST'});
   if(result.reused)reused++;else generated++;
  }
  message.value=`当前材料附件已准备（新生成 ${generated} 题，复用 ${reused} 题），正在生成 Excel…`;
  const result=await api<{id:string;workflow_count:number}>(`/projects/${route.params.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  message.value=`Excel 已生成，包含 ${result.workflow_count} 道达标题目，正在下载`;window.location.assign(`/api/exports/${result.id}/download`);
 }catch(cause){exportError.value=cause instanceof Error?cause.message:'导出失败';}finally{busy.value=null;}
}
const visibleSteps=computed(()=>data.value?.steps.filter(step=>step.ordinal!==10&&(!isGroupedMaterialPhase.value||![1,9].includes(step.ordinal)))??[]);
async function runStep(step:ProjectStage,fromPackages=false){
 try{
  busy.value=step.ordinal;feedbackOrdinal.value=step.ordinal;message.value=`正在提交${step.name}任务，请稍候…`;actionError.value='';error.value='';batchFailures.value=[];
  const createdIds:string[]=[];
  if(step.ordinal===4&&fromPackages){
   for(const pkg of authorablePackages.value){
    try{
     const versions=await api<{id:string}[]>(`/material-packages/${pkg.id}/versions`);
     if(!versions[0])throw new Error('没有可用的成功脱敏版本');
     const created=await api<{id:string}>(`/material-packages/${pkg.id}/questions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:pkg.title,redaction_attempt_id:versions[0].id})});
     createdIds.push(created.id);
    }catch(cause){batchFailures.value.push({workflow_id:pkg.id,title:pkg.title,reason:cause instanceof Error?cause.message:'建题失败'});}
   }
  }
  const workflowIds=fromPackages?createdIds:([1,9].includes(step.ordinal)?materialPackages.value:questionWorkflows.value).map(flow=>flow.id);
  const result=await dispatchWorkflowBatch(String(route.params.id),step.ordinal,workflowIds,(receipts,total)=>{
   const queued=receipts.filter(item=>item.status==='queued').length;
   message.value=`${step.name}正在派发：已取得 ${receipts.length}/${total} 道题回执，已入队 ${queued} 道。`;
  });
  const queued=result.results.filter(item=>item.status==='queued').length;
  const completed=result.results.filter(item=>item.status==='succeeded').length;
  const acceptedSkipped=result.results.filter(item=>item.status==='already_accepted').length;
  const notReady=result.results.filter(item=>item.status==='not_ready').length;
  const capacityExceeded=result.results.filter(item=>item.status==='capacity_exceeded').length;
  const failed=result.results.filter(item=>item.status==='failed'||item.status==='not_found').length;
  const taskCount=(item:{attempt_ids?:string[]})=>item.attempt_ids?.length??1;
  const newTasks=result.results.filter(item=>item.status==='queued'&&!item.reused).reduce((sum,item)=>sum+taskCount(item),0);
  const reusedTasks=result.results.filter(item=>item.status==='queued'&&item.reused).reduce((sum,item)=>sum+taskCount(item),0);
  batchFailures.value.push(...result.results.filter(item=>batchStepIssue(item)!==null).map(item=>({workflow_id:item.workflow_id,title:data.value?.workflows.find(workflow=>workflow.id===item.workflow_id)?.title??item.workflow_id,reason:batchStepIssue(item)!})));
  message.value=`${fromPackages?'从材料包建题并出题':step.name}批量执行结果：新建 ${createdIds.length} 道题，新派发 ${newTasks} 个任务（${queued} 道题），复用 ${reusedTasks} 个已有任务，${step.ordinal===7?acceptanceBatchSummary(result.results):`已完成 ${completed} 道`}，已达标跳过 ${acceptedSkipped} 道，未就绪 ${notReady} 道，容量不足未派发 ${capacityExceeded} 道，失败 ${failed+batchFailures.value.filter(item=>materialPackages.value.some(pkg=>pkg.id===item.workflow_id)).length} 道。`;
  await refresh();
 }catch(cause){actionError.value=cause instanceof Error?cause.message:'执行失败';await refresh();}finally{busy.value=null;}
}
async function syncFolder(){
 try{busy.value='sync';syncMessage.value='';syncError.value='';const result=await api<{discovered:number;added:number;changed:number}>(`/projects/${route.params.id}/sync-folder`,{method:'POST'});syncMessage.value=data.value?.project.material_mode==='material_packages'?`发现 ${result.discovered} 个材料包，新增 ${result.added}，来源变化 ${result.changed}。已有题目的快照不变。`:`发现 ${result.discovered} 道题目，新增 ${result.added}，材料变化 ${result.changed}。变化的题目从第一步重新接收。`;await refresh();}
 catch(cause){syncError.value=cause instanceof Error?cause.message:'同步失败';error.value=syncError.value;}finally{busy.value=null;}
}
function openMaterialsSettings(){syncMessage.value='';syncError.value='';materialsSettingsOpen.value=true;}
async function removeProject(){
 try{busy.value='delete';await api(`/projects/${route.params.id}`,{method:'DELETE'});await router.push('/');}
 catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{busy.value=null;}
}
async function savedProject(){editOpen.value=false;await refresh();}
async function savedTags(){tagsOpen.value=false;await refresh();}
</script>
<template><Column :gap="16">
 <RouterLink :to="data?.project.project_group_id?`/project-groups/${data.project.project_group_id}`:'/'" class="link-text text-sm">← 所属主项目的期次</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <v-btn v-if="error&&!data" color="primary" :loading="loading" :disabled="loading" @click="refresh">重新读取</v-btn>
  <p v-if="loading&&!data" class="text-muted">正在读取项目…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="12"><Column :gap="6" class="min-w-0"><h1 class="text-2xl font-bold text-ink-heading break-words">{{ data.project.name }}</h1><p class="text-xs text-muted">第 {{ data.project.phase_no??'—' }} 期 · 题目、作答模型与评测结果属于本期</p><p v-if="data.project.description" class="text-sm text-muted">{{ data.project.description }}</p></Column><Row wrap :gap="8"><v-btn @click="modelSettingsOpen=true">本期作答模型</v-btn><v-btn @click="openMaterialsSettings">主项目资料与 skill</v-btn><v-btn :disabled="busy!==null" @click="editOpen=true">编辑本期配置</v-btn><v-btn :loading="loading" @click="answerModelsVersion++;refresh()">刷新</v-btn><v-btn color="error" :disabled="busy!==null" @click="deleteOpen=true">删除本期</v-btn></Row></Row>
  <Row class="surface-card p-12" x="between" wrap y="center" :gap="8"><Row wrap y="center" :gap="6"><span class="text-sm font-medium text-ink-heading">本期题目标签</span><v-chip v-for="tag in data.project.question_tags??[]" :key="tag" size="small" color="primary" variant="tonal">{{ tag }}</v-chip><span v-if="!data.project.question_tags?.length" class="text-sm text-muted">尚未创建</span></Row><v-btn size="small" variant="outlined" :disabled="busy!==null" @click="tagsOpen=true">{{ data.project.question_tags?.length?'管理标签':'创建标签' }}</v-btn></Row>
  <PhasePreparation :project-id="data.project.id" :authoring="data.steps.find(step=>step.ordinal===4)" :mode="questionProcessingMode" :material-count="loadedMaterialCount" :usable-count="usableMaterialCount" @rules="openMaterialsSettings" @authoring="openAuthoringSettings" @models="modelSettingsOpen=true" @materials="viewPhaseMaterials"/>
  <section class="surface-card p-16" aria-label="本期达标进度"><Row x="between" y="center" :gap="12"><Column :gap="4"><h2 class="text-sm font-semibold text-ink-heading">本期达标进度</h2><p class="text-xs text-muted">{{ qualifiedQuestionCount }} / {{ questionCount }} 道题已达标</p></Column><span class="text-lg font-semibold text-success">{{ qualifiedProgressPercent }}%</span></Row><v-progress-linear class="mt-10" color="success" :model-value="qualifiedProgressPercent" rounded aria-label="本期题目达标百分比" /><p class="mt-6 text-xs text-muted">按本期已加载题目计算；材料包不计入。</p></section>
  <v-alert v-if="actionError&&feedbackOrdinal===null" type="error" role="alert">{{ actionError }}</v-alert>
  <v-alert v-if="message&&feedbackOrdinal===null" type="info" role="status"><Column :gap="6"><span>{{ message }}</span><details v-if="batchFailures.length"><summary class="cursor-pointer">查看未完成原因</summary><ul class="my-0 pl-20"><li v-for="item in batchFailures" :key="item.workflow_id">{{ item.title }}（{{ item.workflow_id }}）：{{ item.reason }}</li></ul></details></Column></v-alert>
   <ProjectCodexSettings :key="data.project.id" :project-id="data.project.id" />
  <p class="text-xs text-muted">状态在打开页面、提交操作或手动刷新时更新。“出题就绪”只统计已创建题目；已提取或脱敏、尚未建题的材料包可按本期来源设置创建题目。材料或来源版本不足只影响对应材料包，不阻断其他题目。</p>
  <ProjectLibraryMaterials id="phase-materials" @loaded="loadedMaterials" :project-id="data.project.id" :question-tags="data.project.question_tags??[]" :material-source-mode="questionMaterialMode" :material-processing-mode="questionProcessingMode" @refresh="refresh" />
   <Column :gap="10"><section v-for="step in visibleSteps" :key="step.ordinal" class="surface-card p-16"><Row x="between" wrap :gap="12"><Row :gap="12"><v-avatar color="primary" variant="tonal" size="32"><span class="text-sm">{{ step.position }}</span></v-avatar><Column :gap="6"><button type="button" class="bg-transparent border-none p-0 text-left text-sm font-semibold text-ink-heading hover:text-primary cursor-pointer" @click="recordsStep=step">{{ step.name }}</button><Row wrap :gap="12" class="text-xs text-muted"><span class="text-primary">就绪 {{ step.ready }}</span><span v-if="step.ordinal===4&&data.project.material_mode==='material_packages'&&data.project.material_backend!=='library_v1'&&!isGroupedMaterialPhase" class="text-muted">可建题材料包 {{ authorablePackages.length }}</span><span>排队 {{ step.queued }}</span><span>运行 {{ step.running }}</span><template v-if="step.ordinal===7"><span class="text-success">达标 {{ step.succeeded }}</span><span class="text-warning-text">未达标 {{ step.needs_repair }}</span><span v-if="step.quarantined" class="text-danger">隔离 {{ step.quarantined }}</span></template><span v-else class="text-success">成功 {{ step.succeeded }}</span><span :class="step.failed?'text-danger':''">失败 {{ step.failed }}</span></Row><ProjectAnswerModelsSummary v-if="step.ordinal===5" :project-id="data.project.id" :refresh-token="answerModelsVersion" /></Column></Row><Row :gap="8"><v-btn @click="recordsStep=step">{{ data.project.material_mode==='material_packages'&&data.project.material_backend!=='library_v1'&&[1,9].includes(step.ordinal)?'查看材料包':'查看题目' }}</v-btn><v-btn v-if="[9,4,5,6].includes(step.ordinal)&&!(isGroupedMaterialPhase&&step.ordinal===9)" @click="settings=step">{{ step.ordinal===5?'流程设置':'设置' }}</v-btn><v-btn color="primary" variant="flat" :loading="busy===step.ordinal" :disabled="busy!==null||!step.implemented||step.ready===0" @click="runStep(step)">{{ step.ordinal===7?'批量判断':step.implemented?`执行就绪 ${step.ready}`:'尚未接入' }}</v-btn><v-btn v-if="step.ordinal===4&&data.project.material_mode==='material_packages'&&data.project.material_backend!=='library_v1'&&!isGroupedMaterialPhase" color="primary" variant="outlined" :loading="busy===4" :disabled="busy!==null||authorablePackages.length===0" @click="runStep(step,true)">从材料包建题并出题 {{ authorablePackages.length }}</v-btn></Row></Row><Column v-if="feedbackOrdinal===step.ordinal" :gap="8" class="mt-12"><v-alert v-if="actionError" type="error" role="alert">{{ actionError }}</v-alert><v-alert v-else-if="message" type="info" role="status" aria-live="polite">{{ message }}</v-alert><details v-if="batchFailures.length"><summary class="cursor-pointer text-sm">查看未完成原因（{{ batchFailures.length }}）</summary><ul class="my-0 pl-20"><li v-for="item in batchFailures" :key="item.workflow_id">{{ item.title }}：{{ item.reason }}</li></ul></details></Column></section></Column>
   <ProjectQuestionRecords :project-id="data.project.id" :workflows="questionWorkflows" :packages="materialPackages" :workflow-status="data.workflow_status" :material-packages-enabled="data.project.material_mode==='material_packages'" @refresh="refresh" />
   <details v-if="data.project.material_mode==='material_packages'&&data.project.material_backend!=='library_v1'"><summary class="text-sm text-muted cursor-pointer">旧流程材料包与执行历史（{{ materialPackages.length }}）</summary><p class="text-xs text-muted">保留旧题的入库、脱敏及来源记录；新库关联和跨期使用状态在“本期材料”管理。</p><ProjectMaterialRecords :project-id="data.project.id" :packages="materialPackages" :questions="questionWorkflows" @refresh="refresh" /></details>
   <AcceptedQuestionList :workflows="questionWorkflows" :packages="materialPackages" :exporting="busy==='export'" :export-error="exportError" @export="exportProject" />
  <v-dialog :model-value="recordsStep!==null" max-width="1280" @update:model-value="recordsStep=null"><ProjectStepRecords v-if="recordsStep" :key="`${data.project.id}-${recordsStep.ordinal}`" :step="recordsStep" :workflows="recordsWorkflows" @close="recordsStep=null" /></v-dialog>
  <v-dialog v-model="editOpen" max-width="560"><ProjectForm v-if="editOpen" :project="data.project" @created="savedProject" @close="editOpen=false" /></v-dialog>
  <v-dialog v-model="tagsOpen" max-width="560"><ProjectForm v-if="tagsOpen" :project="data.project" tags-only @created="savedTags" @close="tagsOpen=false" /></v-dialog>
  <v-dialog v-model="modelSettingsOpen" max-width="980" scrollable>
   <v-card class="surface-card max-h-[90vh] overflow-hidden">
    <v-card-title class="p-20 pb-8"><Row x="between" y="center" :gap="12"><h2 class="section-title">作答模型设置</h2><v-btn icon="$close" variant="text" aria-label="关闭作答模型设置" @click="modelSettingsOpen=false" /></Row></v-card-title>
    <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
     <Column :gap="20"><AnswerModelSet v-if="modelSettingsOpen" :key="data.project.id" :project-id="data.project.id" @saved="answerModelsVersion++" /><AnswerGenerationPolicySettings v-if="modelSettingsOpen" :key="`${data.project.id}-answer-policy`" :project-id="data.project.id" /></Column>
    </v-card-text>
   </v-card>
  </v-dialog>
  <v-dialog v-model="materialsSettingsOpen" max-width="1120" scrollable>
   <v-card class="surface-card max-h-[90vh] overflow-hidden">
    <v-card-title class="p-20 pb-8"><Row x="between" y="center" :gap="12"><h2 class="section-title">规则资料与 Skill</h2><v-btn icon="$close" variant="text" aria-label="关闭规则资料与 Skill" @click="materialsSettingsOpen=false" /></Row></v-card-title>
    <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
     <Column :gap="16">
      <v-alert type="info" density="compact">规则资料由主项目各期共享；Skill 可在本期单独建立，没有本期 Skill 时自动使用主项目 Skill。案卷材料包在“本期材料”表中加载，并在材料库查看。</v-alert>
      <details v-if="data.project.project_group_id&&data.project.material_backend!=='library_v1'" class="border-b border-line-subtle pb-12"><summary class="text-sm text-muted cursor-pointer">历史材料来源（仅供追溯）</summary><Column class="pt-8" :gap="8"><code class="text-xs text-muted break-all">{{ data.project.material_root || '未记录' }}</code><p class="text-xs text-muted">本期材料已通过共享材料库管理。此目录不会在期次页面重新同步；新增材料请在“本期材料”表中加载。</p></Column></details>
      <Column v-else-if="!data.project.project_group_id&&data.project.material_backend!=='library_v1'" class="border-b border-line-subtle pb-16" :gap="8">
       <Row x="between" wrap :gap="8"><span class="text-sm font-medium">本期{{ data.project.material_mode==='material_packages'?'材料包':'题目' }}来源目录</span><v-btn :loading="busy==='sync'" :disabled="busy!==null||!data.project.material_root" @click="syncFolder">同步{{ data.project.material_mode==='material_packages'?'材料包':'题目' }}目录</v-btn></Row>
       <code class="text-xs text-muted break-all">{{ data.project.material_root || '旧项目尚未设置目录，请编辑项目' }}</code>
       <v-alert v-if="data.project.material_mode!=='material_packages'" type="info" density="compact">这是保留原有工作流记录的历史项目，页面不会自动转换或隐藏旧题。新建项目统一使用材料包创建多题流程。</v-alert>
       <v-alert v-if="syncMessage" type="info" role="status">{{ syncMessage }}</v-alert>
       <v-alert v-if="syncError" type="error" role="alert">{{ syncError }}</v-alert>
      </Column>
      <Column v-else class="border-b border-line-subtle pb-16" :gap="8"><span class="text-sm font-medium">本期案卷材料</span><p class="text-sm text-muted">请在期次详情的“本期材料”表中加载、选版和查看案卷材料。全局文件与脱敏处理由侧栏的材料库统一管理。</p><code class="text-xs text-muted break-all">本期规则工作区：{{ data.project.workspace_path||'未设置' }}</code></Column>
      <ProjectRules v-if="materialsSettingsOpen" :key="data.project.id" :project-id="data.project.id" />
     </Column>
    </v-card-text>
   </v-card>
  </v-dialog>
  <v-dialog :model-value="settings!==null" max-width="520" @update:model-value="settings=null"><StepSettings v-if="settings" :key="settings.ordinal" :project-id="data.project.id" :step="settings" :material-source-mode="questionMaterialMode" :allow-original-material-mode="supportsOriginalMaterialMode" @saved="refresh" @close="settings=null" @open-models="settings=null;modelSettingsOpen=true" /></v-dialog>
  <v-dialog v-model="deleteOpen" max-width="560"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除本期及其题目数据</h2><p class="text-sm text-muted">将从工作台移除本期，并删除本期数据库中的题目、附件记录、步骤结果、答案、评分、执行历史和导出记录。主项目的材料使用历史会保留，不会因此释放材料供同主项目其他期次重用。项目模型与步骤配置、skill 生成历史、全局模型配置、本地来源材料和 skill 文件均保留；此操作无法在页面恢复。</p><Row x="end" :gap="8"><v-btn :disabled="busy==='delete'" @click="deleteOpen=false">取消</v-btn><v-btn color="error" variant="flat" :loading="busy==='delete'" @click="removeProject">删除本期</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
