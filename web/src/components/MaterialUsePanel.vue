<!-- 职责：显示本期材料提交状态，并按需查看事件历史或登记提交/返修。项目材料表提供本期使用摘要。 -->
<script setup lang="ts">
import {api} from '../api/client';
import type {MaterialUseEvent,MaterialUseRecord} from '@shared/material-library';
import {dateLabel} from '../utils/format';
const props=defineProps<{projectId:string;item:MaterialUseRecord}>();
const emit=defineEmits<{updated:[]} >();
const error=shallowRef(''),selected=shallowRef<MaterialUseRecord|null>(null),busy=shallowRef(false),reason=shallowRef('');
const historyOpen=shallowRef(false),historyLoading=shallowRef(false),events=shallowRef<MaterialUseEvent[]>([]);
const evidence=reactive({platform:'Siriser',project_id:'',task_id:'',submitted_at:'',receipt:''});
function edit(item:MaterialUseRecord){selected.value=item;reason.value='';error.value='';Object.assign(evidence,{platform:'Siriser',project_id:'',task_id:'',submitted_at:'',receipt:''});}
async function showHistory(){
 const useId=props.item.id;historyOpen.value=true;historyLoading.value=true;events.value=[];error.value='';
 try{const result=await api<{items:MaterialUseEvent[]}>(`/projects/${props.projectId}/material-uses/${useId}/events`);if(props.item.id===useId)events.value=result.items;}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取材料使用历史失败';}
 finally{historyLoading.value=false;}
}
async function save(){
 if(!selected.value||busy.value)return;
 busy.value=true;error.value='';
 try{
  const item=selected.value;
  await api(`/projects/${props.projectId}/material-uses/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':String(item.lock_version)},body:JSON.stringify({status:item.status==='submitted'?'in_use':'submitted',reason:reason.value,evidence:item.status==='submitted'?{}:evidence})});
  selected.value=null;emit('updated');
 }catch(cause){error.value=cause instanceof Error?cause.message:'状态保存失败';}finally{busy.value=false;}
}
</script>
<template><Row wrap y="center" :gap="4">
 <v-chip size="small" :color="item.status==='submitted'?'success':'primary'">{{ item.status==='submitted'?'已提交':'使用中' }}</v-chip>
 <v-btn size="small" variant="text" :disabled="busy" @click="edit(item)">{{ item.status==='submitted'?'退回返修':'登记提交' }}</v-btn>
 <v-btn size="small" variant="text" @click="showHistory">历史</v-btn>
 <v-dialog v-model="historyOpen" max-width="720" scrollable><Column class="surface-card p-20" :gap="12"><Row x="between" y="center"><h3 class="section-title">材料使用与提交历史</h3><v-btn icon="$close" variant="text" aria-label="关闭历史" @click="historyOpen=false"/></Row><p v-if="historyLoading" class="text-sm text-muted" role="status">正在读取历史…</p><p v-else-if="!events.length" class="text-sm text-muted">暂无历史记录。</p><v-table v-else density="compact"><thead><tr><th scope="col">时间</th><th scope="col">状态</th><th scope="col">原因</th></tr></thead><tbody><tr v-for="event in events" :key="event.id"><td class="whitespace-nowrap">{{ dateLabel(event.created_at) }}</td><td>{{ event.status==='submitted'?'已提交':'使用中' }}</td><td>{{ event.reason||'—' }}</td></tr></tbody></v-table><v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert></Column></v-dialog>
 <v-dialog :model-value="!!selected" max-width="600" @update:model-value="!busy&&(selected=null)"><v-form v-if="selected" class="surface-card p-20" @submit.prevent="save"><Column :gap="12"><h3 class="section-title">{{ selected.status==='submitted'?'退回原期次返修':'登记外部提交' }}</h3><v-textarea v-model="reason" label="原因（必填）" :disabled="busy" rows="2"/><template v-if="selected.status!=='submitted'"><v-text-field v-model="evidence.platform" label="提交平台"/><v-text-field v-model="evidence.project_id" label="平台项目 ID"/><v-text-field v-model="evidence.task_id" label="平台任务 ID"/><v-text-field v-model="evidence.submitted_at" label="实际提交时间（含时区）"/><v-text-field v-model="evidence.receipt" label="回执链接或记录路径"/></template><v-alert v-if="error" type="error">{{ error }}</v-alert><Row x="end" :gap="8"><v-btn :disabled="busy" @click="selected=null">取消</v-btn><v-btn type="submit" color="primary" :loading="busy" :disabled="!reason.trim()">保存状态</v-btn></Row></Column></v-form></v-dialog>
</Row></template>
