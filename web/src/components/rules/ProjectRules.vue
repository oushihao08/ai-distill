<!--
职责：展示主项目共享规则资料及本期实际生效 Skill。
关键方法与用法：接收 `projectId` 读取规则 API；`remove()` 按预期指纹删除共享资料；仅在取得有效 Skill 绑定后开放候选生成与采用。
-->

<script setup lang="ts">
import { api } from '@/api/client';
import { useResource } from '@/composables/useResource';
import type { ProjectRules as RulesView,ProjectSkillBinding,RuleFile } from '@/types/api';
import { fileSize } from '@/utils/format';
const props=defineProps<{projectId:string}>();
const {data,error,loading,refresh}=useResource<RulesView>(`/projects/${props.projectId}/rules`);
const action=shallowRef<'remove'|null>(null);const busy=computed(()=>action.value!==null);const message=shallowRef('');
const editing=shallowRef<RuleFile|null|undefined>();const removing=shallowRef<RuleFile|null>(null);
const materials=computed(()=>data.value?.workspace.files.filter(file=>file.path.startsWith('materials/'))??[]);
const skillFiles=computed(()=>data.value?.workspace.files.filter(file=>file.path.startsWith('skill/'))??[]);
const skillBinding=computed(()=>{
 const value=(data.value as (RulesView&{skill?:unknown})|undefined)?.skill;
 if(!value||typeof value!=='object')return undefined;
 const binding=value as Partial<ProjectSkillBinding>;
 if((binding.source!=='phase'&&binding.source!=='project')||typeof binding.path!=='string'||typeof binding.project_path!=='string'||!(typeof binding.phase_path==='string'||binding.phase_path===null))return undefined;
 return binding as ProjectSkillBinding;
});
async function remove(){
 if(!removing.value)return;
 try{action.value='remove';error.value='';await api(`/projects/${props.projectId}/rules/file`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:removing.value.path,expected_sha256:removing.value.sha256})});removing.value=null;await refresh();message.value='主项目共享规则资料已移除；后续新任务会读取更新后的文件。';}
 catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{action.value=null;}
}
async function saved(){editing.value=undefined;await refresh();message.value='主项目共享规则资料已保存；后续新任务会读取当前文件。';}
</script>
<template><Column :gap="20">
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <v-alert v-if="message" type="info" role="status">{{ message }}</v-alert>
 <template v-if="data">
  <Column class="border-b border-line-subtle pb-16" :gap="12"><Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">主项目共享规则资料 · {{ materials.length }}</h2><p class="text-xs text-muted">同一主项目各期共用；不包含全局材料库中的案卷材料包。</p></Column><Row :gap="8"><v-btn :loading="loading" :disabled="busy" @click="refresh">刷新</v-btn><v-btn :disabled="busy" @click="editing=null">增加资料</v-btn></Row></Row>
   <code class="text-xs text-muted break-all">{{ data.workspace.materials_path }}</code>
   <v-alert v-if="!materials.length" type="warning" density="compact">主项目还没有共享规则资料。规则文件可在此添加一次，后续各期共用。</v-alert>
   <Row v-for="file in materials" :key="file.path" x="between" wrap :gap="8" class="border-t border-line-subtle pt-12"><Column :gap="4" class="min-w-0"><span class="text-sm break-all">{{ file.path.slice(10) }}</span><span class="text-xs text-muted">{{ fileSize(file.size_bytes) }} · SHA-256 {{ file.sha256.slice(0,12) }}</span></Column><Row :gap="8"><v-btn :disabled="busy" @click="editing=file">查看 / 修改</v-btn><v-btn color="error" :disabled="busy" @click="removing=file">删除</v-btn></Row></Row>
  </Column>
  <Column v-if="skillBinding" class="border-b border-line-subtle pb-16" :gap="12"><Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">本期 Skill</h2><p class="text-xs text-muted">有本期 Skill 时优先使用；尚未创建时自动使用主项目 Skill。</p></Column><v-chip :color="skillBinding.source==='phase'?'primary':'secondary'">{{ skillBinding.source==='phase'?'使用本期 Skill':'使用主项目默认 Skill' }}</v-chip></Row>
   <code class="text-xs text-muted break-all">当前生效：{{ skillBinding.path }}</code>
   <code v-if="skillBinding.source==='project'" class="text-xs text-muted break-all">主项目默认 Skill：{{ skillBinding.project_path }}</code>
   <code v-if="skillBinding.phase_path" class="text-xs text-muted break-all">本期 Skill 目录：{{ skillBinding.phase_path }}</code>
   <SkillGeneration :project-id="projectId" :phase-capable="skillBinding.phase_path!==null" @adopted="refresh" />
   <h3 class="text-sm font-medium">当前生效 Skill 文件 · {{ skillFiles.length }}</h3><p v-if="!skillFiles.length" class="text-sm text-muted">当前生效目录中未发现 Skill 文件。</p>
   <Row v-for="file in skillFiles" :key="file.path" x="between" wrap :gap="8" class="border-t border-line-subtle pt-12"><span class="text-sm break-all">{{ file.path.slice(6) }}</span><v-btn @click="editing=file">查看</v-btn></Row>
  </Column>
  <v-alert v-else-if="data" type="error" density="compact" role="alert">当前接口没有返回有效的 Skill 绑定信息，无法确认本期是否回退使用主项目 Skill；为避免用错 Skill，已暂时关闭候选生成。请刷新页面并确认后端已加载最新规则接口。</v-alert>
  <v-alert v-if="data.workspace.issues.some(issue=>issue!=='缺少主项目共享规则资料')" type="warning" density="compact"><p v-for="issue in data.workspace.issues.filter(issue=>issue!=='缺少主项目共享规则资料')" :key="issue" class="text-sm break-words">{{ issue }}</p></v-alert>
  <Column v-if="data.workspace.unresolved.length" :gap="6"><h3 class="text-sm font-medium">已登记的待核事项</h3><p v-for="issue in data.workspace.unresolved" :key="issue.id" class="text-sm text-muted">{{ issue.detail||issue.id }}</p></Column>
  <p class="text-xs text-muted">新建出题任务时会冻结当前生效 Skill 的文件指纹。若文件在排队期间变化，任务会停止并要求重新派发；已完成题目保留原始输入快照。作答不读取 Skill，独立评分按现行隔离规则执行。</p>
 </template>
 <v-dialog :model-value="editing!==undefined" max-width="880" persistent><RuleFileEditor v-if="editing!==undefined" :key="editing?.path??'new'" :project-id="projectId" :file="editing" @saved="saved" @close="editing=undefined" /></v-dialog>
 <v-dialog :model-value="removing!==null" max-width="460" :persistent="busy" @update:model-value="removing=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除主项目共享规则资料</h2><p class="text-sm break-all">{{ removing?.path }}</p><p class="text-xs text-muted">删除主项目共享目录中的文件；后续任务将读取其余共享资料。</p><Row x="end" :gap="8"><v-btn :disabled="busy" @click="removing=null">取消</v-btn><v-btn color="error" variant="flat" :loading="busy" @click="remove">删除</v-btn></Row></Column></v-dialog>
</Column></template>
