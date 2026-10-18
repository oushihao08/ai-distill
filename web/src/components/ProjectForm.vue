<!--
职责：新建独立材料库项目并指定规则工作区；编辑已有项目时保留其材料后端、目录关系、标签和共享 skill 路径。
关键方法与用法：`submit()` 按是否收到 `project` 选择 POST 或 PATCH；`tagsOnly` 供项目详情只显示标签管理；成功时通过 `created` 事件返回项目，通过 `close` 事件关闭。
-->

<script setup lang="ts">
import { api } from '../api/client';
import type { Project } from '../types/api';
const props = defineProps<{ project?: Project; tagsOnly?: boolean }>();
const emit = defineEmits<{ created: [project: Project]; close: [] }>();
const parentName = shallowRef(props.project?.parent_name ?? props.project?.name ?? '');
const phaseName = shallowRef(props.project?.phase_name ?? '');
const description = shallowRef(props.project?.description ?? '');
const materialRoot = shallowRef(props.project?.material_root ?? '');
const materialBackend = shallowRef<Project['material_backend']>(props.project ? props.project.material_backend ?? 'legacy' : 'library_v1');
const workspacePath = shallowRef(props.project?.workspace_path ?? '');
const skillPath = shallowRef(props.project?.local_skill_path ?? '');
const questionTags = shallowRef<string[]>([...(props.project?.question_tags??[])]);
const busy = shallowRef(false); const error = shallowRef('');
async function submit() {
 if (busy.value) return;
 busy.value = true; error.value = '';
 try {
  const parent = parentName.value.trim(), phase = phaseName.value.trim();
  const name = phase ? `${parent} - ${phase}` : parent;
  const project = await api<Project>(props.project ? `/projects/${props.project.id}` : '/projects', {
   method: props.project ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ name,parent_name:parent,phase_name:phase,description:description.value,...(materialBackend.value==='library_v1'?{material_backend:'library_v1',workspace_path:workspacePath.value}:{material_root:materialRoot.value,material_backend:materialBackend.value}),local_skill_path:skillPath.value || undefined,question_tags:questionTags.value,...(!props.project?{material_mode:'material_packages'}:{}) }),
  });
  emit('created',project);
 } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败'; }
 finally { busy.value = false; }
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="submit"><Column :gap="16">
 <Row x="between"><h2 class="section-title">{{ tagsOnly ? '管理出题标签' : project ? '编辑出题项目' : '新建出题项目' }}</h2><v-btn icon="$close" variant="text" aria-label="关闭" :disabled="busy" @click="emit('close')" /></Row>
 <template v-if="!tagsOnly">
  <v-text-field v-model="parentName" label="主项目名称" required maxlength="120" :disabled="busy" />
  <v-text-field v-model="phaseName" label="期数（新建时必填）" :required="!project" maxlength="120" :disabled="busy" />
  <p v-if="!project" class="text-sm text-muted">材料来源：独立共享材料库。创建项目后，选择已完成脱敏的材料包加载使用。</p>
  <template v-if="materialBackend==='library_v1'">
   <v-text-field v-model="workspacePath" label="项目规则工作区" required placeholder="/…/项目/本期" :readonly="!!project" :disabled="busy" />
   <v-alert type="info" density="compact">案件材料在独立材料库处理；此路径只用于读取本项目规则和 skill。同一材料包可以加载到多个项目。</v-alert>
  </template>
  <template v-else>
   <v-text-field v-model="materialRoot" label="本期材料来源目录" required placeholder="/…/项目/第五期/questions" :disabled="busy" />
   <v-alert v-if="!project" type="info" density="compact">兼容目录流程：每个子文件夹是一个材料包，先完成入库和脱敏，再从同一脱敏版本创建多道独立题目。</v-alert>
   <p v-if="project?.material_mode==='material_packages'" class="text-xs text-muted">材料来源目录：每个子文件夹对应一个材料包；完成入库和脱敏后，可基于同一材料创建多道题目。</p>
   <v-alert v-else-if="project" type="info" density="compact">这是历史项目，继续保留现有题目和目录关系。新建项目统一使用“一份材料包 → 多道题目”的流程。</v-alert>
  </template>
  <v-text-field v-model="skillPath" label="主项目 skill 目录（可选）" placeholder="留空复用同名主项目的 skill" :disabled="busy" />
  <p class="text-xs text-muted">同一主项目下的期次共用此目录；首次创建时默认使用项目规则工作区下的 skill 目录。</p>
 </template>
 <p v-else class="text-sm text-muted">标签属于当前项目，可在材料包创建题目时选择；修改标签不会改写已创建的题目。</p>
 <v-combobox v-model="questionTags" label="本项目出题标签（选填）" multiple chips closable-chips clearable :disabled="busy" hint="输入标签后按回车确认；供本项目材料包建题选择，修改不会改写已有题目。" persistent-hint />
 <v-textarea v-if="!tagsOnly" v-model="description" label="项目说明（可选）" maxlength="2000" rows="2" :disabled="busy" />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <Row x="end" :gap="8"><v-btn color="secondary" :disabled="busy" @click="emit('close')">取消</v-btn><v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy || !parentName.trim() || (!project && !phaseName.trim()) || (materialBackend==='library_v1'?!workspacePath.trim():!materialRoot.trim())">{{ tagsOnly ? '保存标签' : project ? '保存修改' : '创建期次' }}</v-btn></Row>
</Column></v-form></template>
