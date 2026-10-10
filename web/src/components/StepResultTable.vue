<!--
职责：把结构化步骤结果递归转换成可读表格。
关键方法与用法：`nested()` 识别嵌套对象与数组，`display()` 翻译字段和值；项目步骤记录组件传入单个结果对象使用。
-->

<script setup lang="ts">
const props = defineProps<{ value: unknown }>();
const labels: Record<string, string> = {
 question: '题面', task_name: '题目名称', task_type: '题目类型', question_version: '题目版本', rubric_version: '评分标准版本',
 issues: '问题', code: '问题编号', location: '问题位置', skill_reference: '项目 skill 依据', reason: '不通过原因', suggested_change: '修改建议', detail: '问题摘要', blocking: '是否阻断', author_attempt_id: '对应出题记录',
 rubric: '评分标准', criterion: '得分条件', max_score: '满分', id: '编号', models: '模型结果', model_id: '模型 ID', name: '名称', status: '状态',
 answer: '答案', answer_status: '作答状态', score_status: '评分状态', score: '得分', valid: '是否有效', error: '失败原因', reasons: '原因', model_scores: '各模型得分', model: '模型', text: '正文', published_at: '发布时间',
 material_count: '附件数', page_count: '页数', decision: '判定', accepted: '是否达标', quarantined: '是否隔离', percentage: '百分制得分',
 validation: '入库说明', materials: '附件', original_name: '附件名称', minimum_score: '分数上限（百分制）', required_models: '要求模型',
 action: '处理方式', classification: '问题类别', target_ordinal: '回退步骤', workflow_count: '题目数', published: '是否发布',
 attachment_ids: '使用附件', answer_requirements: '作答要求', input_mode: '输入形式', output_mode: '输出形式', tools: '工具',
};
const rows = computed(() => Array.isArray(props.value)
 ? props.value.map((value, index) => ({ key: String(index + 1), label: String(index + 1), value }))
 : props.value && typeof props.value === 'object'
 ? Object.entries(props.value).map(([key, value]) => ({ key, label: labels[key] ?? key, value }))
 : []);
function nested(value: unknown) { return value !== null && typeof value === 'object'; }
function display(value: unknown) {
 if (value === null || value === undefined) return '—';
 if (typeof value === 'boolean') return value ? '是' : '否';
 const states: Record<string, string> = { waiting: '等待', queued: '排队中', running: '处理中', succeeded: '完成', failed: '失败', skipped: '跳过', accepted: '达标', repair: '需要返修', quarantine: '隔离' };
 return states[String(value)] ?? String(value);
}
</script>
<template>
 <v-table v-if="rows.length" density="compact" class="w-full">
  <thead><tr><th scope="col">项目</th><th scope="col">内容</th></tr></thead>
  <tbody><tr v-for="row in rows" :key="row.key">
   <th scope="row" class="min-w-120px align-top py-8">{{ row.label }}</th>
   <td class="whitespace-pre-wrap break-words py-8"><StepResultTable v-if="nested(row.value)" :value="row.value" /><span v-else>{{ display(row.value) }}</span></td>
  </tr></tbody>
 </v-table>
 <span v-else class="text-sm text-muted">{{ nested(value) ? '暂无记录' : display(value) }}</span>
</template>
