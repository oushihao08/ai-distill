<script setup lang="ts">
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { dateLabel } from '../utils/format';
import { appTheme } from '../theme';
import type { Project } from '../types/api';
const { data, loading, error, refresh } = useResource<Project[]>('/projects');
const router = useRouter();
const createOpen = shallowRef(false);
const search = shallowRef('');
const editing=shallowRef<Project|undefined>();const deleting=shallowRef<Project|null>(null);const deletingBusy=shallowRef(false);
function createProject(){editing.value=undefined;createOpen.value=true;}
function editProject(project:Project){editing.value=project;createOpen.value=true;}
async function removeProject(){if(!deleting.value)return;try{deletingBusy.value=true;await api(`/projects/${deleting.value.id}`,{method:'DELETE'});deleting.value=null;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{deletingBusy.value=false;}}
const visibleProjects = computed(() => data.value?.filter(p => `${p.name} ${p.description}`.toLowerCase().includes((search.value ?? '').trim().toLowerCase())) ?? []);
const workflowCount = computed(() => data.value?.reduce((sum, p) => sum + (p.workflow_count ?? 0), 0));
function openCreated(project: Project) { createOpen.value = false; if(editing.value){refresh();return;} router.push(`/projects/${project.id}`).catch(() => { error.value = '无法打开项目，请刷新列表'; }); }
</script>
<template><Column :gap="24">
 <Row x="between" wrap :gap="16"><Column :gap="8"><h1 class="text-3xl font-bold text-ink-heading">出题项目</h1><p class="body-text text-muted">管理每一期的材料，从接收到成果，保留完整处理记录。</p></Column><v-btn color="primary" variant="flat" @click="createProject"><template #prepend><UiIcon name="plus" /></template>新建项目</v-btn></Row>
 <Row wrap :gap="16">
  <Column class="surface-card p-16 flex-1 min-w-column-narrow" :gap="12"><Row x="between"><span class="text-sm text-muted">出题项目</span><UiIcon name="grid" class="text-primary" /></Row><Row :gap="8"><strong class="text-3xl text-ink-heading">{{ data ? data.length : '—' }}</strong><span class="text-sm text-muted">个项目</span></Row></Column>
  <Column class="surface-card p-16 flex-1 min-w-column-narrow" :gap="12"><Row x="between"><span class="text-sm text-muted">材料工作流</span><UiIcon name="file" class="text-primary" /></Row><Row :gap="8"><strong class="text-3xl text-ink-heading">{{ workflowCount ?? '—' }}</strong><span class="text-sm text-muted">条记录</span></Row></Column>
  <Column class="surface-card p-16 flex-1 min-w-column-narrow" :gap="12"><Row x="between"><span class="text-sm text-muted">流程接入</span><UiIcon name="activity" class="text-primary" /></Row><Row :gap="8"><strong class="text-3xl text-ink-heading">2<span class="text-lg text-muted font-normal"> / 8</span></strong><span class="text-sm text-muted">材料处理已开放</span></Row></Column>
 </Row>
 <WorkerMonitor />
 <CodexConfig />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <section class="surface-card"><Column :gap="0">
  <Row x="between" wrap class="p-16 border-b border-line" :gap="12"><Column :gap="4"><h2 class="section-title">全部项目</h2><span class="text-xs text-muted">{{ visibleProjects.length }} 个项目</span></Column><Row wrap :gap="8" class="w-full sm:w-auto max-w-full"><v-text-field v-model="search" aria-label="搜索项目" placeholder="搜索项目" clearable hide-details class="filter-field-compact"><template #prepend-inner><UiIcon name="search" /></template></v-text-field><v-btn color="secondary" :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新</v-btn></Row></Row>
  <p v-if="loading && !data" class="p-24 text-muted">正在读取项目…</p>
  <v-empty-state v-else-if="!visibleProjects.length" :title="search ? '没有找到相关项目' : '从第一个项目开始'" :text="search ? '试试其他名称或说明关键词。' : '新建项目后，指定本地材料文件夹，按题目目录建立工作流。'" />
  <Row v-for="project in visibleProjects" :key="project.id" :gap="12" class="p-16 border-b border-line-subtle last:border-b-0"><RouterLink :to="`/projects/${project.id}`" class="flex-1 min-w-0 hover:text-primary">
   <Row x="between" wrap :gap="16"><Row :gap="16" class="min-w-0 flex-1"><span class="p-12 rounded-xl bg-primary-soft text-primary shrink-0"><UiIcon name="layers" /></span><Column :gap="4" class="min-w-0"><h3 class="text-base font-semibold text-ink-heading break-words">{{ project.name }}</h3><p class="text-sm text-muted break-words">{{ project.description || '暂无项目说明' }}</p><span class="text-xs text-muted">创建于 {{ dateLabel(project.created_at) }}</span></Column></Row><Row :gap="16"><v-chip color="secondary">{{ project.workflow_count }} 条工作流</v-chip><UiIcon name="arrow" class="text-muted" /></Row></Row>
  </RouterLink><Row :gap="8"><v-btn @click="editProject(project)">编辑</v-btn><v-btn color="error" @click="deleting=project">删除</v-btn></Row></Row>
 </Column></section>
 <v-dialog v-model="createOpen" :max-width="appTheme.spacing.namedWidth.xl" :persistent="false"><ProjectForm v-if="createOpen" :project="editing" @created="openCreated" @close="createOpen=false" /></v-dialog>
<v-dialog :model-value="deleting!==null" max-width="420" @update:model-value="deleting=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除项目</h2><p class="text-sm text-muted">删除「{{ deleting?.name }}」并停止派发任务，历史和原件保留。</p><Row x="end" :gap="8"><v-btn :disabled="deletingBusy" @click="deleting=null">取消</v-btn><v-btn color="error" variant="flat" :loading="deletingBusy" @click="removeProject">删除</v-btn></Row></Column></v-dialog>
</Column></template>
