<!--
职责：作为项目详情路由，编排设置弹窗、步骤派发、分页题目记录及导出。
关键方法与用法：`runStep()` 派发步骤，`syncFolder()` 同步来源目录，`removeProject()` 删除项目，`exportProject()` 生成下载；路由参数 `id` 指定项目。
-->

<script setup lang="ts">
import ProjectStepRecords from '../components/ProjectStepRecords.vue';
import ProjectQuestionRecords from '../components/ProjectQuestionRecords.vue';
import AcceptedQuestionList from '../components/AcceptedQuestionList.vue';
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { type ProjectDetail,type ProjectStage } from '../types/api';
const route=useRoute();const router=useRouter();
const {data,error,loading,refresh}=useResource<ProjectDetail>(`/projects/${route.params.id}`);
const editOpen=shallowRef(false);const deleteOpen=shallowRef(false);const modelSettingsOpen=shallowRef(false);const materialsSettingsOpen=shallowRef(false);
const recordsStep=shallowRef<ProjectStage|null>(null);
const settings=shallowRef<ProjectStage|null>(null);const busy=shallowRef<number|string|null>(null);const message=shallowRef('');
const batchFailures=shallowRef<{workflow_id:string;title:string;reason:string}[]>([]);
const syncMessage=shallowRef('');const syncError=shallowRef('');
async function exportProject(){
 try{error.value='';busy.value='export';const result=await api<{id:string;workflow_count:number}>(`/projects/${route.params.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});message.value=`Excel 已生成，包含 ${result.workflow_count} 道达标题目，正在下载`;window.location.assign(`/api/exports/${result.id}/download`);}
 catch(cause){error.value=cause instanceof Error?cause.message:'导出失败';}finally{busy.value=null;}
}
const visibleSteps=computed(()=>data.value?.steps.filter(step=>step.ordinal!==10)??[]);
async function runStep(step:ProjectStage){
 try{
  busy.value=step.ordinal;message.value='';error.value='';batchFailures.value=[];
  const result=await api<{results:{workflow_id:string;status:string;reused?:boolean;attempt_ids?:string[];reason?:string}[]}>(`/projects/${route.params.id}/steps/${step.ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const queued=result.results.filter(item=>item.status==='queued').length;
  const completed=result.results.filter(item=>item.status==='succeeded').length;
  const notReady=result.results.filter(item=>item.status==='not_ready').length;
  const failed=result.results.filter(item=>item.status==='failed'||item.status==='not_found').length;
  const taskCount=(item:{attempt_ids?:string[]})=>item.attempt_ids?.length??1;
  const newTasks=result.results.filter(item=>item.status==='queued'&&!item.reused).reduce((sum,item)=>sum+taskCount(item),0);
  const reusedTasks=result.results.filter(item=>item.status==='queued'&&item.reused).reduce((sum,item)=>sum+taskCount(item),0);
  batchFailures.value=result.results.filter(item=>item.status==='failed'||item.status==='not_found').map(item=>({workflow_id:item.workflow_id,title:data.value?.workflows.find(workflow=>workflow.id===item.workflow_id)?.title??item.workflow_id,reason:item.reason??'派发失败，请查看服务端日志'}));
  message.value=`${step.name}批量执行结果：新派发 ${newTasks} 个任务（${queued} 道题），复用 ${reusedTasks} 个已有任务，已完成 ${completed} 道，未就绪 ${notReady} 道，派发失败 ${failed} 道。`;
  await refresh();
 }catch(cause){error.value=cause instanceof Error?cause.message:'执行失败';}finally{busy.value=null;}
}
async function syncFolder(){
 try{busy.value='sync';syncMessage.value='';syncError.value='';const result=await api<{discovered:number;added:number;changed:number}>(`/projects/${route.params.id}/sync-folder`,{method:'POST'});syncMessage.value=`发现 ${result.discovered} 道题目，新增 ${result.added}，材料变化 ${result.changed}。变化的题目从第一步重新接收。`;await refresh();}
 catch(cause){syncError.value=cause instanceof Error?cause.message:'同步失败';error.value=syncError.value;}finally{busy.value=null;}
}
function openMaterialsSettings(){syncMessage.value='';syncError.value='';materialsSettingsOpen.value=true;}
async function removeProject(){
 try{busy.value='delete';await api(`/projects/${route.params.id}`,{method:'DELETE'});await router.push('/');}
 catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{busy.value=null;}
}
async function savedProject(){editOpen.value=false;await refresh();}
</script>
<template><Column :gap="16">
 <RouterLink to="/" class="link-text text-sm">← 全部出题项目</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <p v-if="loading&&!data" class="text-muted">正在读取项目…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="12"><Column :gap="6" class="min-w-0"><h1 class="text-2xl font-bold text-ink-heading break-words">{{ data.project.name }}</h1><p v-if="data.project.description" class="text-sm text-muted">{{ data.project.description }}</p></Column><Row wrap :gap="8"><v-btn @click="modelSettingsOpen=true">作答模型设置</v-btn><v-btn @click="openMaterialsSettings">材料与 skill</v-btn><v-btn :disabled="busy!==null" @click="editOpen=true">编辑项目</v-btn><v-btn :loading="loading" @click="refresh">刷新</v-btn><v-btn color="error" :disabled="busy!==null" @click="deleteOpen=true">删除</v-btn></Row></Row>
  <v-alert v-if="message" type="info" role="status"><Column :gap="6"><span>{{ message }}</span><details v-if="batchFailures.length"><summary class="cursor-pointer">查看派发失败题目</summary><ul class="my-0 pl-20"><li v-for="item in batchFailures" :key="item.workflow_id">{{ item.title }}（{{ item.workflow_id }}）：{{ item.reason }}</li></ul></details></Column></v-alert>
   <ProjectCodexSettings :key="data.project.id" :project-id="data.project.id" />
   <p class="text-xs text-muted">状态在打开页面、提交操作或手动刷新时更新。执行按钮只派发已就绪题目。第一步未完成的记录不会进入第二步，成功记录无需等待其他题目。</p>
  <Column :gap="10"><section v-for="step in visibleSteps" :key="step.ordinal" class="surface-card p-16"><Row x="between" wrap :gap="12"><Row :gap="12"><v-avatar color="primary" variant="tonal" size="32"><span class="text-sm">{{ step.position }}</span></v-avatar><Column :gap="6"><button type="button" class="bg-transparent border-none p-0 text-left text-sm font-semibold text-ink-heading hover:text-primary cursor-pointer" @click="recordsStep=step">{{ step.name }}</button><Row wrap :gap="12" class="text-xs text-muted"><span class="text-primary">就绪 {{ step.ready }}</span><span>排队 {{ step.queued }}</span><span>运行 {{ step.running }}</span><template v-if="step.ordinal===7"><span class="text-success">达标 {{ step.succeeded }}</span><span class="text-warning-text">需返修 {{ step.needs_repair }}</span><span v-if="step.quarantined" class="text-danger">隔离 {{ step.quarantined }}</span></template><span v-else class="text-success">成功 {{ step.succeeded }}</span><span :class="step.failed?'text-danger':''">失败 {{ step.failed }}</span></Row></Column></Row><Row :gap="8"><v-btn @click="recordsStep=step">查看题目</v-btn><v-btn v-if="[9,4,6,7].includes(step.ordinal)" @click="settings=step">设置</v-btn><v-btn color="primary" variant="flat" :loading="busy===step.ordinal" :disabled="busy!==null||!step.implemented||step.ready===0" @click="runStep(step)">{{ step.ordinal===7?'批量判断':step.implemented?`执行就绪 ${step.ready}`:'尚未接入' }}</v-btn></Row></Row></section></Column>
   <AcceptedQuestionList :workflows="data.workflows" :exporting="busy==='export'" @export="exportProject" />
   <ProjectQuestionRecords :project-id="data.project.id" :workflows="data.workflows" @refresh="refresh" />
  <v-dialog :model-value="recordsStep!==null" max-width="1280" @update:model-value="recordsStep=null"><ProjectStepRecords v-if="recordsStep" :key="`${data.project.id}-${recordsStep.ordinal}`" :step="recordsStep" :workflows="data.workflows" @close="recordsStep=null" /></v-dialog>
  <v-dialog v-model="editOpen" max-width="560"><ProjectForm v-if="editOpen" :project="data.project" @created="savedProject" @close="editOpen=false" /></v-dialog>
  <v-dialog v-model="modelSettingsOpen" max-width="980" scrollable>
   <v-card class="surface-card max-h-[90vh] overflow-hidden">
    <v-card-title class="p-20 pb-8"><Row x="between" y="center" :gap="12"><h2 class="section-title">作答模型设置</h2><v-btn icon="$close" variant="text" aria-label="关闭作答模型设置" @click="modelSettingsOpen=false" /></Row></v-card-title>
    <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
     <AnswerModelSet v-if="modelSettingsOpen" :key="data.project.id" :project-id="data.project.id" />
    </v-card-text>
   </v-card>
  </v-dialog>
  <v-dialog v-model="materialsSettingsOpen" max-width="1120" scrollable>
   <v-card class="surface-card max-h-[90vh] overflow-hidden">
    <v-card-title class="p-20 pb-8"><Row x="between" y="center" :gap="12"><h2 class="section-title">材料与 skill</h2><v-btn icon="$close" variant="text" aria-label="关闭材料与 skill 设置" @click="materialsSettingsOpen=false" /></Row></v-card-title>
    <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
     <Column :gap="16">
      <Column class="border-b border-line-subtle pb-16" :gap="8">
       <Row x="between" wrap :gap="8"><span class="text-sm font-medium">材料目录</span><v-btn :loading="busy==='sync'" :disabled="busy!==null||!data.project.material_root" @click="syncFolder">同步题目目录</v-btn></Row>
       <code class="text-xs text-muted break-all">{{ data.project.material_root || '旧项目尚未设置目录，请编辑项目' }}</code>
       <Row wrap :gap="8"><span class="text-sm font-medium">本地 skill</span><v-chip :color="data.project.skill_exists?'success':'warning'">{{ data.project.skill_exists?'已有 SKILL.md':'待生成' }}</v-chip><code class="text-xs text-muted break-all">{{ data.project.local_skill_path || '未设置' }}</code></Row>
       <v-alert v-if="syncMessage" type="info" role="status">{{ syncMessage }}</v-alert>
       <v-alert v-if="syncError" type="error" role="alert">{{ syncError }}</v-alert>
      </Column>
      <ProjectRules v-if="materialsSettingsOpen" :key="data.project.id" :project-id="data.project.id" />
     </Column>
    </v-card-text>
   </v-card>
  </v-dialog>
  <v-dialog :model-value="settings!==null" max-width="520" @update:model-value="settings=null"><StepSettings v-if="settings" :key="settings.ordinal" :project-id="data.project.id" :step="settings" @saved="refresh" @close="settings=null" @open-models="settings=null;modelSettingsOpen=true" /></v-dialog>
  <v-dialog v-model="deleteOpen" max-width="420"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除出题项目</h2><p class="text-sm text-muted">将从工作台移除此项目并停止派发任务。执行历史和本地原件保留。</p><Row x="end" :gap="8"><v-btn :disabled="busy==='delete'" @click="deleteOpen=false">取消</v-btn><v-btn color="error" variant="flat" :loading="busy==='delete'" @click="removeProject">删除项目</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
