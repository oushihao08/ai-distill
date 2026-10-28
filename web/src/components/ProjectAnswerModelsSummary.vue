<script setup lang="ts">
import {useResource} from '../composables/useResource';
const props=defineProps<{projectId:string;refreshToken?:number}>();
const {data,error,loading,refresh}=useResource<{model_id:string;name:string;config:{provider:string;model:string;reasoning_effort?:string}}[]>(`/projects/${props.projectId}/answer-models`);
watch(()=>props.refreshToken,()=>{void refresh();});
</script>
<template>
 <Column :gap="6" aria-label="当前作答模型集合">
  <span v-if="loading&&!data" class="text-xs text-muted">正在读取本期作答模型…</span>
  <Row v-else-if="data?.length" wrap :gap="6"><span class="text-xs text-muted">新作答使用：</span><v-chip v-for="model in data" :key="model.model_id" size="small" :title="model.name">{{ model.config.model }} · {{ model.config.provider }}{{ model.config.reasoning_effort?` · ${model.config.reasoning_effort}`:'' }}</v-chip></Row>
  <span v-else-if="!error" class="text-xs text-warning-text">尚未选择本期作答模型，请先配置。</span>
  <Row v-if="error" wrap :gap="6"><span class="text-xs text-danger">作答模型读取失败：{{ error }}</span><v-btn variant="text" size="small" :loading="loading" @click="refresh">重试</v-btn></Row>
  <span class="text-xs text-muted">以本期已保存模型集合派发；历史作答仍使用各次冻结模型，不使用旧步骤单模型设置。</span>
 </Column>
</template>
