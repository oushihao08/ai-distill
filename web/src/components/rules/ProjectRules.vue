<!--
职责：展示并管理项目当前 materials／skill 文件；新任务直接读取当前文件，不要求登记或冻结版本。
关键方法与用法：`remove()` 按预期指纹删除资料；接收 `projectId`，并嵌入 `SkillGeneration` 生成并采用当前 skill 候选。
-->

<script setup lang="ts">
import { api } from '@/api/client';
import { useResource } from '@/composables/useResource';
import type { ProjectRules as RulesView,RuleFile } from '@/types/api';
import { fileSize } from '@/utils/format';
const props=defineProps<{projectId:string}>();
const {data,error,loading,refresh}=useResource<RulesView>(`/projects/${props.projectId}/rules`);
const action=shallowRef<'remove'|null>(null);const busy=computed(()=>action.value!==null);const message=shallowRef('');
const editing=shallowRef<RuleFile|null|undefined>();const removing=shallowRef<RuleFile|null>(null);
const materials=computed(()=>data.value?.workspace.files.filter(file=>file.path.startsWith('materials/'))??[]);
const skillFiles=computed(()=>data.value?.workspace.files.filter(file=>file.path.startsWith('skill/'))??[]);
async function remove(){
 if(!removing.value)return;
 try{action.value='remove';error.value='';await api(`/projects/${props.projectId}/rules/file`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:removing.value.path,expected_sha256:removing.value.sha256})});removing.value=null;await refresh();message.value='主项目共享资料已移除；后续各期新任务会读取更新后的文件。';}
 catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{action.value=null;}
}
async function saved(){editing.value=undefined;await refresh();message.value='主项目共享资料已保存；后续各期新任务会读取当前文件。';}
</script>
<template><Column :gap="16"><SkillGeneration :project-id="projectId" @adopted="refresh" />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <v-alert v-if="message" type="info" role="status">{{ message }}</v-alert>
 <Column class="border-b border-line-subtle pb-16" :gap="12">
  <Row x="between" wrap :gap="8"><h2 class="section-title">主项目共享资料与 skill</h2><v-btn :loading="loading" :disabled="busy" @click="refresh">刷新文件</v-btn></Row>
  <p class="text-xs text-muted">同一主项目下各期共用规则资料和 skill。出题和独立评分每次新建任务时读取当前 skill；题目附件读取数据库里的原始提取文本或脱敏文本。模型作答不读取项目 skill 或评分资料。</p>
  <template v-if="data"><code class="text-xs text-muted break-all">共享规则资料目录：{{ data.workspace.materials_path }}</code><code class="text-xs text-muted break-all">共享 skill：{{ data.workspace.skill_path }}</code>
   <v-chip color="secondary">当前文件已读取</v-chip>
   <v-alert v-if="data.workspace.issues.length" type="warning"><p v-for="issue in data.workspace.issues" :key="issue" class="text-sm break-words">{{ issue }}</p></v-alert>
   <p class="text-xs text-muted">任务创建时会记录当前项目文件指纹，执行时读取并校验这些文件；若文件在排队期间变化，任务会停止并要求重新派发。</p>
   <Column v-if="data.workspace.unresolved.length" :gap="6" class="border-t border-line-subtle pt-12"><h3 class="text-sm font-medium">已登记的待核事项</h3><p v-for="issue in data.workspace.unresolved" :key="issue.id" class="text-sm text-muted">{{ issue.detail||issue.id }}</p></Column>
  </template>
 </Column>
 <template v-if="data">
  <Column class="border-b border-line-subtle pb-16" :gap="12"><Row x="between" wrap :gap="8"><h2 class="section-title">共享规则资料 · {{ materials.length }}</h2><v-btn :disabled="busy" @click="editing=null">增加资料</v-btn></Row><p v-if="!materials.length" class="text-sm text-muted">主项目暂无共享规则资料，可上传或新增文字文件；同一主项目的期次共用这些资料。</p>
   <Row v-for="file in materials" :key="file.path" x="between" wrap :gap="8" class="border-t border-line-subtle pt-12"><Column :gap="4" class="min-w-0"><span class="text-sm break-all">{{ file.path.slice(10) }}</span><span class="text-xs text-muted">{{ fileSize(file.size_bytes) }} · SHA-256 {{ file.sha256.slice(0,12) }}</span></Column><Row :gap="8"><v-btn :disabled="busy" @click="editing=file">查看 / 修改</v-btn><v-btn color="error" :disabled="busy" @click="removing=file">删除</v-btn></Row></Row>
  </Column>
  <Column :gap="12"><h2 class="section-title">共享 skill · {{ skillFiles.length }} 个文件</h2><p class="text-xs text-muted">包含入口、references 与 assets。页面只读；直接修改主项目 skill 文件，再刷新即可供后续各期新任务使用。</p><p v-if="!skillFiles.length" class="text-sm text-muted">尚无 skill 文件。</p>
   <Row v-for="file in skillFiles" :key="file.path" x="between" wrap :gap="8" class="border-t border-line-subtle pt-12"><span class="text-sm break-all">{{ file.path.slice(6) }}</span><v-btn @click="editing=file">查看</v-btn></Row>
  </Column>
 </template>
 <v-dialog :model-value="editing!==undefined" max-width="880" persistent><RuleFileEditor v-if="editing!==undefined" :key="editing?.path??'new'" :project-id="projectId" :file="editing" @saved="saved" @close="editing=undefined" /></v-dialog>
 <v-dialog :model-value="removing!==null" max-width="460" :persistent="busy" @update:model-value="removing=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">删除共享规则资料</h2><p class="text-sm break-all">{{ removing?.path }}</p><p class="text-xs text-muted">删除主项目共享目录中的文件；后续各期新任务将读取其余共享资料。</p><Row x="end" :gap="8"><v-btn :disabled="busy" @click="removing=null">取消</v-btn><v-btn color="error" variant="flat" :loading="busy" @click="remove">删除</v-btn></Row></Column></v-dialog>
</Column></template>
