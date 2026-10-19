<!-- 职责：给历史题目显示关联到新材料库的来源；props.workflowId为原题ID，不改变旧题执行读源或冻结附件。 -->
<script setup lang="ts">
import {useResource} from '../composables/useResource';
const props=defineProps<{workflowId:string}>();
const {data,error}=useResource<{items:{id:string;package_id:string;package_name:string;revision_id:string}[]}>(`/workflows/${props.workflowId}/library-history`);
</script>
<template><section v-if="data?.items.length||error" class="surface-card p-12"><Column :gap="8"><h2 class="section-title">历史材料与新库关联</h2><p v-if="error" class="text-sm text-danger">{{ error }}</p><p v-for="item in data?.items??[]" :key="item.id" class="text-sm">{{ item.package_name }} · 新库包 {{ item.package_id }} · 来源版本 {{ item.revision_id }}</p><p class="text-xs text-muted">此处为历史来源登记，本题继续使用原有冻结附件与结果。</p></Column></section></template>
