<script setup lang="ts">
import {api} from '../api/client';
import {useResource} from '../composables/useResource';
import {dateLabel} from '../utils/format';
import type {Attempt} from '../../../shared/types';
const props=defineProps<{workflowId:string;inputRevision:number;attempts:Attempt[];disabled?:boolean}>();
const emit=defineEmits<{updated:[]}>();
interface Chain {id:string;input_revision:number;status:string;reason:string|null;content_revisions:number;technical_retries:number;calls_reserved:number;spent_duration_ms:number|string;created_at:string}
interface Round {id:string;chain_id:string;round:number;status:string;issue_kind:string;decision:{reason:string};evidence:unknown;before_versions:unknown;after_versions:unknown;before_scores:unknown;after_scores:unknown}
const {data,error,refresh}=useResource<{chains:Chain[];rounds:Round[]}>(`/workflows/${props.workflowId}/revisions`);
const busy=shallowRef(false),failure=shallowRef('');
const active=computed(()=>data.value?.chains.find(chain=>chain.input_revision===props.inputRevision&&['waiting','running','blocked'].includes(chain.status)));
const source=computed(()=>props.attempts.filter(attempt=>attempt.input_revision===props.inputRevision).toSorted((a,b)=>new Date(b.finished_at??b.started_at).getTime()-new Date(a.finished_at??a.started_at).getTime()).find(attempt=>[2,4,5,6,9].includes(attempt.ordinal)&&attempt.status==='failed'||attempt.ordinal===2&&Array.isArray((attempt.result as any)?.issues)&&(attempt.result as any).issues.length>0||attempt.ordinal===7&&(attempt.result as {decision?:string}|null)?.decision==='repair'));
const labels:Record<string,string>={waiting:'待执行',running:'执行中',blocked:'等待处理',accepted:'已合格',isolated:'已隔离',stale:'版本失效',succeeded:'完成',failed:'失败'};
async function execute(chain?:Chain){
 busy.value=true;failure.value='';
 try{
  if(chain)await api(`/workflows/${props.workflowId}/revisions/${chain.id}/resume`,{method:'POST'});
  else if(source.value)await api(`/workflows/${props.workflowId}/revisions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_attempt_id:source.value.id})});
  await refresh();emit('updated');
 }catch(cause){failure.value=cause instanceof Error?cause.message:'返修操作失败';}
 finally{busy.value=false;}
}
watch(()=>props.attempts,()=>{void refresh();});
let poll:ReturnType<typeof setInterval>|undefined;
async function refreshRunning(){try{await refresh();emit('updated');}catch(cause){failure.value=cause instanceof Error?cause.message:'刷新返修状态失败';}}
onMounted(()=>{poll=setInterval(()=>{if(active.value&&['waiting','running'].includes(active.value.status))void refreshRunning();},3000);});
onUnmounted(()=>{if(poll)clearInterval(poll);});
</script>

<template>
 <section class="surface-card p-16"><Column :gap="12">
  <Row x="between" wrap :gap="8"><h2 class="section-title">返修记录</h2><Row :gap="8"><v-btn :loading="busy" :disabled="disabled||busy||!source||!!active" @click="execute()">启动有限返修</v-btn><v-btn :disabled="busy" @click="refresh">刷新</v-btn></Row></Row>
  <v-alert v-if="error||failure" type="error">{{failure||error}}</v-alert>
  <p v-if="!data?.chains.length" class="text-sm text-muted">尚无返修链。启动前需配置技术次数、调用和有效耗时上限。</p>
  <Column v-for="chain in data?.chains" :key="chain.id" class="border-t border-line-subtle pt-12" :gap="8">
   <Row wrap :gap="8"><v-chip>{{labels[chain.status]??chain.status}}</v-chip><span class="text-xs text-muted">材料版本 {{chain.input_revision}} · {{dateLabel(chain.created_at)}}</span><v-btn v-if="chain.status==='blocked'&&chain.input_revision===inputRevision" :loading="busy" :disabled="disabled||busy" @click="execute(chain)">处理后恢复</v-btn></Row>
   <p class="text-sm">内容返修 {{chain.content_revisions}} 次 · 技术重试 {{chain.technical_retries}} 次 · 调用预留 {{chain.calls_reserved}} 次 · 有效耗时 {{(Number(chain.spent_duration_ms)/1000).toFixed(1)}} 秒</p>
   <p v-if="chain.reason" class="text-sm text-muted break-all">{{chain.reason}}</p>
   <details v-for="round in data?.rounds.filter(item=>item.chain_id===chain.id)" :key="round.id" class="text-sm"><summary class="cursor-pointer link-text">第 {{round.round}} 轮 · {{round.issue_kind}} · {{labels[round.status]??round.status}}</summary><pre class="surface-panel mt-8 whitespace-pre-wrap break-all text-xs">{{JSON.stringify({原因:round.decision.reason,依据:round.evidence,修订前版本:round.before_versions,修订后版本:round.after_versions,修订前评分:round.before_scores,修订后评分:round.after_scores},null,2)}}</pre></details>
  </Column>
 </Column></section>
</template>
