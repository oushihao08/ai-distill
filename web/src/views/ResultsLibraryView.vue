<!--
职责：汇总展示跨项目当前有效的已达标题目。
关键逻辑：读取 `/results` 安全摘要，支持项目／题目／材料包搜索、发布状态筛选和分页；题目与来源材料包可分别跳转详情。
使用场景：工作台主导航“成果库”入口，不展示原始材料正文。
-->
<script setup lang="ts">
import { useResource } from '../composables/useResource';
import { dateLabel } from '../utils/format';
import type { ResultLibraryItem } from '../types/api';

const {data,error,loading,refresh}=useResource<ResultLibraryItem[]>('/results');
const search=shallowRef('');
const publication=shallowRef<'全部'|'待归档'|'已归档'>('全部');
const page=shallowRef(1);
const pageSize=20;
const filtered=computed(()=>{
 const query=search.value.trim().toLowerCase();
 return(data.value??[]).filter(item=>{
  const matchesText=!query||`${item.project_name} ${item.title} ${item.source_key??''} ${item.source_material_package_title??''}`.toLowerCase().includes(query);
  const matchesPublication=publication.value==='全部'||(publication.value==='已归档'?item.publication_status==='succeeded':item.publication_status!=='succeeded');
  return matchesText&&matchesPublication;
 });
});
const pageCount=computed(()=>Math.max(1,Math.ceil(filtered.value.length/pageSize)));
const visible=computed(()=>filtered.value.slice((page.value-1)*pageSize,page.value*pageSize));
function scoreLabel(result:NonNullable<NonNullable<ResultLibraryItem['acceptance_result']>['model_scores']>[string]){
 const score=result.score_contract==='model_report_v1'?result.raw_score:result.score;
 const maximum=result.score_contract==='model_report_v1'?result.full_score:result.max_score;
 const metric=typeof result.percentage==='number'?`${Number(result.percentage.toFixed(1))}%`:'—';
 return `${result.score_contract==='model_report_v1'?'原始分 ':''}${score??'—'}/${maximum??'—'} · ${result.score_contract==='model_report_v1'?'模型指标 ':''}${metric}${result.veto_triggered===true?' · 否决':''} / <${result.threshold}%`;
}
watch([search,publication],()=>{page.value=1;});
watch(pageCount,()=>{page.value=Math.min(page.value,pageCount.value);});
</script>

<template>
 <Column :gap="16">
  <Row x="between" wrap y="center" :gap="12">
   <Column :gap="6"><h1 class="text-2xl font-bold text-ink-heading">成果库</h1><p class="text-sm text-muted">跨项目查看当前已达标题目及归档状态。</p></Column>
   <Row wrap :gap="8">
    <v-text-field v-model="search" placeholder="搜索项目、题目或材料包" aria-label="搜索成果" hide-details clearable class="filter-field-compact" />
    <v-select v-model="publication" :items="['全部','待归档','已归档']" label="归档状态" hide-details class="filter-field-compact w-140px" />
    <v-btn :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新</v-btn>
   </Row>
  </Row>
  <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
  <p v-if="loading&&!data" class="text-sm text-muted">正在读取成果…</p>
  <section v-else-if="data" class="surface-card">
   <v-empty-state v-if="!visible.length" :title="filtered.length?'没有符合筛选条件的成果':'暂无已达标题目'" :text="filtered.length?'调整搜索内容或归档状态后再试。':'题目通过达标判断后会汇总到这里。'" />
   <Column v-else class="w-full overflow-x-auto">
    <v-table density="comfortable" class="min-w-920px">
     <thead><tr><th scope="col">项目 / 题目</th><th scope="col">所属材料包</th><th scope="col">评分与门槛</th><th scope="col">版本</th><th scope="col">归档状态</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead>
     <tbody>
      <tr v-for="item in visible" :key="item.workflow_id">
       <td><RouterLink :to="`/projects/${item.project_id}`" class="link-text text-xs">{{ item.project_name }}</RouterLink><div class="font-medium text-ink-heading">{{ item.title }}</div><div class="text-xs text-muted">{{ item.source_key||'未分组' }}</div></td>
       <td><RouterLink v-if="item.source_workflow_id" :to="`/workflows/${item.source_workflow_id}`" class="link-text">{{ item.source_material_package_title??'查看材料包' }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
       <td><Row wrap :gap="4"><v-chip v-for="[model,result] in Object.entries(item.acceptance_result?.model_scores??{})" :key="model" size="small" :color="result.status==='passed'?'success':'error'">{{ item.answer_models?.find(answer=>answer.model_id===model)?.name??model }} {{ scoreLabel(result) }}</v-chip><span v-if="!Object.keys(item.acceptance_result?.model_scores??{}).length" class="text-xs text-error">缺少评分明细</span></Row></td>
       <td class="text-xs text-muted">题目 {{ item.current_question_version??'—' }}<br>评分表 {{ item.current_rubric_version??'—' }}</td>
       <td><v-chip size="small" :color="item.publication_status==='succeeded'?'success':'secondary'">{{ item.publication_status==='succeeded'?'已归档':'待归档' }}</v-chip><div class="text-xs text-muted">{{ item.exported?'已导出':'未导出' }}</div></td>
       <td class="text-xs text-muted">{{ dateLabel(item.created_at) }}</td>
       <td><v-btn :to="`/workflows/${item.workflow_id}`" color="primary" variant="text">查看题目</v-btn></td>
      </tr>
     </tbody>
    </v-table>
   </Column>
  </section>
  <Row x="between" wrap y="center" :gap="8"><span class="text-xs text-muted">共 {{ filtered.length }} 道 · 第 {{ page }} / {{ pageCount }} 页</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="成果分页" /></Row>
 </Column>
</template>
