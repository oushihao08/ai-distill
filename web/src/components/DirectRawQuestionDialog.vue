<!-- 职责：从本机原件文件夹（或多份原件文件）免云端提取、免脱敏直接创建题目快照，并支持一键排队出题。
入口：modelValue 控制弹窗；created 事件返回新创建的工作流 ID 与是否已派发出题。 -->
<script setup lang="ts">
import { api } from '../api/client';
import { readDirectRawFolderSelection } from '../utils/material-folder';

const props = defineProps<{
  modelValue: boolean;
  projectId: string;
  questionTags: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  created: [payload: { id: string; autoAuthored: boolean; title: string }];
}>();

const folderInput = shallowRef<HTMLInputElement>();
const filesInput = shallowRef<HTMLInputElement>();
const files = shallowRef<File[]>([]);
const folderName = shallowRef('');
const ignoredCount = shallowRef(0);
const busy = shallowRef(false);
const error = shallowRef('');
const requestKey = shallowRef('');
const autoAuthor = shallowRef(true);

const form = reactive({
  title: '',
  scenario: '',
  role_perspective: '',
  authoring_direction: '',
  target_level: '' as '' | 'L2' | 'L3' | 'L4' | 'L5',
  question_tags: [] as string[],
});

const totalSizeLabel = computed(() => {
  const bytes = files.value.reduce((acc, f) => acc + f.size, 0);
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
});

function levelFromName(name: string): '' | 'L2' | 'L3' | 'L4' | 'L5' {
  const level = /(?:^|[-_\s])(L[2-5])(?=$|[-_\s])/i.exec(name)?.[1]?.toUpperCase();
  return level === 'L2' || level === 'L3' || level === 'L4' || level === 'L5' ? level : '';
}

const lockedLevel = computed(() => levelFromName(form.title || folderName.value));

function applySelection(incoming: File[]) {
  error.value = '';
  files.value = [];
  folderName.value = '';
  ignoredCount.value = 0;
  try {
    const sel = readDirectRawFolderSelection(incoming);
    files.value = sel.files;
    folderName.value = sel.folderName;
    ignoredCount.value = sel.ignoredCount;
    if (!form.title.trim() && sel.suggestedTitle) {
      form.title = sel.suggestedTitle;
    }
    const detectedLevel = levelFromName(form.title || sel.folderName);
    if (detectedLevel) form.target_level = detectedLevel;
    requestKey.value = crypto.randomUUID();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取所选原件文件';
  }
}

function onSelectFolder(event: Event) {
  applySelection(Array.from((event.target as HTMLInputElement).files ?? []));
}

function onSelectFiles(event: Event) {
  applySelection(Array.from((event.target as HTMLInputElement).files ?? []));
}

function resetState() {
  files.value = [];
  folderName.value = '';
  ignoredCount.value = 0;
  error.value = '';
  requestKey.value = crypto.randomUUID();
  autoAuthor.value = true;
  form.title = '';
  form.scenario = '';
  form.role_perspective = '';
  form.authoring_direction = '';
  form.target_level = '';
  form.question_tags = [];
  if (folderInput.value) folderInput.value.value = '';
  if (filesInput.value) filesInput.value.value = '';
}

function close() {
  if (busy.value) return;
  emit('update:modelValue', false);
}

async function submit() {
  const cleanTitle = form.title.trim();
  if (busy.value || !files.value.length || !cleanTitle) return;
  busy.value = true;
  error.value = '';
  try {
    const body = new FormData();
    body.set('request_key', requestKey.value || crypto.randomUUID());
    body.set('title', cleanTitle);
    body.set('package_name', cleanTitle);
    if (form.scenario.trim()) body.set('scenario', form.scenario.trim());
    if (form.role_perspective.trim()) body.set('role_perspective', form.role_perspective.trim());
    if (form.authoring_direction.trim()) body.set('authoring_direction', form.authoring_direction.trim());
    const finalLevel = lockedLevel.value || form.target_level;
    if (finalLevel) body.set('target_level', finalLevel);
    if (form.question_tags.length) body.set('question_tags', JSON.stringify(form.question_tags));
    body.set('auto_author', autoAuthor.value ? 'true' : 'false');
    for (const f of files.value) {
      body.append('files', f, f.name);
    }
    const res = await api<{ id: string; author_attempt_id?: string }>(`/projects/${props.projectId}/direct-raw-questions`, {
      method: 'POST',
      body,
    });
    emit('created', { id: res.id, autoAuthored: Boolean(res.author_attempt_id), title: cleanTitle });
    emit('update:modelValue', false);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '原件包建题失败，请重试';
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetState();
  },
);
</script>

<template>
  <v-dialog :model-value="modelValue" :persistent="busy" max-width="760" scrollable @update:model-value="v => { if (!v) close(); }">
    <v-form class="surface-card p-20 max-h-[88vh] overflow-y-auto" @submit.prevent="submit">
      <Column :gap="14">
        <Row x="between" y="center" :gap="8">
          <Column :gap="4">
            <h2 class="section-title">原件包直接建题出题（免提取 / 免脱敏）</h2>
            <p class="text-xs text-muted">
              适用于生信、数科、工程等无需脱敏的多文件数据包（支持 XLSX、CSV、TSV、PDF、DOCX、JSON、Parquet、FASTA、PDB、STEP 等）。系统本地秒级生成全包文件与表头导览，并将原生文件逐字节直通挂载给出题与标定沙盒。
            </p>
          </Column>
          <v-btn icon="$close" variant="text" aria-label="关闭" :disabled="busy" @click="close" />
        </Row>

        <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" :disabled="busy" @change="onSelectFolder" />
        <input ref="filesInput" type="file" multiple class="hidden" :disabled="busy" @change="onSelectFiles" />

        <Row wrap :gap="8" y="center">
          <v-btn variant="outlined" color="primary" :disabled="busy" @click="folderInput?.click()">选择原件文件夹（如 input 目录）</v-btn>
          <v-btn variant="text" :disabled="busy" @click="filesInput?.click()">或选择多份原件文件</v-btn>
          <span v-if="files.length" class="text-xs text-muted">已选 {{ files.length }} 份原件 · 共 {{ totalSizeLabel }}</span>
        </Row>

        <Column v-if="files.length" class="surface-panel p-12 max-h-180 overflow-y-auto" :gap="4">
          <Row v-for="file in files" :key="file.name" x="between" y="center" :gap="8">
            <span class="text-sm break-all">{{ file.name }}</span>
            <span class="text-xs text-muted whitespace-nowrap">{{ (file.size / 1024).toFixed(1) }} KB</span>
          </Row>
        </Column>
        <p v-if="ignoredCount" class="text-xs text-muted">已自动忽略 {{ ignoredCount }} 个隐藏或非支持格式文件。</p>

        <v-text-field v-model="form.title" label="题目 / 材料包名称" placeholder="例如：B 细胞磷酸化流式标志物检出复核与面板补正" required maxlength="180" />
        <Row stack-on-mobile :gap="12">
          <v-text-field v-model="form.scenario" label="出题场景（选填）" placeholder="如 life_science / cytometry_immunophenotyping" />
          <v-text-field v-model="form.role_perspective" label="角色 / 委托岗位（选填）" placeholder="如 转化医学部生物信息分析岗" />
        </Row>
        <v-textarea v-model="form.authoring_direction" label="出题方向说明（选填）" placeholder="填写希望重点考察的业务链条或留空由 Skill 自主规划" rows="2" auto-grow />
        <Row stack-on-mobile :gap="12">
          <v-select v-model="form.target_level" :items="['L2', 'L3', 'L4', 'L5']" label="难度等级（选填）" clearable :disabled="Boolean(lockedLevel)" />
          <v-select v-model="form.question_tags" :items="questionTags" label="题目标签" multiple chips clearable />
        </Row>

        <v-switch v-model="autoAuthor" label="建题完成后立即加入出题队列" color="primary" :disabled="busy" hide-details />

        <v-alert v-if="error" type="error" density="compact" role="alert">{{ error }}</v-alert>

        <Row x="end" :gap="8">
          <v-btn :disabled="busy" @click="close">取消</v-btn>
          <v-btn type="submit" color="primary" :loading="busy" :disabled="busy || !files.length || !form.title.trim()">
            {{ autoAuthor ? '建题并立即出题' : '仅创建题目' }}
          </v-btn>
        </Row>
      </Column>
    </v-form>
  </v-dialog>
</template>
