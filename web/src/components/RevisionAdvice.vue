<script setup lang="ts">
import {api} from '../api/client';
import type {RevisionAdviceView} from '../../../shared/revision-advice';
import {dateLabel} from '../utils/format';
const props=defineProps<{workflowId:string;disabled?:boolean;disabledReason?:string;variant?:'text'|'outlined'}>();
const open=shallowRef(false),loading=shallowRef(false),submitting=shallowRef(false),error=shallowRef(''),message=shallowRef('');
const data=shallowRef<RevisionAdviceView|null>(null);
const active=computed(()=>data.value?.attempts.some(attempt=>['waiting','running'].includes(attempt.status))??false);
async function refresh(){
 if(loading.value)return;loading.value=true;error.value='';
 try{data.value=await api<RevisionAdviceView>(`/workflows/${props.workflowId}/revision-advice`);}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取返修建议失败';}
 finally{loading.value=false;}
}
async function show(){open.value=true;await refresh();}
async function generate(){
 if(submitting.value)return;submitting.value=true;error.value='';message.value='';
 try{const result=await api<{id:string;reused:boolean}>(`/workflows/${props.workflowId}/revision-advice`,{method:'POST'});message.value=result.reused?'已有建议任务，已复用':'建议任务已排队；完成后刷新查看';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'派发返修建议失败';}
 finally{submitting.value=false;}
}
</script>
<template>
 <v-btn size="small" :variant="variant??'text'" color="primary" @click="show">触发返修建议</v-btn>
 <v-dialog v-model="open" max-width="1000"><v-card title="题目返修建议"><v-card-text><Column :gap="12">
  <p class="text-sm text-muted">手动分析当前题目、作答和评分；生成建议后可查看。下一次出题会读取同版有效建议，仍需手动派发出题。</p>
  <v-alert v-if="error" type="error">{{ error }}</v-alert><v-alert v-if="message" type="info">{{ message }}</v-alert>
  <v-alert v-if="data&&!data.available" type="warning">返修建议结构尚未启用，需要服务端完成050迁移。</v-alert>
  <p v-if="disabled" class="text-sm text-muted">{{ disabledReason||'题目已达标，或出题、作答、评分仍有活动任务；当前不能生成新建议。' }}</p>
  <p v-else-if="active" class="text-sm text-muted">已有返修建议任务排队或执行中，完成后刷新查看。</p>
  <Row wrap :gap="8"><v-btn color="primary" :loading="submitting" :disabled="disabled||active||loading||submitting||!data?.available" @click="generate">生成返修建议</v-btn><v-btn variant="text" :loading="loading" :disabled="loading||submitting" @click="refresh">刷新建议</v-btn></Row>
  <p v-if="data?.available&&!data.attempts.length" class="text-sm text-muted">暂无返修建议。</p>
  <section v-for="attempt in data?.attempts??[]" :key="attempt.id" class="surface-panel p-16"><Column :gap="8"><Row wrap :gap="8"><v-chip size="small">{{ ({waiting:'已排队',running:'生成中',succeeded:'已生成',failed:'失败',skipped:'已取消'} as Record<string,string>)[attempt.status] }}</v-chip><v-chip v-if="attempt.status==='succeeded'" size="small" :color="attempt.current?'success':'secondary'">{{ attempt.current?'当前版本有效':'历史建议' }}</v-chip><span class="text-xs text-muted">{{ dateLabel(attempt.started_at) }}</span></Row><p v-if="attempt.error" class="text-sm text-danger">{{ attempt.error }}</p><p v-if="attempt.result?.text" class="text-sm whitespace-pre-wrap break-words">{{ attempt.result.text }}</p></Column></section>
 </Column></v-card-text><v-card-actions><v-spacer/><v-btn @click="open=false">关闭</v-btn></v-card-actions></v-card></v-dialog>
</template>
