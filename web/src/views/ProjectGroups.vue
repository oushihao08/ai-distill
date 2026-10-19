<!--
职责：主项目导航；显示期次数量、编辑主项目名称，并复用 ProjectForm 创建首期。
关键方法：`created()` 创建主项目后进入期次列表；`saveGroupName()` 调用现有主项目改名接口，不触碰期次业务数据。
使用场景：应用根路由 `/`，主项目作为跨期身份，业务设置和题目保留在期次。
-->
<script setup lang="ts">
import {api} from '../api/client';
import {useResource} from '../composables/useResource';
import type {Project} from '../types/api';
import ProjectForm from '../components/ProjectForm.vue';
import SystemStepPromptSettings from '../components/SystemStepPromptSettings.vue';
interface Group {id:string;name:string;phase_count:number;latest_phase_no:number}
const {data,error,loading,refresh}=useResource<{items:Group[]}>('/project-groups');
const search=shallowRef(''),createOpen=shallowRef(false);
const router=useRouter();
const visible=computed(()=>data.value?.items.filter(item=>item.name.includes((search.value??'').trim()))??[]);
const editingGroup=shallowRef<Group|null>(null),groupName=shallowRef(''),savingGroup=shallowRef(false);
function editGroup(group:Group){editingGroup.value=group;groupName.value=group.name;}
async function saveGroupName(){
 if(!editingGroup.value||!groupName.value.trim())return;
 try{savingGroup.value=true;error.value='';await api(`/project-groups/${editingGroup.value.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:groupName.value.trim()})});editingGroup.value=null;await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'主项目名称保存失败';}
 finally{savingGroup.value=false;}
}
async function created(project:Project){
 createOpen.value=false;
 try{await router.push(`/project-groups/${project.project_group_id}`);}catch(cause){error.value=cause instanceof Error?cause.message:'无法打开主项目';}
}
</script>
<template><Column :gap="20">
 <Row x="between" wrap :gap="12"><Column :gap="6"><h1 class="text-2xl font-bold text-ink-heading">主项目</h1><p class="text-sm text-muted">主项目用于跨期归属与材料防重；题目、模型设置和评测结果按期次隔离。</p></Column><Row wrap :gap="8"><SystemStepPromptSettings/><v-btn color="primary" @click="createOpen=true">新建主项目与第一期</v-btn></Row></Row>
 <v-alert v-if="error" type="error">{{ error }}</v-alert>
 <section class="surface-card p-16"><Column :gap="12">
  <Row wrap x="between" :gap="12"><v-text-field v-model="search" label="搜索主项目" clearable hide-details/><v-btn :loading="loading" :disabled="loading" @click="refresh">刷新</v-btn></Row>
  <p v-if="loading&&!data" class="text-sm text-muted" role="status">正在读取主项目…</p><v-empty-state v-else-if="!visible.length" :title="search?'没有找到主项目':'还没有主项目'" :text="search?'试试其他名称。':'创建主项目时会一并建立第一期。'" />
  <Row v-for="group in visible" :key="group.id" x="between" wrap y="center" :gap="12" class="p-16 border-b border-line-subtle last:border-b-0">
   <RouterLink :to="`/project-groups/${group.id}`" class="flex-1 min-w-0 link-text"><Row x="between" wrap :gap="12"><strong>{{ group.name }}</strong><span class="text-sm text-muted">{{ group.phase_count }} 个期次 · 最高登记第 {{ group.latest_phase_no }} 期 →</span></Row></RouterLink>
   <v-btn size="small" variant="outlined" @click="editGroup(group)">编辑主项目</v-btn>
  </Row>
 </Column></section>
 <v-dialog v-model="createOpen" max-width="640"><ProjectForm v-if="createOpen" :next-phase-no="1" @created="created" @close="createOpen=false"/></v-dialog>
 <v-dialog :model-value="editingGroup!==null" max-width="520" @update:model-value="value=>{if(!value&&!savingGroup)editingGroup=null}"><v-card><v-card-title>编辑主项目</v-card-title><v-card-text><v-alert type="info" density="compact" class="mb-12">只更新主项目显示名称；期次题目、工作流、模型设置和材料使用记录保留原状。</v-alert><v-text-field v-model="groupName" label="主项目名称" maxlength="120" :disabled="savingGroup" autofocus @keydown.enter.prevent="saveGroupName"/><v-alert v-if="error" type="error">{{ error }}</v-alert></v-card-text><v-card-actions><v-spacer/><v-btn :disabled="savingGroup" @click="editingGroup=null">取消</v-btn><v-btn color="primary" :loading="savingGroup" :disabled="!groupName.trim()" @click="saveGroupName">保存名称</v-btn></v-card-actions></v-card></v-dialog>
</Column></template>
