<!--
职责：在项目详情页列出当前版本已达标题目及其材料包，汇总各模型分数并打开全文弹窗。
关键方法与用法：接收题目、材料包、导出状态与错误，发出 `export` 事件；负责搜索、异常筛选、分页和单题归档入口。
-->

<script setup lang="ts">
import type { Workflow } from '../types/api';
import AcceptedQuestionDetail from './AcceptedQuestionDetail.vue';

type ModelResult=import('@shared/workflow-results').ModelAcceptance;
const props=defineProps<{workflows:Workflow[];packages:Workflow[];exporting?:boolean;exportError?:string}>();
const emit=defineEmits<{export:[]}>();
const search=shallowRef('');
const filter=shallowRef<'全部'|'异常'|'待归档'|'已归档'>('全部');
const page=shallowRef(1);
const selected=shallowRef<Workflow|null>(null);
const pageSize=20;
const accepted=computed(()=>props.workflows.filter(flow=>flow.current_ordinal===7&&flow.current_decision==='accepted'));
const packageNames=computed(()=>Object.fromEntries(props.packages.map(item=>[item.id,item.title])));
function scores(flow:Workflow){return Object.entries(flow.acceptance_result?.model_scores??{}) as [string,ModelResult][];}
function modelName(flow:Workflow,id:string){return flow.answer_models?.find(model=>model.model_id===id)?.name??id.slice(0,8);}
function hasAnomaly(flow:Workflow){const values=scores(flow);return !values.length||values.some(([,score])=>score.status!=='passed')||Boolean(flow.answer_models?.length&&flow.answer_models.length!==values.length);}
const anomalousCount=computed(()=>accepted.value.filter(hasAnomaly).length);
const publishedCount=computed(()=>accepted.value.filter(flow=>flow.publication_status==='succeeded').length);
const exportedCount=computed(()=>accepted.value.filter(flow=>flow.exported).length);
const filtered=computed(()=>accepted.value.filter(flow=>{
 const matchesText=flow.title.toLowerCase().includes(search.value.trim().toLowerCase())||(flow.source_key??'').toLowerCase().includes(search.value.trim().toLowerCase())||(flow.source_workflow_id?packageNames.value[flow.source_workflow_id]?.toLowerCase().includes(search.value.trim().toLowerCase()):false);
 const matchesFilter=filter.value==='全部'||(filter.value==='异常'&&hasAnomaly(flow))||(filter.value==='待归档'&&flow.publication_status!=='succeeded')||(filter.value==='已归档'&&flow.publication_status==='succeeded');
 return matchesText&&matchesFilter;
}));
const pageCount=computed(()=>Math.max(1,Math.ceil(filtered.value.length/pageSize)));
const visible=computed(()=>filtered.value.slice((page.value-1)*pageSize,page.value*pageSize));
function formatPercent(value:number|null|undefined){return typeof value==='number'?`${Number(value.toFixed(1))}%`:'—';}
function scoreSummary(flow:Workflow){const values=scores(flow);return values.length?values.length+' 个模型 · '+values.filter(([,score])=>score.status==='passed').length+' 个通过':'缺少评分';}
function scoreHint(flow:Workflow){return scores(flow).map(([id,result])=>modelName(flow,id)+' '+(result.raw_score??result.score??'—')+'/'+(result.full_score??result.max_score??'—')+' · '+formatPercent(result.percentage)+' / 门槛 '+(result.threshold??'—')+'%').join('；');}
watch([search,filter],()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
</script>

<template>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap y="center" :gap="12">
   <Column :gap="4"><h2 class="section-title">达标题目</h2><span class="text-xs text-muted">当前版本 {{ accepted.length }} 道达标 · {{ publishedCount }} 道已归档 · {{ exportedCount }} 道已导出<span v-if="anomalousCount"> · {{ anomalousCount }} 道评分状态异常</span></span></Column>
   <Row wrap y="center" :gap="8">
    <v-btn :loading="props.exporting" :disabled="accepted.length===0||props.exporting" @click="emit('export')">下载全部达标题目 Excel</v-btn>
    <v-text-field v-model="search" placeholder="搜索题目" aria-label="搜索达标题目" hide-details clearable class="filter-field-compact" />
    <v-select v-model="filter" :items="['全部','异常','待归档','已归档']" label="筛选" hide-details class="filter-field-compact w-140px" />
   </Row>
  </Row>
  <v-alert v-if="props.exportError" type="error" density="compact" role="alert">{{ props.exportError }}</v-alert>
  <p class="text-xs text-muted">Excel 每题一行，包含题目字段、输入附件地址、rubric、作答思路和标准答案，生成后由浏览器下载。</p>
  <p v-if="!visible.length" class="text-sm text-muted">{{ accepted.length?'没有符合筛选条件的达标题目':'暂无当前版本已达标题目。' }}</p>
  <Column v-else class="w-full overflow-x-auto">
   <v-table density="compact" class="project-records-table min-w-900px">
    <thead><tr><th scope="col">题目</th><th scope="col">所属材料包</th><th scope="col">模型评分</th><th scope="col">判定</th><th scope="col">版本</th><th scope="col">成果状态</th><th scope="col">操作</th></tr></thead>
    <tbody>
     <tr v-for="flow in visible" :key="flow.id">
      <td class="max-w-260px"><RouterLink :to="`/workflows/${flow.id}`" class="link-text font-medium line-clamp-2" :title="flow.title">{{ flow.title }}</RouterLink></td>
      <td class="max-w-220px"><RouterLink v-if="flow.source_workflow_id" :to="`/workflows/${flow.source_workflow_id}`" class="link-text line-clamp-2" :title="packageNames[flow.source_workflow_id]??'查看材料包'">{{ packageNames[flow.source_workflow_id]??'查看材料包' }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
      <td class="whitespace-nowrap"><button type="button" class="link-text cursor-pointer bg-transparent border-none p-0 text-sm" :title="scoreHint(flow)" @click="selected=flow">{{ scoreSummary(flow) }}</button></td>
      <td><v-chip :color="hasAnomaly(flow)?'error':'success'">{{ hasAnomaly(flow)?'需核对评分':'达标' }}</v-chip></td>
      <td class="whitespace-nowrap text-muted" :title="'题目 '+(flow.current_question_version||'—')+' · 评分表 '+(flow.current_rubric_version||'—')">题 {{ flow.current_question_version||'—' }} · 表 {{ flow.current_rubric_version||'—' }}</td>
      <td class="whitespace-nowrap">{{ flow.publication_status==='succeeded'?'已归档':'待归档' }} · {{ flow.exported?'已导出':'未导出' }}</td>
      <td class="whitespace-nowrap"><Row :gap="4"><v-btn size="small" color="primary" variant="text" @click="selected=flow">查看内容</v-btn><v-btn v-if="flow.publication_status!=='succeeded'" size="small" color="primary" variant="text" :to="`/workflows/${flow.id}`">归档</v-btn></Row></td>
     </tr>
    </tbody>
   </v-table>
  </Column>
  <Row x="between" wrap y="center" :gap="8"><span class="text-xs text-muted">第 {{ page }} / {{ pageCount }} 页 · 每页 {{ pageSize }} 道</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="达标题目分页" /></Row>
 </Column>
 <AcceptedQuestionDetail v-if="selected" :workflow-id="selected.id" :title="selected.title" :acceptance-result="selected.acceptance_result" @close="selected=null" />
</template>
