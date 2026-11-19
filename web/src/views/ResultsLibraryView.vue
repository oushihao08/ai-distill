<!--
职责：汇总展示跨项目当前有效的已达标题目。
关键逻辑：读取 `/results` 安全摘要，支持项目／题目／材料包搜索、发布状态筛选和分页；题目与来源材料包可分别跳转详情。
使用场景：工作台主导航“成果库”入口，不展示原始材料正文。
-->
<script setup lang="ts">
import { api } from '../api/client';
import { dateLabel } from '../utils/format';
import type { ResultLibraryItem } from '../types/api';

const data=shallowRef<ResultLibraryItem[]>();
const error=shallowRef('');
const loading=shallowRef(false);
const search=shallowRef('');
const publication=shallowRef<'全部'|'待归档'|'已归档'>('全部');
const page=shallowRef(1);
const pageSize=20;
const hasMore=shallowRef(false);
const filtered=computed(()=>data.value??[]);
const visible=filtered;
const pageCount=computed(()=>page.value+(hasMore.value?1:0));
let generation=0;
async function refresh(){
 const current=++generation;
 loading.value=true;error.value='';
 try{
  const params=new URLSearchParams({page:String(page.value),page_size:String(pageSize),q:search.value.trim(),publication:publication.value==='已归档'?'archived':publication.value==='待归档'?'pending':'all'});
  const result=await api<{items:ResultLibraryItem[],has_more:boolean}>(`/results?${params}`);
  if(current===generation){data.value=result.items;hasMore.value=result.has_more;}
 }catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'读取成果失败';}
 finally{if(current===generation)loading.value=false;}
}
let searchTimer:ReturnType<typeof setTimeout>|undefined;
watch([search,publication],()=>{page.value=1;if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>void refresh(),250);});
watch(page,()=>void refresh());
onMounted(()=>void refresh());
onUnmounted(()=>{generation++;if(searchTimer)clearTimeout(searchTimer);});
</script>

<template>
 <Column :gap="16">
  <Row x="between" wrap y="center" :gap="12">
   <Column :gap="6"><h1 class="text-2xl font-bold text-ink-heading">成果库</h1><p class="text-sm text-muted">跨项目查看已完成出题的可交付题目及归档状态。</p></Column>
   <Row wrap :gap="8">
    <v-text-field v-model="search" placeholder="搜索项目、题目或材料包" aria-label="搜索成果" hide-details clearable class="filter-field-compact" />
    <v-select v-model="publication" :items="['全部','待归档','已归档']" label="归档状态" hide-details class="filter-field-compact w-140px" />
    <v-btn :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新</v-btn>
   </Row>
  </Row>
  <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
  <p v-if="loading&&!data" class="text-sm text-muted">正在读取成果…</p>
  <section v-else-if="data" class="surface-card">
   <v-empty-state v-if="!visible.length" :title="filtered.length?'没有符合筛选条件的成果':'暂无可交付题目'" :text="filtered.length?'调整搜索内容或归档状态后再试。':'题目出题完成后会汇总到这里，可直接进入交付归档。'" />
   <Column v-else class="w-full overflow-x-auto">
    <v-table density="comfortable" class="min-w-920px">
     <thead><tr><th scope="col">项目 / 题目</th><th scope="col">所属材料包</th><th scope="col">版本</th><th scope="col">归档状态</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead>
     <tbody>
      <tr v-for="item in visible" :key="item.workflow_id">
       <td><RouterLink :to="`/projects/${item.project_id}`" class="link-text text-xs">{{ item.project_name }}</RouterLink><Row wrap y="center" :gap="6"><div class="font-medium text-ink-heading">{{ item.title }}</div><v-chip v-if="item.load_eligible===false" size="x-small" color="warning" variant="tonal">材料≤10页（约 {{ item.load_estimated_docx_pages }} 页）</v-chip></Row><div class="text-xs text-muted">{{ item.source_key||'未分组' }}</div></td>
       <td><RouterLink v-if="item.library_package_id" :to="`/materials/${item.library_package_id}`" class="link-text">{{ item.library_package_name??'查看材料包' }}</RouterLink><RouterLink v-else-if="item.source_workflow_id" :to="`/workflows/${item.source_workflow_id}`" class="link-text">{{ item.source_material_package_title??'查看材料包' }}</RouterLink><span v-else class="text-muted">旧题目目录</span></td>
       <td class="text-xs text-muted">题目 {{ item.current_question_version??'—' }}<br>评分表 {{ item.current_rubric_version??'—' }}</td>
       <td><v-chip size="small" :color="item.publication_status==='succeeded'?'success':'secondary'">{{ item.publication_status==='succeeded'?'已归档':'待归档' }}</v-chip><div class="text-xs text-muted">{{ item.exported?'已导出':'未导出' }}</div></td>
       <td class="text-xs text-muted">{{ dateLabel(item.created_at) }}</td>
       <td><v-btn :to="`/workflows/${item.workflow_id}`" color="primary" variant="text">查看题目</v-btn></td>
      </tr>
     </tbody>
    </v-table>
   </Column>
  </section>
  <Row x="between" wrap y="center" :gap="8"><span class="text-xs text-muted">本页 {{ filtered.length }} 道 · 第 {{ page }} 页{{ hasMore ? " · 后面还有" : "" }}</span><v-pagination v-model="page" :length="pageCount" :total-visible="5" :disabled="pageCount<=1" aria-label="成果分页" /></Row>
 </Column>
</template>
