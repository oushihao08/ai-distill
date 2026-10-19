<!--
职责：创建主项目首期或新增期次；编辑时只维护期次业务配置，不改主项目归属、期号或跨期共享 skill 路径。
关键方法与用法：`submit()` 按是否收到 `project` 选择 POST 或 PATCH；期次编号和名称由期次列表的身份入口专门维护；`tagsOnly` 供期次详情单独编辑题目标签。
-->

<script setup lang="ts">
import { api } from '../api/client';
import type { Project } from '../types/api';
const props = defineProps<{ project?: Project; tagsOnly?: boolean;projectGroup?:{id:string;name:string};nextPhaseNo?:number }>();
const emit = defineEmits<{ created: [project: Project]; close: [] }>();
const parentName = shallowRef(props.projectGroup?.name??props.project?.parent_name ?? props.project?.name ?? '');
const phaseName = shallowRef(props.project?.phase_name ?? '');
const phaseNo=shallowRef<number|string>(props.nextPhaseNo??1);
const description = shallowRef(props.project?.description ?? '');
const materialRoot = shallowRef(props.project?.material_root ?? '');
const materialBackend = shallowRef<Project['material_backend']>(props.project ? props.project.material_backend ?? 'legacy' : 'library_v1');
const isGroupedPhase = !!props.project?.project_group_id;
const workspacePath = shallowRef(props.project?.workspace_path ?? '');
const questionTags = shallowRef<string[]>([...(props.project?.question_tags??[])]);
const busy = shallowRef(false); const error = shallowRef('');
async function submit() {
 if (busy.value) return;
 busy.value = true; error.value = '';
 try {
  const parent = parentName.value.trim(), phase = phaseName.value.trim();
  const name = phase ? `${parent} - ${phase}` : parent;
  const materialSettings = isGroupedPhase ? {} : materialBackend.value==='library_v1' ? {material_backend:'library_v1',workspace_path:workspacePath.value} : {material_root:materialRoot.value,material_backend:materialBackend.value};
  const payload=props.tagsOnly?{question_tags:questionTags.value}:{...(!props.project?{name,parent_name:parent,phase_name:phase,phase_no:Number(phaseNo.value),project_group_id:props.projectGroup?.id,material_mode:'material_packages'}:props.project.project_group_id?{}:{name,parent_name:parent,phase_name:phase}),description:description.value,...materialSettings,question_tags:questionTags.value};
  const project = await api<Project>(props.project ? `/projects/${props.project.id}` : '/projects', {
   method: props.project ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify(payload),
  });
  emit('created',project);
 } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败'; }
 finally { busy.value = false; }
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="submit"><Column :gap="16">
 <Row x="between"><h2 class="section-title">{{ tagsOnly ? '管理本期出题标签' : project ? '编辑期次配置' : projectGroup ? '新增期次' : '新建主项目与第一期' }}</h2><v-btn icon="$close" variant="text" aria-label="关闭" :disabled="busy" @click="emit('close')" /></Row>
 <template v-if="!tagsOnly">
  <v-text-field v-model="parentName" label="主项目名称" required maxlength="120" :readonly="!!projectGroup||!!project?.project_group_id" :disabled="busy" />
  <v-text-field v-if="!project" v-model="phaseNo" type="number" min="1" step="1" label="期号（正整数）" :disabled="busy" />
  <v-text-field v-model="phaseName" label="期次名称" :required="!project" maxlength="120" :readonly="!!project?.project_group_id" :disabled="busy" />
  <v-alert v-if="project?.project_group_id" type="info" density="compact">主项目与期次身份请在期次列表中调整；此处仅编辑本期业务配置。</v-alert>
  <p v-if="!project" class="text-sm text-muted">材料来源：独立共享材料库。创建项目后，选择已完成脱敏的材料包加载使用。</p>
  <v-alert v-if="isGroupedPhase&&materialBackend!=='library_v1'" type="info" density="compact">本期已使用共享材料库。此处保留原来源目录作为历史记录；新增材料请从材料库加载，编辑本期配置不会修改或重新同步旧目录。</v-alert>
  <template v-else-if="materialBackend==='library_v1'">
   <v-text-field v-model="workspacePath" label="本期工作区目录" required placeholder="/…/主项目/期次" :readonly="!!project" :disabled="busy" />
   <v-alert type="info" density="compact">此路径标识本期工作区，不是材料包存放位置。案卷材料包保存在全局材料库，按需加载到本期；规则资料由主项目跨期共享，Skill 可由本期覆盖，否则使用主项目 Skill。</v-alert>
  </template>
  <template v-else>
   <v-text-field v-model="materialRoot" label="本期材料来源目录" required placeholder="/…/项目/第五期/questions" :disabled="busy" />
   <v-alert v-if="!project" type="info" density="compact">兼容目录流程：每个子文件夹是一个材料包，先完成入库和脱敏，再从同一脱敏版本创建多道独立题目。</v-alert>
   <p v-if="project?.material_mode==='material_packages'" class="text-xs text-muted">材料来源目录：每个子文件夹对应一个材料包；完成入库和脱敏后，可基于同一材料创建多道题目。</p>
   <v-alert v-else-if="project" type="info" density="compact">这是历史项目，继续保留现有题目和目录关系。新建项目统一使用“一份材料包 → 多道题目”的流程。</v-alert>
  </template>
  <p v-if="!project" class="text-xs text-muted">主项目规则资料和默认 Skill 路径由系统确定；本期 Skill 覆盖使用本期工作区的 skill/ 目录，不在此表单单独指定。</p>
 </template>
 <p v-else class="text-sm text-muted">标签属于当前期次，可在材料包创建题目时选择；修改标签不会改写已创建的题目。</p>
 <v-combobox v-model="questionTags" label="本期题目标签（选填）" multiple chips closable-chips clearable :disabled="busy" hint="输入标签后按回车确认；供本期材料包建题选择，修改不会改写已有题目。" persistent-hint />
 <v-textarea v-if="!tagsOnly" v-model="description" label="本期说明（可选）" maxlength="2000" rows="2" :disabled="busy" />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <Row x="end" :gap="8"><v-btn color="secondary" :disabled="busy" @click="emit('close')">取消</v-btn><v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy || (!tagsOnly&&(!parentName.trim()||(!project&&(!phaseName.trim()||!Number.isSafeInteger(Number(phaseNo))||Number(phaseNo)<1))||(!isGroupedPhase&&(materialBackend==='library_v1'?!workspacePath.trim():!materialRoot.trim()))))">{{ tagsOnly ? '保存标签' : project ? '保存本期配置' : '创建期次' }}</v-btn></Row>
</Column></v-form></template>
