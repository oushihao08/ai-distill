<!--
职责：列出单个主项目下的期次，提供期次身份与业务配置的分开编辑。
关键方法：`savePhaseIdentity()` 调用专用期次身份接口；`removeProject()` 删除当前期次；`openCreated()` 打开新建期次详情。
使用场景：`/project-groups/:groupId`；工作流、题目及期次设置仍按现有 project ID 隔离。
-->

<script setup lang="ts">
import {usePageBreadcrumbs} from '../composables/usePageBreadcrumbs';
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { dateLabel } from '../utils/format';
import { appTheme } from '../theme';
import type { Project } from '../types/api';
const route=useRoute();
const groupId=String(route.params.groupId);
const {data:response,loading,error,refresh}=useResource<{group:{id:string;name:string};items:Project[]}>(`/project-groups/${groupId}/phases`);
const data=computed(()=>response.value?.items);
usePageBreadcrumbs(()=>[{title:'出题项目',to:'/'},{title:response.value?.group.name??'主项目期次'}]);
const nextPhaseNo=computed(()=>Math.max(0,...(data.value??[]).map(item=>item.phase_no??0))+1);
const router = useRouter();
const createOpen = shallowRef(false);
const search = shallowRef('');
const editing=shallowRef<Project|undefined>();const deleting=shallowRef<Project|null>(null);const deletingBusy=shallowRef(false);
const identityPhase=shallowRef<Project|null>(null),identityNo=shallowRef<number|string>(1),identityName=shallowRef(''),identitySaving=shallowRef(false),identityError=shallowRef(''),message=shallowRef('');
function createProject(){editing.value=undefined;createOpen.value=true;}
function editProject(project:Project){editing.value=project;createOpen.value=true;}
function editIdentity(project:Project){identityPhase.value=project;identityNo.value=project.phase_no??1;identityName.value=project.phase_name??'';identityError.value='';}
async function savePhaseIdentity(){
 if(!identityPhase.value)return;
 try{identitySaving.value=true;identityError.value='';await api(`/projects/${identityPhase.value.id}/phase-identity`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase_no:Number(identityNo.value),phase_name:identityName.value.trim(),expected_name:identityPhase.value.name})});identityPhase.value=null;message.value='期次身份已更新；题目与评测记录保留原状。';await refresh();}
 catch(cause){identityError.value=cause instanceof Error?cause.message:'期次身份保存失败';}
 finally{identitySaving.value=false;}
}
async function removeProject(){if(!deleting.value)return;try{deletingBusy.value=true;await api(`/projects/${deleting.value.id}`,{method:'DELETE'});deleting.value=null;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{deletingBusy.value=false;}}
const visibleProjects = computed(() => data.value?.filter(p => `${p.name} ${p.description}`.toLowerCase().includes((search.value ?? '').trim().toLowerCase())) ?? []);
const materialCount = computed(() => data.value?.reduce((sum, p) => sum + (p.material_package_count ?? 0), 0));
const questionCount = computed(() => data.value?.reduce((sum, p) => sum + (p.question_count ?? 0), 0));
function openCreated(project: Project) { createOpen.value = false; if(editing.value){refresh();return;} router.push(`/projects/${project.id}`).catch(() => { error.value = '无法打开项目，请刷新列表'; }); }
</script>
<template><Column :gap="24">
 <RouterLink to="/" class="link-text">← 全部主项目</RouterLink>
 <Row x="between" wrap :gap="16"><Column :gap="8"><h1 class="text-3xl font-bold text-ink-heading">{{ response?.group.name }} · 期次</h1><p class="body-text text-muted">题目、作答模型和评测结果按期次隔离；材料在主项目内永久防重，返修时只回到原期次。</p></Column><v-btn color="primary" variant="flat" @click="createProject"><template #prepend><UiIcon name="plus" /></template>新增期次</v-btn></Row>
 <v-alert v-if="message" type="success" role="status">{{ message }}</v-alert>
 <Row wrap :gap="16">
  <Column class="surface-card p-16 flex-1 min-w-column-narrow" :gap="12"><Row x="between"><span class="text-sm text-muted">期次数</span><UiIcon name="grid" class="text-primary" /></Row><Row :gap="8"><strong class="text-3xl text-ink-heading">{{ data ? data.length : '—' }}</strong><span class="text-sm text-muted">期</span></Row></Column>
  <Column class="surface-card p-16 flex-1 min-w-column-narrow" :gap="12"><Row x="between"><span class="text-sm text-muted">本主项目材料包记录</span><UiIcon name="file" class="text-primary" /></Row><Row :gap="8"><strong class="text-3xl text-ink-heading">{{ materialCount ?? '—' }}</strong><span class="text-sm text-muted">包</span></Row></Column>
  <Column class="surface-card p-16 flex-1 min-w-column-narrow" :gap="12"><Row x="between"><span class="text-sm text-muted">本主项目题目</span><UiIcon name="layers" class="text-primary" /></Row><Row :gap="8"><strong class="text-3xl text-ink-heading">{{ questionCount ?? '—' }}</strong><span class="text-sm text-muted">道</span></Row></Column>
 </Row>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <section class="surface-card"><Column :gap="0">
  <Row x="between" wrap class="p-16 border-b border-line" :gap="12"><Column :gap="4"><h2 class="section-title">本主项目的期次</h2><span class="text-xs text-muted">{{ visibleProjects.length }} 期</span></Column><Row wrap :gap="8" class="w-full sm:w-auto max-w-full"><v-text-field v-model="search" aria-label="搜索期次" placeholder="搜索期次" clearable hide-details class="filter-field-compact"><template #prepend-inner><UiIcon name="search" /></template></v-text-field><v-btn color="secondary" :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新</v-btn></Row></Row>
  <p v-if="loading && !data" class="p-24 text-muted" role="status">正在读取期次…</p>
  <v-empty-state v-else-if="!visibleProjects.length" :title="search ? '没有找到相关期次' : '还没有登记期次'" :text="search ? '试试其他期次名称或说明。' : '新增期次后，可从材料库加载尚未在本主项目使用过的材料。'" />
  <Row v-for="project in visibleProjects" :key="project.id" :gap="12" class="p-16 border-b border-line-subtle last:border-b-0"><RouterLink :to="`/projects/${project.id}`" class="flex-1 min-w-0 hover:text-primary">
   <Row x="between" wrap :gap="16"><Row :gap="16" class="min-w-0 flex-1"><span class="p-12 rounded-xl bg-primary-soft text-primary shrink-0"><UiIcon name="layers" /></span><Column :gap="4" class="min-w-0"><h3 class="text-base font-semibold text-ink-heading break-words">第 {{ project.phase_no??'—' }} 期 · {{ project.phase_name||project.name }}</h3><p class="text-sm text-muted break-words">{{ project.description || '暂无期次说明' }}</p><span class="text-xs text-muted">登记于 {{ dateLabel(project.created_at) }}</span></Column></Row><Row wrap :gap="8"><v-chip color="secondary">{{ project.material_package_count??0 }} 个材料包记录</v-chip><v-chip color="secondary">{{ project.question_count??0 }} 道题目</v-chip><UiIcon name="arrow" class="text-muted" /></Row></Row>
  </RouterLink><Row wrap :gap="8"><v-btn size="small" variant="outlined" @click="editIdentity(project)">期次身份</v-btn><v-btn size="small" @click="editProject(project)">编辑配置</v-btn><v-btn size="small" color="error" @click="deleting=project">删除期次</v-btn></Row></Row>
 </Column></section>
 <v-dialog v-model="createOpen" :max-width="appTheme.spacing.namedWidth.xl" :persistent="false"><ProjectForm v-if="createOpen" :project="editing" :project-group="response?.group" :next-phase-no="nextPhaseNo" @created="openCreated" @close="createOpen=false" /></v-dialog>
 <v-dialog :model-value="identityPhase!==null" max-width="560" @update:model-value="value=>{if(!value&&!identitySaving)identityPhase=null}"><v-card><v-card-title>调整期次身份</v-card-title><v-card-text><v-alert type="info" density="compact" class="mb-12">只有本期没有排队或运行任务时才能调整。系统会保护本期题目、作答、评分和归档记录。</v-alert><v-text-field v-model="identityNo" type="number" min="1" step="1" label="期号（正整数）" :disabled="identitySaving"/><v-text-field v-model="identityName" label="期次名称" maxlength="120" :disabled="identitySaving"/><v-alert v-if="identityError" type="error" role="alert">{{ identityError }}</v-alert></v-card-text><v-card-actions><v-spacer/><v-btn :disabled="identitySaving" @click="identityPhase=null">取消</v-btn><v-btn color="primary" :loading="identitySaving" :disabled="!Number.isSafeInteger(Number(identityNo))||Number(identityNo)<1||!identityName.trim()" @click="savePhaseIdentity">保存期次身份</v-btn></v-card-actions></v-card></v-dialog>
<v-dialog :model-value="deleting!==null" max-width="560" @update:model-value="deleting=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除本期及其题目数据</h2><p class="text-sm text-muted">将从工作台移除「{{ deleting?.phase_name||deleting?.name }}」，并删除本期题目、附件记录、步骤结果、答案、评分、执行历史和导出记录。主项目材料使用历史会保留，删除本期不会释放材料供同主项目其他期次重用。此操作无法在页面恢复。</p><Row x="end" :gap="8"><v-btn :disabled="deletingBusy" @click="deleting=null">取消</v-btn><v-btn color="error" variant="flat" :loading="deletingBusy" @click="removeProject">删除本期</v-btn></Row></Column></v-dialog>
</Column></template>
