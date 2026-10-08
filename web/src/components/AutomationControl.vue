<script setup lang="ts">
import {api} from '../api/client';
const props=defineProps<{projectId:string;workflows:{id:string;title:string}[]}>();
const emit=defineEmits<{changed:[]}>();
interface Batch {id:string;mode:string;status:string;members:{workflow_id:string;status:string;reason:string|null}[]}
interface ExecutorBlock {executor:string;reason:string}
const batches=shallowRef<Batch[]>([]);const blocks=shallowRef<ExecutorBlock[]>([]);const paused=shallowRef(false);
const mode=shallowRef('horizontal');const busy=shallowRef(false);const error=shallowRef('');
const selectedIds=shallowRef<string[]>([]);
const workflowItems=computed(()=>props.workflows.map(workflow=>({title:workflow.title,value:workflow.id})));
const blockedMembers=computed(()=>Object.fromEntries(batches.value.map(batch=>[batch.id,batch.members.filter(member=>member.reason)])));
const labels:Record<string,string>={running:'执行中',paused:'已暂停',cancelled:'已取消',completed:'已完成',blocked:'需处理',authentication:'认证阻断',quota:'额度阻断',step_failed:'步骤失败，请检查后恢复',input_changed:'材料版本已变化，请检查后恢复',batch_cancelled:'批次已取消',project_cancelled:'项目已取消'};
async function refresh(){
 try{const [runs,executors,project]=await Promise.all([api<Batch[]>(`/projects/${props.projectId}/automation`),api<ExecutorBlock[]>('/executor-blocks'),api<{project:{execution_paused:boolean}}>(`/projects/${props.projectId}`)]);batches.value=runs;blocks.value=executors;paused.value=project.project.execution_paused;}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取控制状态失败';}
}
async function act(path:string,body?:unknown){
 try{busy.value=true;error.value='';await api(path,{method:'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});await refresh();emit('changed');}
 catch(cause){error.value=cause instanceof Error?cause.message:'控制失败';}finally{busy.value=false;}
}
let timer:ReturnType<typeof setInterval>|undefined;
onMounted(async()=>{try{await refresh();timer=setInterval(()=>{if(!busy.value&&batches.value.some(batch=>batch.status==='running'))void refresh();},3000);}catch(cause){error.value=cause instanceof Error?cause.message:'初始化失败';}});
onUnmounted(()=>{if(timer)clearInterval(timer);});
</script>
<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap :gap="8"><h2 class="section-title">自动推进与运行控制</h2><Row :gap="8"><v-chip>{{ paused?'项目已暂停':'项目允许执行' }}</v-chip><v-btn size="small" :disabled="busy" @click="refresh">刷新控制状态</v-btn></Row></Row>
  <v-alert v-if="error" type="error">{{ error }}</v-alert>
  <v-autocomplete v-model="selectedIds" :items="workflowItems" multiple chips clearable hide-details label="批次题目（不选表示全部，最多100题）" />
  <Row wrap :gap="8"><v-select v-model="mode" :items="[{title:'横向：每题逐步跑到底',value:'horizontal'},{title:'纵向：按阶段推进成功题目',value:'vertical'}]" hide-details aria-label="自动推进模式" class="filter-field-compact" /><v-btn color="primary" :disabled="busy||paused||selectedIds.length>100" @click="act(`/projects/${projectId}/automation`,{mode,...(selectedIds.length?{workflow_ids:selectedIds}:{})})">启动自动批次</v-btn><v-btn :disabled="busy" @click="act(`/projects/${projectId}/execution/${paused?'resume':'pause'}`)">{{ paused?'恢复项目':'暂停项目' }}</v-btn><v-btn color="error" :disabled="busy" @click="act(`/projects/${projectId}/execution/cancel`)">取消项目执行</v-btn></Row>
  <p class="text-xs text-muted">暂停停止新任务领取，当前任务继续；取消停止当前任务并阻止结果发布。恢复失败批次会重试未完成步骤，已成功结果保留。</p>
  <Row v-for="block in blocks" :key="block.executor" wrap :gap="8"><v-chip color="warning">{{ block.executor }} · {{ labels[block.reason] }}</v-chip><v-btn size="small" :disabled="busy" @click="act(`/executor-blocks/${encodeURIComponent(block.executor)}/resume`)">凭证／额度处理后重新尝试</v-btn></Row>
  <Column v-for="batch in batches" :key="batch.id" :gap="6" class="border-t border-line-subtle pt-12">
   <Row x="between" wrap :gap="8"><span class="text-sm">{{ batch.mode==='horizontal'?'横向':'纵向' }} · {{ labels[batch.status] }} · {{ batch.members.length }} 题</span><Row :gap="8"><v-btn v-if="batch.status==='running'" size="small" :disabled="busy" @click="act(`/projects/${projectId}/automation/${batch.id}/pause`)">暂停</v-btn><v-btn v-if="['paused','blocked','cancelled'].includes(batch.status)" size="small" :disabled="busy" @click="act(`/projects/${projectId}/automation/${batch.id}/resume`)">恢复</v-btn><v-btn v-if="['running','paused','blocked'].includes(batch.status)" size="small" color="error" :disabled="busy" @click="act(`/projects/${projectId}/automation/${batch.id}/cancel`)">取消</v-btn></Row></Row>
   <p v-for="member in blockedMembers[batch.id]" :key="member.workflow_id" class="text-xs text-muted"><RouterLink :to="`/workflows/${member.workflow_id}`" class="link-text">查看题目</RouterLink> · {{ labels[member.reason!]??member.reason }}</p>
  </Column>
 </Column>
</template>
