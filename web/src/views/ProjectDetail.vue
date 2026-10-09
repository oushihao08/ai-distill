<script setup lang="ts">
import ProjectStepRecords from '../components/ProjectStepRecords.vue';
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { stages,statusLabels,type ProjectDetail,type ProjectStage,type Workflow } from '../types/api';
const route=useRoute();const router=useRouter();
const {data,error,loading,refresh}=useResource<ProjectDetail>(`/projects/${route.params.id}`);
interface ProjectMetrics {production:Record<string,number>;api_costs:{known_calls:number;known_amount_by_currency:Record<string,number>;unknown_calls:number;unknown_reasons:Record<string,number>}}
const {data:metrics,refresh:refreshMetrics}=useResource<ProjectMetrics>(`/projects/${route.params.id}/metrics`);
const tab=shallowRef('steps');const search=shallowRef('');const editOpen=shallowRef(false);const deleteOpen=shallowRef(false);
const recordsStep=shallowRef<ProjectStage|null>(null);
const settings=shallowRef<ProjectStage|null>(null);const busy=shallowRef<number|string|null>(null);const message=shallowRef('');
const unknownCostReasons=computed(()=>Object.entries(metrics.value?.api_costs.unknown_reasons??{}).map(([reason,count])=>`${({price_missing:'缺少价格',usage_missing:'缺少token用量',token_usage_incomplete:'token用量字段不完整',currency_mismatch:'币种不一致',invalid_usage_or_price:'usage或价格数据无效'} as Record<string,string>)[reason]??reason} ${count}`));
async function exportProject(){
 try{error.value='';busy.value='export';const result=await api<{id:string;workflow_count:number}>(`/projects/${route.params.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});message.value=`Excel 已生成，包含 ${result.workflow_count} 条工作流`;await refreshMetrics();window.location.assign(`/api/exports/${result.id}/download`);}
 catch(cause){error.value=cause instanceof Error?cause.message:'导出失败';}finally{busy.value=null;}
}
const visibleFlows=computed(()=>data.value?.workflows.filter(flow=>flow.title.toLowerCase().includes((search.value ?? '').toLowerCase().trim())) ?? []);
function flowState(flow:Workflow){return `${stages[(flow.current_ordinal ?? 1)-1] ?? '已完成'} · ${statusLabels[flow.current_status ?? 'succeeded']}`;}
async function runStep(step:ProjectStage){
 try{
  busy.value=step.ordinal;message.value='';
  const result=await api<{results:{status:string;reused?:boolean}[]}>(`/projects/${route.params.id}/steps/${step.ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  message.value=`${step.name}：完成 ${result.results.filter(row=>row.status==='succeeded').length}，新入队 ${result.results.filter(row=>row.status==='queued'&&!row.reused).length}，已有任务 ${result.results.filter(row=>row.status==='queued'&&row.reused).length}，未就绪 ${result.results.filter(row=>row.status==='not_ready').length}，失败 ${result.results.filter(row=>['failed','not_found'].includes(row.status)).length}`;
  await Promise.all([refresh(),refreshMetrics()]);
 }catch(cause){error.value=cause instanceof Error?cause.message:'执行失败';}finally{busy.value=null;}
}
async function syncFolder(){
 try{busy.value='sync';const result=await api<{discovered:number;added:number;changed:number}>(`/projects/${route.params.id}/sync-folder`,{method:'POST'});message.value=`发现 ${result.discovered} 道题目，新增 ${result.added}，材料变化 ${result.changed}。变化的题目从第一步重新接收。`;await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'同步失败';}finally{busy.value=null;}
}
async function removeProject(){
 try{busy.value='delete';await api(`/projects/${route.params.id}`,{method:'DELETE'});await router.push('/');}
 catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{busy.value=null;}
}
async function savedProject(){editOpen.value=false;await refresh();}
let timer:ReturnType<typeof setInterval>|undefined;
watch(()=>data.value?.steps.some(step=>step.running>0||step.queued>0),active=>{if(timer)clearInterval(timer);if(active)timer=setInterval(()=>{if(!loading.value){refresh();refreshMetrics();}},3000);});
onUnmounted(()=>{if(timer)clearInterval(timer);});
</script>
<template><Column :gap="16">
 <RouterLink to="/" class="link-text text-sm">← 全部出题项目</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <p v-if="loading&&!data" class="text-muted">正在读取项目…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="12"><Column :gap="6" class="min-w-0"><h1 class="text-2xl font-bold text-ink-heading break-words">{{ data.project.name }}</h1><p v-if="data.project.description" class="text-sm text-muted">{{ data.project.description }}</p></Column><Row wrap :gap="8"><v-btn :disabled="busy!==null" @click="editOpen=true">编辑项目</v-btn><v-btn :loading="loading" @click="refresh">刷新</v-btn><v-btn color="error" :disabled="busy!==null" @click="deleteOpen=true">删除</v-btn></Row></Row>
  <Column class="surface-card p-16" :gap="8"><Row x="between" wrap :gap="8"><span class="text-sm font-medium">材料目录</span><v-btn :loading="busy==='sync'" :disabled="busy!==null||!data.project.material_root" @click="syncFolder">同步题目目录</v-btn></Row><code class="text-xs text-muted break-all">{{ data.project.material_root || '旧项目尚未设置目录，请编辑项目' }}</code><Row wrap :gap="8"><span class="text-sm font-medium">本地 skill</span><v-chip :color="data.project.skill_exists?'success':'warning'">{{ data.project.skill_exists?'已有 SKILL.md':'待生成' }}</v-chip><code class="text-xs text-muted break-all">{{ data.project.local_skill_path || '未设置' }}</code></Row></Column>
  <v-tabs v-model="tab" color="primary"><v-tab value="steps">执行步骤</v-tab><v-tab value="questions">题目记录 · {{ data.workflows.length }}</v-tab><v-tab value="models">作答模型</v-tab><v-tab value="rules">资料与 skill</v-tab></v-tabs>
  <v-alert v-if="message" type="info" role="status">{{ message }}</v-alert>
  <template v-if="tab==='steps'">
   <ProjectCodexSettings :key="data.project.id" :project-id="data.project.id" />
   <Column v-if="metrics" class="surface-panel" :gap="8"><Row x="between" wrap :gap="12"><span class="text-sm font-semibold">项目产量与 API 费用</span><v-btn size="small" :loading="busy==='export'" :disabled="busy!==null" @click="exportProject">导出 Excel</v-btn></Row><Row wrap :gap="8"><v-chip>启动 {{ metrics.production.started }}</v-chip><v-chip>处理成功 {{ metrics.production.processed }}</v-chip><v-chip>已出题 {{ metrics.production.authored }}</v-chip><v-chip>质检通过 {{ metrics.production.quality_passed }}</v-chip><v-chip>有效评测 {{ metrics.production.valid_assessments }}</v-chip><v-chip color="success">合格 {{ metrics.production.accepted }}</v-chip><v-chip color="error">隔离 {{ metrics.production.quarantined }}</v-chip><v-chip>已导出 {{ metrics.production.exported }}</v-chip></Row><p class="text-xs text-muted">API 费用：{{ Object.entries(metrics.api_costs.known_amount_by_currency).map(([currency,amount])=>`${currency} ${amount}`).join(' · ') || '暂无已知费用' }}；未知调用 {{ metrics.api_costs.unknown_calls }}。GPT/Codex 套餐不计入。</p><p v-if="unknownCostReasons.length" class="text-xs text-muted">未知原因：{{ unknownCostReasons.join(' · ') }}</p></Column>
   <p class="text-xs text-muted">执行按钮只派发已就绪题目。第一步未完成的记录不会进入第二步，成功记录无需等待其他题目。</p>
   <Column :gap="10"><section v-for="step in data.steps" :key="step.ordinal" class="surface-card p-16"><Row x="between" wrap :gap="12"><Row :gap="12"><v-avatar color="primary" variant="tonal" size="32"><span class="text-sm">{{ step.position }}</span></v-avatar><Column :gap="6"><button type="button" class="bg-transparent border-none p-0 text-left text-sm font-semibold text-ink-heading hover:text-primary cursor-pointer" @click="recordsStep=step">{{ step.name }}</button><Row wrap :gap="12" class="text-xs text-muted"><span class="text-primary">就绪 {{ step.ready }}</span><span>排队 {{ step.queued }}</span><span>运行 {{ step.running }}</span><span class="text-success">成功 {{ step.succeeded }}</span><span :class="step.failed?'text-danger':''">失败 {{ step.failed }}</span></Row></Column></Row><Row :gap="8"><v-btn @click="recordsStep=step">查看题目</v-btn><v-btn v-if="[9,4,6,7].includes(step.ordinal)" @click="settings=step">设置</v-btn><v-btn color="primary" variant="flat" :loading="busy===step.ordinal" :disabled="busy!==null||!step.implemented||step.ready===0" @click="runStep(step)">{{ step.implemented?`执行就绪 ${step.ready}`:'尚未接入' }}</v-btn></Row></Row></section></Column>
  </template>
  <Column v-else-if="tab==='questions'" class="surface-card p-16" :gap="12">
   <Row x="between" wrap :gap="12">
    <h2 class="section-title">单条题目执行情况</h2>
    <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索题目" hide-details clearable class="filter-field-compact" />
   </Row>
   <p v-if="!visibleFlows.length" class="text-sm text-muted">暂无题目。将PDF放入材料目录下的题目子文件夹，再同步目录。</p>
   <Column v-else class="w-full overflow-x-auto">
    <v-table density="comfortable" class="min-w-720px">
     <thead><tr><th scope="col">题目</th><th scope="col">材料数</th><th scope="col">材料版本</th><th scope="col">当前进度</th><th scope="col">操作</th></tr></thead>
     <tbody>
      <tr v-for="flow in visibleFlows" :key="flow.id">
       <td class="min-w-240px"><RouterLink :to="`/workflows/${flow.id}`" class="link-text font-medium break-words">{{ flow.title }}</RouterLink></td>
       <td class="whitespace-nowrap">{{ flow.material_count || flow.source_manifest?.length || 0 }} 份</td>
       <td class="whitespace-nowrap">v{{ flow.input_revision }}</td>
       <td><v-chip :color="flow.current_status==='failed'?'error':'secondary'">{{ flowState(flow) }}</v-chip></td>
       <td><v-btn :to="`/workflows/${flow.id}`" variant="text" color="primary">查看</v-btn></td>
      </tr>
     </tbody>
    </v-table>
   </Column>
  </Column>
  <AnswerModelSet v-else-if="tab==='models'" :key="data.project.id" :project-id="data.project.id" />
  <ProjectRules v-else :key="data.project.id" :project-id="data.project.id" />
  <v-dialog :model-value="recordsStep!==null" max-width="1280" @update:model-value="recordsStep=null"><ProjectStepRecords v-if="recordsStep" :key="`${data.project.id}-${recordsStep.ordinal}`" :step="recordsStep" :workflows="data.workflows" @close="recordsStep=null" /></v-dialog>
  <v-dialog v-model="editOpen" max-width="560"><ProjectForm v-if="editOpen" :project="data.project" @created="savedProject" @close="editOpen=false" /></v-dialog>
  <v-dialog :model-value="settings!==null" max-width="520" @update:model-value="settings=null"><StepSettings v-if="settings" :key="settings.ordinal" :project-id="data.project.id" :step="settings" @saved="refresh" @close="settings=null" @open-models="settings=null;tab='models'" /></v-dialog>
  <v-dialog v-model="deleteOpen" max-width="420"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除出题项目</h2><p class="text-sm text-muted">将从工作台移除此项目并停止派发任务。执行历史和本地原件保留。</p><Row x="end" :gap="8"><v-btn :disabled="busy==='delete'" @click="deleteOpen=false">取消</v-btn><v-btn color="error" variant="flat" :loading="busy==='delete'" @click="removeProject">删除项目</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
