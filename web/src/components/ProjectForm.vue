<!--
职责：创建或编辑主项目、期数、本期题目来源目录和共享本地 skill 路径。
关键方法与用法：`submit()` 按是否收到 `project` 选择 POST 或 PATCH；成功时通过 `created` 事件返回项目，通过 `close` 事件关闭，由项目列表页托管。
-->

<script setup lang="ts">
import { api } from '../api/client';
import type { Project } from '../types/api';
const props = defineProps<{ project?: Project }>();
const emit = defineEmits<{ created: [project: Project]; close: [] }>();
const parentName = shallowRef(props.project?.parent_name ?? props.project?.name ?? '');
const phaseName = shallowRef(props.project?.phase_name ?? '');
const description = shallowRef(props.project?.description ?? '');
const materialRoot = shallowRef(props.project?.material_root ?? '');
const skillPath = shallowRef(props.project?.local_skill_path ?? '');
const busy = shallowRef(false); const error = shallowRef('');
async function submit() {
 if (busy.value) return;
 busy.value = true; error.value = '';
 try {
  const parent = parentName.value.trim(), phase = phaseName.value.trim();
  const name = phase ? `${parent} - ${phase}` : parent;
  const project = await api<Project>(props.project ? `/projects/${props.project.id}` : '/projects', {
   method: props.project ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ name,parent_name:parent,phase_name:phase,description:description.value,material_root:materialRoot.value,local_skill_path:skillPath.value || undefined }),
  });
  emit('created',project);
 } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败'; }
 finally { busy.value = false; }
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="submit"><Column :gap="16">
 <Row x="between"><h2 class="section-title">{{ project ? '编辑出题项目' : '新建出题项目' }}</h2><v-btn icon="$close" variant="text" aria-label="关闭" :disabled="busy" @click="emit('close')" /></Row>
 <v-text-field v-model="parentName" label="主项目名称" required maxlength="120" :disabled="busy" />
 <v-text-field v-model="phaseName" label="期数（新建时必填）" :required="!project" maxlength="120" :disabled="busy" />
 <v-text-field v-model="materialRoot" label="本期题目来源目录" required placeholder="/…/项目/第五期/questions" :disabled="busy" />
 <p class="text-xs text-muted">目录结构：项目 / 期数 / questions / 题目文件夹 / 附件。每个题目子目录对应一条工作流。</p>
 <v-text-field v-model="skillPath" label="主项目 skill 目录（可选）" placeholder="留空复用同名主项目的 skill" :disabled="busy" />
 <p class="text-xs text-muted">同一主项目下的期次共用此目录；首次创建时按项目/期数/questions 路径推导项目级 skill 目录。</p>
 <v-textarea v-model="description" label="项目说明（可选）" maxlength="2000" rows="2" :disabled="busy" />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <Row x="end" :gap="8"><v-btn color="secondary" :disabled="busy" @click="emit('close')">取消</v-btn><v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy || !parentName.trim() || (!project && !phaseName.trim()) || !materialRoot.trim()">{{ project ? '保存修改' : '创建期次' }}</v-btn></Row>
</Column></v-form></template>
