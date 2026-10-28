<!-- 职责：按需查看材料库任务状态、进度和安全错误，并调用现有取消/显式重试接口。
props：revisionId和jobs为不可变文件集合的历史摘要，disabled限制写操作；refresh通知材料库刷新。
重试保留同一请求标识处理未知回执，脱敏重试沿用原成功提取任务，不读取任务提示词或原文。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {dateLabel} from '../utils/format';
import type {MaterialLibraryJob,LibraryJobKind} from '@shared/material-library';
const props=defineProps<{revisionId:string;jobs:{id:string;kind:LibraryJobKind;status:string;execution?:MaterialLibraryJob['execution'];created_at:string;origin?:'execution'|'legacy_import'}[];disabled?:boolean}>();
const emit=defineEmits<{refresh:[]}>();
const visible=shallowRef(false),busy=shallowRef(false),error=shallowRef('');
const job=shallowRef<MaterialLibraryJob>();
const retryKey=shallowRef('');
const names={intake:'入库核验',extract:'文本提取',redact:'脱敏',prepare:'材料整理'};
const statuses:Record<string,string>={queued:'排队中',running:'执行中',succeeded:'成功',failed:'失败',cancelled:'已取消'};
async function openJob(id:string){
 if(busy.value)return;visible.value=true;busy.value=true;error.value='';job.value=undefined;retryKey.value=crypto.randomUUID();
 try{job.value=await api<MaterialLibraryJob>(`/material-library/jobs/${id}`);}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取任务记录失败';}
 finally{busy.value=false;}
}
async function refreshJob(){
 if(!job.value||busy.value)return;busy.value=true;error.value='';
 try{job.value=await api<MaterialLibraryJob>(`/material-library/jobs/${job.value.id}`);emit('refresh');}
 catch(cause){error.value=cause instanceof Error?cause.message:'刷新任务失败';}
 finally{busy.value=false;}
}
async function cancel(){
 if(!job.value||busy.value||props.disabled)return;busy.value=true;error.value='';
 try{job.value=await api<MaterialLibraryJob>(`/material-library/jobs/${job.value.id}/cancel`,{method:'POST'});emit('refresh');}
 catch(cause){error.value=cause instanceof Error?cause.message:'取消任务失败';}
 finally{busy.value=false;}
}
async function retry(){
 if(!job.value||busy.value||props.disabled)return;busy.value=true;error.value='';
 try{
  const previous=job.value;
  if(previous.kind==='redact'&&!previous.extraction_job_id)throw new Error('原脱敏任务缺少提取来源，不能重试，请在材料库重新选择成功提取结果。');
  const next=await api<{id:string}>(`/material-library/revisions/${props.revisionId}/jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:previous.kind,execution_target:previous.execution_target,request_key:retryKey.value,previous_job_id:previous.id,...(previous.kind==='redact'?{extraction_job_id:previous.extraction_job_id}:{})})});
  job.value=await api<MaterialLibraryJob>(`/material-library/jobs/${next.id}`);retryKey.value=crypto.randomUUID();emit('refresh');
 }catch(cause){error.value=cause instanceof Error?cause.message:'重试派发失败';}
 finally{busy.value=false;}
}
</script>
<template>
 <Column :gap="6"><Row v-for="entry in jobs" :key="entry.id" x="between" wrap y="center" :gap="8"><span class="text-xs text-muted">{{ names[entry.kind] }} · {{ entry.origin==='legacy_import'?'历史结果导入 · ':'' }}{{ entry.execution?.label??statuses[entry.status]??entry.status }} · {{ dateLabel(entry.created_at) }}</span><v-btn size="small" variant="text" :disabled="busy" @click="openJob(entry.id)">查看任务</v-btn></Row></Column>
 <v-dialog :model-value="visible" :persistent="busy" max-width="680" @update:model-value="value=>{if(!busy)visible=value}"><Column class="surface-card p-20" :gap="12">
  <h2 class="section-title">材料处理任务</h2>
  <p v-if="busy&&!job" class="text-sm text-muted">正在读取任务…</p>
  <template v-if="job"><strong>{{ names[job.kind] }} · {{ job.execution?.label??(job.cancel_requested_at&&job.status==='running'?'正在取消':statuses[job.status]??job.status) }}</strong><p class="text-xs text-muted break-all">任务 {{ job.id }}<template v-if="job.previous_job_id"> · 重试来源 {{ job.previous_job_id }}</template></p><p class="text-xs text-muted">创建 {{ dateLabel(job.created_at) }} · 开始 {{ job.started_at?dateLabel(job.started_at):'尚未开始' }} · 结束 {{ job.finished_at?dateLabel(job.finished_at):'尚未结束' }}</p>
   <p v-if="job.origin==='legacy_import'" class="text-sm text-muted">来源为旧流程已完成结果的导入；此时间为导入时间，不代表本次重新执行了识别或模型。</p>
   <p v-if="job.progress.completed_files!==undefined" class="text-sm">已处理 {{ job.progress.completed_files }} / {{ job.progress.total_files }} 份材料</p>
   <v-alert v-if="job.error_message||job.error_code" type="error" density="compact">{{ job.error_message }}<p v-if="job.error_code" class="text-xs">原因码：{{ job.error_code }}</p></v-alert>
   <p v-if="job.cancel_requested_at&&job.status==='running'" class="text-sm text-muted">取消请求已记录，等待执行器结束；点击刷新查看最终状态。</p>
  </template>
  <v-alert v-if="error" type="error" density="compact" role="alert">{{ error }}</v-alert>
  <Row x="end" wrap :gap="8"><v-btn :disabled="busy" @click="visible=false">关闭</v-btn><v-btn v-if="job" :disabled="busy" @click="refreshJob">刷新状态</v-btn><v-btn v-if="job&&['queued','running'].includes(job.status)" color="error" :disabled="busy||disabled||!!job.cancel_requested_at" @click="cancel">取消任务</v-btn><v-btn v-if="job&&job.kind!=='prepare'&&['failed','cancelled'].includes(job.status)" color="primary" :disabled="busy||disabled" @click="retry">重新执行</v-btn></Row>
 </Column></v-dialog>
</template>
