<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '@/api/client';
type Item = {
  id: string;
  type: string;
  owner: string | null;
  state: string;
  job_id: string | null;
  error: string | null;
};
type Detail = { id: string; state: string; total: number; counts: Record<string, number>; items: Item[] };
const labels: Record<string, string> = {
  active: '进行中',
  stopping: '正在停止',
  stopped: '已停止',
  incomplete: '有未完成项',
  pending: '待调度',
  ready: '可派发',
  waiting_dependency: '等上游',
  dispatching: '派发中',
  submitted: '已派发',
  pending_registration: '登记中',
  queued: '已排队',
  running: '执行中',
  result_pending_commit: '结果待提交',
  checking_receipt: '核对业务回执',
  delivering: '交付中',
  succeeded: '成功',
  failed: '失败',
  unknown: '待核实',
  blocked: '被上游阻塞',
  needs_review: '待核实',
  cancelled: '已取消',
  stale: '已失效',
  redact: '脱敏',
  prepare: '整理',
  author: '出题',
  deliver: '交付'
};
const label = (state: string) => labels[state] ?? state;
const rows = ref<{ id: string; state: string }[]>([]),
  detail = ref<Detail>(),
  error = ref(''),
  busy = ref(false),
  manifest = ref(''),
  preview = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(id = detail.value?.id) {
  rows.value = await api('/dispatch-batches');
  if (id) detail.value = await api('/dispatch-batches/' + id);
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取批次失败';
  } finally {
    busy.value = false;
  }
}
async function submit(start: boolean) {
  const data = await api<Detail & { counts: Record<string, number> }>(
    '/dispatch-batches' + (start ? '' : '/preview'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.parse(manifest.value))
    }
  );
  if (start) {
    detail.value = data;
    await refresh(data.id);
  } else preview.value = JSON.stringify(data.counts);
}
async function fileChanged(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (file) {
    manifest.value = await file.text();
    preview.value = '';
  }
}
async function stop() {
  if (detail.value) {
    await api('/dispatch-batches/' + detail.value.id + '/stop', { method: 'POST' });
    await refresh();
  }
}
onMounted(() => {
  void run(() => refresh());
  timer = setInterval(() => {
    if (detail.value && ['active', 'stopping'].includes(detail.value.state)) void run(() => refresh());
  }, 5000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <v-expansion-panels
    ><v-expansion-panel title="批次调度"
      ><v-expansion-panel-text>
        <Column :gap="12">
          <label>导入批次清单 <input type="file" accept=".json,application/json" @change="fileChanged" /></label>
          <v-textarea v-model="manifest" label="批次 JSON" rows="3" @update:model-value="preview = ''" />
          <Row :gap="8"
            ><v-btn :disabled="busy || !manifest" @click="run(() => submit(false))">核对范围</v-btn
            ><v-btn :disabled="busy || !manifest" @click="run(() => submit(true))">启动批次</v-btn
            ><v-btn :disabled="busy" @click="run(() => refresh())">刷新</v-btn></Row
          >
          <p v-if="preview">清单数量 {{ preview }}</p>
          <p v-if="error" class="text-error">{{ error }}</p>
          <v-select
            label="查看本机批次"
            :items="rows.map((r) => ({ title: r.id + ' · ' + label(r.state), value: r.id }))"
            :model-value="detail?.id"
            @update:model-value="(id) => run(() => refresh(id))"
          />
          <template v-if="detail"
            ><Row :gap="8"
              ><span>{{ label(detail.state) }} · 共 {{ detail.total }} 项</span
              ><v-btn v-if="detail.state === 'active'" :disabled="busy" @click="run(stop)">停止续派</v-btn></Row
            >
            <v-table
              ><thead>
                <tr>
                  <th>任务</th>
                  <th>步骤</th>
                  <th>人员</th>
                  <th>状态</th>
                  <th>业务任务 ID / 原因</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in detail.items" :key="r.id">
                  <td>{{ r.id }}</td>
                  <td>{{ label(r.type) }}</td>
                  <td>{{ r.owner }}</td>
                  <td>{{ label(r.state) }}</td>
                  <td>{{ r.error || r.job_id }}</td>
                </tr>
              </tbody></v-table
            >
          </template>
        </Column>
      </v-expansion-panel-text></v-expansion-panel
    ></v-expansion-panels
  >
</template>
