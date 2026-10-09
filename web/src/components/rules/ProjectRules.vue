<script setup lang="ts">
import { api } from '../../api/client';
import { useResource } from '../../composables/useResource';
import type { ProjectRules as RulesView,RuleFile } from '../../types/api';
import { fileSize,dateLabel } from '../../utils/format';
const props=defineProps<{projectId:string}>();
const {data,error,loading,refresh}=useResource<RulesView>(`/projects/${props.projectId}/rules`);
const workspacePath=shallowRef('');const action=shallowRef<'register'|'freeze'|'remove'|null>(null);const busy=computed(()=>action.value!==null);const message=shallowRef('');
const editing=shallowRef<RuleFile|null|undefined>();const removing=shallowRef<RuleFile|null>(null);
const materials=computed(()=>data.value?.workspace.files.filter(file=>file.path.startsWith('materials/'))??[]);
const skillFiles=computed(()=>data.value?.workspace.files.filter(file=>file.path.startsWith('skill/'))??[]);
watch(()=>data.value?.workspace.workspace_path,value=>{if(value)workspacePath.value=value;});
async function register(){
 try{action.value='register';error.value='';await api(`/projects/${props.projectId}/rules/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_path:workspacePath.value})});await refresh();message.value='当前资料和 skill 指纹已登记。';}
 catch(cause){error.value=cause instanceof Error?cause.message:'登记失败';}finally{action.value=null;}
}
async function freeze(){
 if(!data.value)return;
 try{action.value='freeze';error.value='';const result=await api<{version:number}>(`/projects/${props.projectId}/rules/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_digest:data.value.workspace.source_digest})});await refresh();message.value=`内部版本 v${result.version} 已冻结，后续修改不覆盖此快照。`;}
 catch(cause){error.value=cause instanceof Error?cause.message:'冻结失败';}finally{action.value=null;}
}
async function remove(){
 if(!removing.value)return;
 try{action.value='remove';error.value='';await api(`/projects/${props.projectId}/rules/file`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:removing.value.path,expected_sha256:removing.value.sha256})});removing.value=null;await refresh();message.value='资料已从工作目录移除，已冻结的历史版本保留。';}
 catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{action.value=null;}
}
async function saved(){editing.value=undefined;await refresh();message.value='资料已保存，后续使用前需冻结新的版本。';}
</script>
<template><Column :gap="16"><SkillGeneration :project-id="projectId" @adopted="refresh" />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <v-alert v-if="message" type="info" role="status">{{ message }}</v-alert>
 <Column class="surface-card p-16" :gap="12">
  <Row x="between" wrap :gap="8"><h2 class="section-title">本期规则工作区</h2><v-btn :loading="loading" :disabled="busy" @click="refresh">刷新文件</v-btn></Row>
  <p class="text-xs text-muted">资料和 skill 保存在本地；数据库记录路径、指纹和版本。工作区包含 materials/、skill/ 和可选的 project.json。</p>
  <Row wrap :gap="8"><v-text-field v-model="workspacePath" label="项目工作区绝对路径" hide-details class="min-w-0 flex-1" :disabled="busy" /><v-btn :loading="action==='register'" :disabled="busy||!workspacePath.trim()" @click="register">登记资料</v-btn></Row>
  <template v-if="data"><code class="text-xs text-muted break-all">skill：{{ data.workspace.skill_path }}</code>
   <Row wrap :gap="8"><v-chip :color="data.source_changed||data.draft_is_stale?'warning':'secondary'">{{ data.source_changed?'工作目录与已冻结版本不同':data.draft_is_stale?'草稿指纹待更新':'当前文件已读取' }}</v-chip><v-btn color="primary" variant="flat" :disabled="busy||loading||data.workspace.issues.length>0" :loading="action==='freeze'" @click="freeze">冻结内部版本</v-btn></Row>
   <v-alert v-if="data.workspace.issues.length" type="warning"><p v-for="issue in data.workspace.issues" :key="issue" class="text-sm break-words">{{ issue }}</p></v-alert>
   <p class="text-xs text-muted">冻结版本会由出题、质检和独立评分自动读取；模型作答不会收到评分标准。冻结仅固定项目资料，不代表符合正式提交资格。</p>
   <Column v-if="data.workspace.unresolved.length" :gap="6" class="border-t border-line-subtle pt-12"><h3 class="text-sm font-medium">已登记的待核事项</h3><p v-for="issue in data.workspace.unresolved" :key="issue.id" class="text-sm text-muted">{{ issue.detail||issue.id }}</p></Column>
  </template>
 </Column>
 <template v-if="data">
  <Column class="surface-card p-16" :gap="12"><Row x="between" wrap :gap="8"><h2 class="section-title">规则资料 · {{ materials.length }}</h2><v-btn :disabled="busy" @click="editing=null">增加资料</v-btn></Row><p v-if="!materials.length" class="text-sm text-muted">暂无规则资料，可上传或新增文字文件。</p>
   <Row v-for="file in materials" :key="file.path" x="between" wrap :gap="8" class="border-t border-line-subtle pt-12"><Column :gap="4" class="min-w-0"><span class="text-sm break-all">{{ file.path.slice(10) }}</span><span class="text-xs text-muted">{{ fileSize(file.size_bytes) }} · SHA-256 {{ file.sha256.slice(0,12) }}</span></Column><Row :gap="8"><v-btn :disabled="busy" @click="editing=file">查看 / 修改</v-btn><v-btn color="error" :disabled="busy" @click="removing=file">删除</v-btn></Row></Row>
  </Column>
  <Column class="surface-card p-16" :gap="12"><h2 class="section-title">本地 skill · {{ skillFiles.length }} 个文件</h2><p class="text-xs text-muted">包含入口、references 与 assets。页面只读；需要调整时修改本地文件，再刷新并冻结新版本。</p><p v-if="!skillFiles.length" class="text-sm text-muted">尚无 skill 文件。</p>
   <Row v-for="file in skillFiles" :key="file.path" x="between" wrap :gap="8" class="border-t border-line-subtle pt-12"><span class="text-sm break-all">{{ file.path.slice(6) }}</span><v-btn @click="editing=file">查看</v-btn></Row>
  </Column>
  <Column class="surface-card p-16" :gap="12"><h2 class="section-title">规则版本 · {{ data.versions.length }}</h2><p v-if="!data.versions.length" class="text-sm text-muted">尚未登记版本。</p><Column v-for="version in data.versions" :key="version.id" :gap="6" class="border-t border-line-subtle pt-12"><Row wrap :gap="8"><span class="text-sm font-medium">v{{ version.version }}</span><v-chip :color="version.status==='published'?'success':'secondary'">{{ version.status==='published'?'已冻结':'草稿' }}</v-chip><span class="text-xs text-muted">{{ version.created_at?dateLabel(version.created_at):'—' }} · {{ version.manifest.files?.length??0 }} 个文件</span></Row><code class="text-xs text-muted break-all">{{ version.manifest.snapshot_path||version.manifest.workspace_path }}</code></Column></Column>
 </template>
 <v-dialog :model-value="editing!==undefined" max-width="880" persistent><RuleFileEditor v-if="editing!==undefined" :key="editing?.path??'new'" :project-id="projectId" :file="editing" @saved="saved" @close="editing=undefined" /></v-dialog>
 <v-dialog :model-value="removing!==null" max-width="460" :persistent="busy" @update:model-value="removing=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除规则资料</h2><p class="text-sm break-all">{{ removing?.path }}</p><p class="text-xs text-muted">删除当前工作文件。历史快照保留，后续使用需要冻结新版本。</p><Row x="end" :gap="8"><v-btn :disabled="busy" @click="removing=null">取消</v-btn><v-btn color="error" variant="flat" :loading="busy" @click="remove">删除</v-btn></Row></Column></v-dialog>
</Column></template>
