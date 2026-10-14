<!--
职责：作为项目详情路由，编排材料包／题目列表、设置弹窗、步骤派发、分页题目记录及导出。
关键方法与用法：`runStep()` 派发步骤，`syncFolder()` 同步来源目录，`removeProject()` 删除项目，`exportProject()` 先补齐达标题目的脱敏附件，再生成并下载 Excel；路由参数 `id` 指定项目。
-->

<script setup lang="ts">
import ProjectStepRecords from '../components/ProjectStepRecords.vue';
import ProjectQuestionRecords from '../components/ProjectQuestionRecords.vue';
import ProjectMaterialRecords from '../components/ProjectMaterialRecords.vue';
import AcceptedQuestionList from '../components/AcceptedQuestionList.vue';
import AnswerGenerationPolicySettings from '../components/AnswerGenerationPolicySettings.vue';
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { type ProjectDetail,type ProjectStage } from '../types/api';
const route=useRoute();const router=useRouter();
const {data,error,loading,refresh}=useResource<ProjectDetail>(`/projects/${route.params.id}`);
const editOpen=shallowRef(false);const deleteOpen=shallowRef(false);const modelSettingsOpen=shallowRef(false);const materialsSettingsOpen=shallowRef(false);
const recordsStep=shallowRef<ProjectStage|null>(null);
const settings=shallowRef<ProjectStage|null>(null);const busy=shallowRef<number|string|null>(null);const message=shallowRef('');
const exportError=shallowRef('');
const batchFailures=shallowRef<{workflow_id:string;title:string;reason:string}[]>([]);
const syncMessage=shallowRef('');const syncError=shallowRef('');
const materialPackages=computed(()=>data.value?.workflows.filter(flow=>flow.workflow_kind==='material_package')??[]);
const questionWorkflows=computed(()=>data.value?.workflows.filter(flow=>flow.workflow_kind!=='material_package')??[]);
const authorablePackages=computed(()=>materialPackages.value.filter(pkg=>pkg.material_redaction_status==='succeeded'&&!questionWorkflows.value.some(question=>question.source_workflow_id===pkg.id)));
function readyCount(step:ProjectStage){return step.ready+(step.ordinal===4?authorablePackages.value.length:0);}
const recordsWorkflows=computed(()=>recordsStep.value&&[1,9].includes(recordsStep.value.ordinal)&&data.value?.project.material_mode==='material_packages'?materialPackages.value:questionWorkflows.value);
async function exportProject(){
 try{
  exportError.value='';busy.value='export';
  const accepted=questionWorkflows.value.filter(flow=>flow.current_ordinal===7&&flow.current_decision==='accepted');
  let generated=0,reused=0;
  for(let index=0;index<accepted.length;index++){
   const flow=accepted[index]!;message.value=`正在检查并准备脱敏附件 DOCX（${index+1}/${accepted.length}）：${flow.title}`;
   const result=await api<{reused:boolean}>(`/workflows/${flow.id}/redacted-docx`,{method:'POST'});
   if(result.reused)reused++;else generated++;
  }
  message.value=`脱敏附件已准备（新生成 ${generated} 题，复用 ${reused} 题），正在生成 Excel…`;
  const result=await api<{id:string;workflow_count:number}>(`/projects/${route.params.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  message.value=`Excel 已生成，包含 ${result.workflow_count} 道达标题目，正在下载`;window.location.assign(`/api/exports/${result.id}/download`);
 }catch(cause){exportError.value=cause instanceof Error?cause.message:'导出失败';}finally{busy.value=null;}
}
const visibleSteps=computed(()=>data.value?.steps.filter(step=>step.ordinal!==10)??[]);
async function runStep(step:ProjectStage){
 try{
  busy.value=step.ordinal;message.value='';error.value='';batchFailures.value=[];
  const createdIds:string[]=[];
  if(step.ordinal===4){
   for(const pkg of authorablePackages.value){
    try{
     const versions=await api<{id:string}[]>(`/material-packages/${pkg.id}/versions`);
     if(!versions[0])throw new Error('没有可用的成功脱敏版本');
     const created=await api<{id:string}>(`/material-packages/${pkg.id}/questions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:pkg.title,redaction_attempt_id:versions[0].id})});
     createdIds.push(created.id);
    }catch(cause){batchFailures.value.push({workflow_id:pkg.id,title:pkg.title,reason:cause instanceof Error?cause.message:'建题失败'});}
   }
  }
  const result=await api<{results:{workflow_id:string;status:string;reused?:boolean;attempt_ids?:string[];reason?:string}[]}>(`/projects/${route.params.id}/steps/${step.ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(step.ordinal===4?{workflow_ids:[...questionWorkflows.value.map(question=>question.id),...createdIds]}:{})});
  const queued=result.results.filter(item=>item.status==='queued').length;
  const completed=result.results.filter(item=>item.status==='succeeded').length;
  const notReady=result.results.filter(item=>item.status==='not_ready').length;
  const failed=result.results.filter(item=>item.status==='failed'||item.status==='not_found').length;
  const taskCount=(item:{attempt_ids?:string[]})=>item.attempt_ids?.length??1;
  const newTasks=result.results.filter(item=>item.status==='queued'&&!item.reused).reduce((sum,item)=>sum+taskCount(item),0);
  const reusedTasks=result.results.filter(item=>item.status==='queued'&&item.reused).reduce((sum,item)=>sum+taskCount(item),0);
  batchFailures.value.push(...result.results.filter(item=>item.status==='failed'||item.status==='not_found'||item.status==='not_ready').map(item=>({workflow_id:item.workflow_id,title:data.value?.workflows.find(workflow=>workflow.id===item.workflow_id)?.title??item.workflow_id,reason:item.reason??'派发失败，请查看服务端日志'})));
  message.value=`${step.name}批量执行结果：新建 ${createdIds.length} 道题，新派发 ${newTasks} 个任务（${queued} 道题），复用 ${reusedTasks} 个已有任务，已完成 ${completed} 道，未就绪 ${notReady} 道，失败 ${failed+batchFailures.value.filter(item=>materialPackages.value.some(pkg=>pkg.id===item.workflow_id)).length} 道。`;
  await refresh();
 }catch(cause){error.value=cause instanceof Error?cause.message:'执行失败';await refresh();}finally{busy.value=null;}
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
</script>
<template><Column :gap="16">
 <RouterLink to="/" class="link-text text-sm">← 全部出题项目</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <p v-if="loading&&!data" class="text-muted">正在读取项目…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="12"><Column :gap="6" class="min-w-0"><h1 class="text-2xl font-bold text-ink-heading break-words">{{ data.project.name }}</h1><p v-if="data.project.description" class="text-sm text-muted">{{ data.project.description }}</p></Column><Row wrap :gap="8"><v-btn @click="modelSettingsOpen=true">作答模型设置</v-btn><v-btn @click="openMaterialsSettings">材料与 skill</v-btn><v-btn :disabled="busy!==null" @click="editOpen=true">编辑项目</v-btn><v-btn :loading="loading" @click="refresh">刷新</v-btn><v-btn color="error" :disabled="busy!==null" @click="deleteOpen=true">删除</v-btn></Row></Row>
  <v-alert v-if="message" type="info" role="status"><Column :gap="6"><span>{{ message }}</span><details v-if="batchFailures.length"><summary class="cursor-pointer">查看派发失败题目</summary><ul class="my-0 pl-20"><li v-for="item in batchFailures" :key="item.workflow_id">{{ item.title }}（{{ item.workflow_id }}）：{{ item.reason }}</li></ul></details></Column></v-alert>
   <ProjectCodexSettings :key="data.project.id" :project-id="data.project.id" />
  <p class="text-xs text-muted">状态在打开页面、提交操作或手动刷新时更新。批量出题会先为已脱敏且尚无题目的材料包建立首道题，再派发就绪题目。第一步未完成的记录不会进入第二步。</p>
  <Column :gap="10"><section v-for="step in visibleSteps" :key="step.ordinal" class="surface-card p-16"><Row x="between" wrap :gap="12"><Row :gap="12"><v-avatar color="primary" variant="tonal" size="32"><span class="text-sm">{{ step.position }}</span></v-avatar><Column :gap="6"><button type="button" class="bg-transparent border-none p-0 text-left text-sm font-semibold text-ink-heading hover:text-primary cursor-pointer" @click="recordsStep=step">{{ step.name }}</button><Row wrap :gap="12" class="text-xs text-muted"><span class="text-primary">就绪 {{ readyCount(step) }}</span><span>排队 {{ step.queued }}</span><span>运行 {{ step.running }}</span><template v-if="step.ordinal===7"><span class="text-success">达标 {{ step.succeeded }}</span><span class="text-warning-text">未达标 {{ step.needs_repair }}</span><span v-if="step.quarantined" class="text-danger">隔离 {{ step.quarantined }}</span></template><span v-else class="text-success">成功 {{ step.succeeded }}</span><span :class="step.failed?'text-danger':''">失败 {{ step.failed }}</span></Row></Column></Row><Row :gap="8"><v-btn @click="recordsStep=step">{{ data.project.material_mode==='material_packages'&&[1,9].includes(step.ordinal)?'查看材料包':'查看题目' }}</v-btn><v-btn v-if="[9,4,5,6].includes(step.ordinal)" @click="settings=step">{{ step.ordinal===5?'流程设置':'设置' }}</v-btn><v-btn color="primary" variant="flat" :loading="busy===step.ordinal" :disabled="busy!==null||!step.implemented||readyCount(step)===0" @click="runStep(step)">{{ step.ordinal===7?'批量判断':step.implemented?`执行就绪 ${readyCount(step)}`:'尚未接入' }}</v-btn></Row></Row></section></Column>
   <ProjectMaterialRecords v-if="data.project.material_mode==='material_packages'" :project-id="data.project.id" :packages="materialPackages" :questions="questionWorkflows" />
   <ProjectQuestionRecords :project-id="data.project.id" :workflows="questionWorkflows" :packages="materialPackages" :material-packages-enabled="data.project.material_mode==='material_packages'" @refresh="refresh" />
   <AcceptedQuestionList :workflows="questionWorkflows" :packages="materialPackages" :exporting="busy==='export'" :export-error="exportError" @export="exportProject" />
  <v-dialog :model-value="recordsStep!==null" max-width="1280" @update:model-value="recordsStep=null"><ProjectStepRecords v-if="recordsStep" :key="`${data.project.id}-${recordsStep.ordinal}`" :step="recordsStep" :workflows="recordsWorkflows" @close="recordsStep=null" /></v-dialog>
  <v-dialog v-model="editOpen" max-width="560"><ProjectForm v-if="editOpen" :project="data.project" @created="savedProject" @close="editOpen=false" /></v-dialog>
  <v-dialog v-model="modelSettingsOpen" max-width="980" scrollable>
   <v-card class="surface-card max-h-[90vh] overflow-hidden">
    <v-card-title class="p-20 pb-8"><Row x="between" y="center" :gap="12"><h2 class="section-title">作答模型设置</h2><v-btn icon="$close" variant="text" aria-label="关闭作答模型设置" @click="modelSettingsOpen=false" /></Row></v-card-title>
    <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
     <Column :gap="20"><AnswerModelSet v-if="modelSettingsOpen" :key="data.project.id" :project-id="data.project.id" /><AnswerGenerationPolicySettings v-if="modelSettingsOpen" :key="`${data.project.id}-answer-policy`" :project-id="data.project.id" /></Column>
    </v-card-text>
   </v-card>
  </v-dialog>
  <v-dialog v-model="materialsSettingsOpen" max-width="1120" scrollable>
   <v-card class="surface-card max-h-[90vh] overflow-hidden">
    <v-card-title class="p-20 pb-8"><Row x="between" y="center" :gap="12"><h2 class="section-title">材料与 skill</h2><v-btn icon="$close" variant="text" aria-label="关闭材料与 skill 设置" @click="materialsSettingsOpen=false" /></Row></v-card-title>
    <v-card-text class="min-h-0 overflow-y-auto p-20 pt-0">
     <Column :gap="16">
      <Column class="border-b border-line-subtle pb-16" :gap="8">
       <Row x="between" wrap :gap="8"><span class="text-sm font-medium">本期{{ data.project.material_mode==='material_packages'?'材料包':'题目' }}来源目录</span><v-btn :loading="busy==='sync'" :disabled="busy!==null||!data.project.material_root" @click="syncFolder">同步{{ data.project.material_mode==='material_packages'?'材料包':'题目' }}目录</v-btn></Row>
       <code class="text-xs text-muted break-all">{{ data.project.material_root || '旧项目尚未设置目录，请编辑项目' }}</code>
       <v-alert v-if="data.project.material_mode!=='material_packages'" type="info" density="compact">这是保留原有工作流记录的历史项目，页面不会自动转换或隐藏旧题。新建项目统一使用材料包创建多题流程。</v-alert>
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
  <v-dialog v-model="deleteOpen" max-width="560"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除项目和题目数据</h2><p class="text-sm text-muted">将从工作台移除项目，并删除数据库中的题目、附件记录、步骤结果、答案、评分、题目执行历史和导出记录。项目模型与步骤配置、skill 生成记录、全局模型配置会保留；本地来源材料、skill、管理副本和导出文件均不会删除。此操作无法在页面恢复。</p><Row x="end" :gap="8"><v-btn :disabled="busy==='delete'" @click="deleteOpen=false">取消</v-btn><v-btn color="error" variant="flat" :loading="busy==='delete'" @click="removeProject">删除项目</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
