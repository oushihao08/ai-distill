<!-- 职责：按需查看单题钩子记录，提交原尝试续跑或异步附加任务重试；props 指定工作流，updated 通知详情刷新，不自动轮询。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
interface HookRun {id:string;attempt_id:string;stage:string;position:string;action_id:string;mode:string;status:string;idempotent:boolean;error:string|null;result:unknown;history:unknown[];created_at:string;checkpoint_available:boolean}
const props=defineProps<{workflowId:string}>();
const emit=defineEmits<{updated:[]}>();
const opened=shallowRef(false),busy=shallowRef(false),error=shallowRef(''),notice=shallowRef('');
const runs=shallowRef<HookRun[]>([]),available=shallowRef(true),pending=shallowRef<HookRun|null>(null),ack=shallowRef(false);
const stageNames:Record<string,string>={authoring:'出题',answer:'作答',scoring:'评分'};
const statusNames:Record<string,string>={waiting:'等待',running:'执行中',succeeded:'成功',failed:'失败',cancelled:'已取消',needs_review:'待核实'};
async function load(){
 try{busy.value=true;error.value='';const result=await api<{available:boolean;runs:HookRun[]}>(`/workflows/${props.workflowId}/hooks`);available.value=result.available;runs.value=result.runs;}
 catch(cause){error.value=cause instanceof Error?(cause.message==='接口不存在'?'当前 API 尚未加载钩子接口，更新服务后再查看。':cause.message):'读取钩子记录失败';}finally{busy.value=false;}
}
async function open(){opened.value=!opened.value;if(opened.value)await load();}
function prepare(run:HookRun){pending.value=run;ack.value=false;notice.value='';}
async function retry(){
 const run=pending.value;if(!run)return;
 try{
  busy.value=true;error.value='';
  await api(run.mode==='async'?`/hooks/${run.id}/retry`:`/attempts/${run.attempt_id}/resume-hooks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acknowledge_side_effects:ack.value})});
  pending.value=null;notice.value='已提交，执行结果请刷新查看';emit('updated');await load();
 }catch(cause){error.value=cause instanceof Error?cause.message:'续跑提交失败';}finally{busy.value=false;}
}
</script>
<template><section class="surface-card p-16"><Column :gap="12">
 <Row x="between" wrap :gap="8"><h2 class="section-title">项目钩子</h2><Row :gap="8"><v-btn variant="text" :disabled="busy" @click="open">{{ opened?'收起':'查看记录' }}</v-btn><v-btn v-if="opened" variant="outlined" :loading="busy" @click="load">刷新</v-btn></Row></Row>
 <v-alert v-if="error" type="error">{{ error }}</v-alert><v-alert v-if="notice" type="info">{{ notice }}</v-alert>
 <template v-if="opened&&!error">
  <p v-if="!available" class="text-sm text-muted">尚未应用钩子记录迁移；原流程可继续使用。</p>
  <p v-else-if="!runs.length" class="text-sm text-muted">暂无钩子执行记录，未配置钩子的步骤按原流程执行。</p>
  <Column v-for="run in runs" :key="run.id" :gap="8" class="border-t border-line-subtle pt-12">
   <Row wrap x="between" :gap="8"><span class="text-sm">{{ stageNames[run.stage]??run.stage }} · {{ run.position==='before'?'执行前':'执行后' }} · {{ run.action_id }} · {{ run.mode==='async'?'异步':'同步' }} · {{ statusNames[run.status]??run.status }}</span><v-btn v-if="['failed','needs_review','cancelled'].includes(run.status)" size="small" :disabled="busy" @click="prepare(run)">{{ run.mode==='async'?'重试附加任务':'续跑原尝试' }}</v-btn></Row>
   <p class="text-xs text-muted">{{ dateLabel(run.created_at) }} · {{ run.attempt_id }}</p>
   <p v-if="run.error" class="text-sm">{{ run.error }}</p>
   <details v-if="run.result||run.history?.length"><summary class="text-sm cursor-pointer">结果与历史</summary><pre class="text-xs whitespace-pre-wrap break-words">{{ JSON.stringify({result:run.result,history:run.history},null,2) }}</pre></details>
  </Column>
 </template>
 <v-dialog :model-value="!!pending" max-width="650" @update:model-value="value=>{if(!value)pending=null;}"><v-card class="surface-card"><v-card-title>确认钩子续跑</v-card-title><v-card-text><Column :gap="12">
  <p>异步任务独立重试；同步任务沿原尝试继续，已保存的主操作检查点会被复用。输入失效或主操作状态未知时服务端会拒绝。</p>
  <v-checkbox v-if="pending&&!pending.idempotent" v-model="ack" label="已核实上次副作用，允许再次执行此钩子" hide-details />
 </Column></v-card-text><v-card-actions><v-spacer /><v-btn :disabled="busy" @click="pending=null">取消</v-btn><v-btn color="primary" :loading="busy" :disabled="busy||!!pending&&!pending.idempotent&&!ack" @click="retry">提交续跑</v-btn></v-card-actions></v-card></v-dialog>
</Column></section></template>
