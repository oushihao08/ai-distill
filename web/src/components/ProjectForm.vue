<script setup lang="ts">
import { api } from '../api/client';
import type { Project } from '../types/api';
const props = defineProps<{ project?: Project }>();
const emit = defineEmits<{ created: [project: Project]; close: [] }>();
const name = shallowRef(props.project?.name ?? '');
const description = shallowRef(props.project?.description ?? '');
const materialRoot = shallowRef(props.project?.material_root ?? '');
const skillPath = shallowRef(props.project?.local_skill_path ?? '');
const busy = shallowRef(false); const error = shallowRef('');
async function submit() {
 if (busy.value) return;
 busy.value = true; error.value = '';
 try {
  const project = await api<Project>(props.project ? `/projects/${props.project.id}` : '/projects', {
   method: props.project ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ name:name.value,description:description.value,material_root:materialRoot.value,local_skill_path:skillPath.value || undefined }),
  });
  emit('created',project);
 } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败'; }
 finally { busy.value = false; }
}
</script>
<template><v-form class="surface-card p-20" @submit.prevent="submit"><Column :gap="16">
 <Row x="between"><h2 class="section-title">{{ project ? '编辑出题项目' : '新建出题项目' }}</h2><v-btn icon="$close" variant="text" aria-label="关闭" :disabled="busy" @click="emit('close')" /></Row>
 <v-text-field v-model="name" label="项目名称" required maxlength="120" :disabled="busy" />
 <v-text-field v-model="materialRoot" label="材料文件夹绝对路径" required placeholder="/Users/jack/…/出题项目" :disabled="busy" />
 <p class="text-xs text-muted">目录结构：项目文件夹 / 题目 1 / 附件.pdf。每个题目子目录对应一条记录；创建后执行第一步接收材料。</p>
 <v-text-field v-model="skillPath" label="本地 skill 目录（可选）" placeholder="留空自动创建项目独立目录" :disabled="busy" />
 <p class="text-xs text-muted">现有 skill 填写包含 SKILL.md 的目录；留空仅建立目录，后续规则生成步骤再生成 skill。</p>
 <v-textarea v-model="description" label="项目说明（可选）" maxlength="2000" rows="2" :disabled="busy" />
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <Row x="end" :gap="8"><v-btn color="secondary" :disabled="busy" @click="emit('close')">取消</v-btn><v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="busy || !name.trim() || !materialRoot.trim()">{{ project ? '保存修改' : '创建项目' }}</v-btn></Row>
</Column></v-form></template>
