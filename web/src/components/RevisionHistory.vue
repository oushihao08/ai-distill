<!--
职责：展示单题返修链、轮次和问题依据，并启动或恢复有限返修。
关键方法与用法：`execute()` 提交启动／恢复请求，`refreshRunning()` 轮询活动状态；工作流详情页传入当前步骤及尝试记录，并在 `updated` 事件后刷新。
-->

<script setup lang="ts">
import {api} from '../api/client';
import {useResource} from '../composables/useResource';
import {dateLabel} from '../utils/format';
import type {Attempt,Step} from '@shared/types';
const props=defineProps<{workflowId:string;attempts:Attempt[];steps:Step[];disabled?:boolean}>();
const emit=defineEmits<{updated:[]}>();
interface Chain {id:string;status:string;reason:string|null;content_revisions:number;technical_retries:number;calls_reserved:number;spent_duration_ms:number|string;created_at:string}
interface Round {id:string;chain_id:string;round:number;status:string;issue_kind:string;decision:{reason:string};evidence:unknown;before_versions:unknown;after_versions:unknown;before_scores:unknown;after_scores:unknown}
const {data,error,refresh}=useResource<{chains:Chain[];rounds:Round[]}>(`/workflows/${props.workflowId}/revisions`);
const busy=shallowRef(false),failure=shallowRef('');
const active=computed(()=>data.value?.chains.find(chain=>['waiting','running','blocked'].includes(chain.status)));
const source=computed(()=>{
 const latest=new Map<number,Attempt>();
 const attempts=props.attempts.toSorted((a,b)=>new Date(b.finished_at??b.started_at).getTime()-new Date(a.finished_at??a.started_at).getTime());
 for(const attempt of attempts)if(!latest.has(attempt.ordinal))latest.set(attempt.ordinal,attempt);
 return attempts.find(attempt=>{
  const step=props.steps.find(item=>item.ordinal===(attempt.ordinal===2?1:attempt.ordinal));
  if(latest.get(attempt.ordinal)?.id!==attempt.id||!step?.finished_at||['waiting','running','skipped'].includes(step.status))return false;
  return [2,4,5,6,9].includes(attempt.ordinal)&&attempt.status==='failed'
   ||attempt.ordinal===2&&Array.isArray((attempt.result as any)?.issues)&&(attempt.result as any).issues.length>0
   ||attempt.ordinal===7&&(attempt.result as {decision?:string}|null)?.decision==='repair';
 });
});
function authoringRevisionEvidence(round:Round){
 const attempt=props.attempts.find(item=>item.ordinal===4&&item.revision_round_id===round.id);
 return (attempt?.input as {revision?:{evidence?:unknown}}|null)?.revision?.evidence;
}
function evaluationRecords(evidence:unknown):Record<string,any>[]{
 const records=(evidence as {evaluation_records?:unknown}|null)?.evaluation_records;
 return Array.isArray(records)?records.filter((record):record is Record<string,any>=>!!record&&typeof record==='object'):[];
}
function failureMaterials(evidence:unknown):Record<string,any>[]{
 const materials=(evidence as {materials?:unknown}|null)?.materials;
 return Array.isArray(materials)?materials.filter((material):material is Record<string,any>=>!!material&&typeof material==='object'):[];
}
const labels:Record<string,string>={waiting:'待执行',running:'执行中',blocked:'等待处理',accepted:'已合格',isolated:'已隔离',stale:'已失效',succeeded:'完成',failed:'失败'};
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
  <p class="text-xs text-muted">未达标返修会固定最近最多三轮评测，并包含每轮全部作答模型；旧记录若没有答案／评分关联，只显示已有摘要，不推测缺失内容。</p>
  <Column v-for="chain in data?.chains" :key="chain.id" class="border-t border-line-subtle pt-12" :gap="8">
   <Row wrap :gap="8"><v-chip>{{labels[chain.status]??chain.status}}</v-chip><span class="text-xs text-muted">{{dateLabel(chain.created_at)}}</span><v-btn v-if="chain.status==='blocked'" :loading="busy" :disabled="disabled||busy" @click="execute(chain)">处理后恢复</v-btn></Row>
   <p class="text-sm">内容返修 {{chain.content_revisions}} 次 · 技术重试 {{chain.technical_retries}} 次 · 调用预留 {{chain.calls_reserved}} 次 · 有效耗时 {{(Number(chain.spent_duration_ms)/1000).toFixed(1)}} 秒</p>
   <p v-if="chain.reason" class="text-sm text-muted break-all">{{chain.reason}}</p>
   <details v-for="round in data?.rounds.filter(item=>item.chain_id===chain.id)" :key="round.id" class="text-sm"><summary class="cursor-pointer link-text">第 {{round.round}} 轮 · {{round.issue_kind}} · {{labels[round.status]??round.status}}</summary>
    <Column class="mt-8" :gap="8">
     <section v-if="evaluationRecords(round.evidence).length" class="surface-panel p-12">
      <p class="font-medium">出题参考的失败评测材料（{{evaluationRecords(round.evidence).length}} 轮）</p>
      <Column v-for="record in evaluationRecords(round.evidence)" :key="record.acceptance_attempt_id??record.attempt" class="mt-8 border-t border-line-subtle pt-8" :gap="6">
       <p>评测轮次：第 {{record.attempt??'未知'}} 次 · {{record.acceptance_attempt_id??'缺少记录 ID'}}</p>
       <p v-if="record.reasons?.length" class="text-muted">未达标原因：{{record.reasons.join('；')}}</p>
       <p v-if="!record.models?.length" class="text-muted">没有可关联的模型答案／评分记录。</p>
       <Column v-for="(model,index) in record.models??[]" :key="model.model_id??index" class="surface-card p-8" :gap="4">
        <p>模型：{{model.model_id??'未知'}} · 得分：{{JSON.stringify(record.model_scores?.[model.model_id]??null)}} · 答案记录：{{model.answer_attempt_id??'不可用'}} · 评分记录：{{model.score_attempt_id??'不可用'}}</p>
        <p class="text-muted">{{model.details_available===false?'答案或评分原文缺失或未通过版本校验；未提供原文。':'完整答案与评分原文在出题任务入队后显示于下方；旧记录或版本校验失败会标明缺失。'}}</p>
       </Column>
      </Column>
     </section>
     <section v-if="failureMaterials(round.evidence).length" class="surface-panel p-12">
      <p class="font-medium">失败附件及页码</p>
      <p v-for="(material,index) in failureMaterials(round.evidence)" :key="material.material_id??index">附件 ID：{{material.material_id??'未知'}} · 页码：{{material.pages?.join('、')??'未记录'}} · 问题类型：{{material.kinds?.join('、')??'未记录'}}</p>
     </section>
     <pre class="surface-panel whitespace-pre-wrap break-all text-xs">{{JSON.stringify({原因:round.decision.reason,依据:round.evidence,修订前版本:round.before_versions,修订后版本:round.after_versions,修订前评分:round.before_scores,修订后评分:round.after_scores},null,2)}}</pre>
     <details v-if="authoringRevisionEvidence(round)" class="surface-panel p-12">
      <summary class="cursor-pointer link-text">出题 Agent 实际收到的完整失败材料（答案与评分原文）</summary>
      <pre class="mt-8 max-h-640px overflow-y-auto whitespace-pre-wrap break-all text-xs">{{JSON.stringify(authoringRevisionEvidence(round),null,2)}}</pre>
     </details>
    </Column>
   </details>
  </Column>
 </Column></section>
</template>
