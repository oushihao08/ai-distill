<!-- 职责：只读展示本期必要配置及补齐入口；不派发任务，不整体拦截工作流。 -->
<script setup lang="ts">
import {api} from '../api/client';
import type {ProjectStage} from '@shared/types';
const props=defineProps<{projectId:string;authoring?:ProjectStage;mode:'original'|'aliases'|'mask';materialCount:number|null;usableCount:number|null}>();
const emit=defineEmits<{rules:[];authoring:[];materials:[]}>();
const skillStatus=shallowRef('尚未核对');
const loading=shallowRef(false);
const authoringStatus=computed(()=>props.authoring?.config.model&&props.authoring.config.prompt?.trim()?'已配置':'请补齐出题模型与提示词');
let generation=0;
async function refresh(){
 const current=++generation;loading.value=true;
 try{
  const rules=await api<{workspace:{issues:string[]};skill:{path:string}}>(`/projects/${props.projectId}/rules`);
  if(current!==generation)return;
  skillStatus.value=rules.workspace.issues.length?rules.workspace.issues.join('；'):`已核对：${rules.skill.path}`;
 }catch(cause){if(current===generation)skillStatus.value=cause instanceof Error?cause.message:'核对失败';}
 finally{if(current===generation)loading.value=false;}
}
watch(()=>props.projectId,refresh,{immediate:true});
onBeforeUnmount(()=>{generation++;});
</script>
<template><section class="surface-card p-16" aria-label="本期准备情况"><Column :gap="12">
 <Row x="between" y="center"><h2 class="section-title">本期准备情况</h2><v-btn size="small" :loading="loading" :disabled="loading" @click="refresh">核对配置</v-btn></Row>
 <Row x="between" wrap :gap="8"><span class="text-sm">规则与Skill：{{ skillStatus }}</span><v-btn size="small" @click="emit('rules')">补齐规则</v-btn></Row>
 <Row x="between" wrap :gap="8"><span class="text-sm">出题设置：{{ authoringStatus }}</span><v-btn size="small" @click="emit('authoring')">出题设置</v-btn></Row>
 <Row x="between" wrap :gap="8"><span class="text-sm">材料：{{ materialCount===null?'正在读取':`已加载 ${materialCount} 包` }}，{{ usableCount===null?'可用状态待核对':`匹配本期且可用 ${usableCount} 包` }}；{{ mode==='original'?'使用完整提取原文，无需脱敏':mode==='aliases'?'需要匹配的Agent化名版本':'旧遮挡模式已退役，请明确修改本期设置' }}</span><v-btn size="small" @click="emit('materials')">查看本期材料</v-btn></Row>
 <p class="text-xs text-muted">出题完成后可直接进入交付归档；具体材料版本、可用状态和建题要求在上方本期材料中核对。</p>
</Column></section></template>
