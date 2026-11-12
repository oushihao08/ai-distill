/**
 * 职责：第九期 agy 缺陷材料包（55包）重新脱敏与整理的自动化调度与对账脚本。
 * 核心调度策略（严格遵循用户指示与满载原则）：
 * 1. 每次轮巡先刷新所有在途任务状态（获取脱敏新 ID / 整理结果）；
 * 2. 检查 Agent lane 的实时容量（running + waiting 与 available）；
 * 3. 不仅将运行槽位打满，同时将排队等待（queued/waiting）也全部排满（持续派发直到 available === 0 或候选耗尽）；
 * 4. 优先派发已具备有效 redaction_id 的就绪整理（prepare），其次派发待脱敏（redact）；
 * 5. 发现超时失败自动携带 previous_job_id 续作；
 * 6. 持久化记录到 `reprocess_manifest_ledger.json`。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3700';
const PROJECT_ID = '68619f74-c864-49a0-bbe6-495202e62556'; // 豆包高经济价值 - 第九期
const MANIFEST_PATH = resolve('执行观察/phase9-materials-intake-20261110/agy-redact-prepare-manifest.md');
const LEDGER_PATH = resolve('执行观察/phase9-materials-intake-20261110/reprocess_manifest_ledger.json');

const REDACT_MODEL = 'gpt-5.6-sol';
const PREPARE_MODEL = 'gpt-6.1-sol';
const REASONING_EFFORT = 'medium';

export interface ReprocessItem {
  index: number;
  ledger_id: string;
  package_name: string;
  scope_type: string;
  loaded_in_phase9: boolean;
  workflow_id: string | null;
  package_id: string;
  revision_id: string;
  extraction_job_id: string;
  old_redaction_id: string;
  old_redact_job_id: string;
  old_prepare_job_id: string;
  redact: {
    status: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
    job_id: string | null;
    request_key: string | null;
    redaction_id: string | null;
    error: string | null;
    updated_at: string | null;
  };
  prepare: {
    status: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed';
    job_id: string | null;
    request_key: string | null;
    preparation_id: string | null;
    combinations: number | null;
    error: string | null;
    updated_at: string | null;
  };
  notes: string[];
}

export interface ReprocessLedger {
  version: 1;
  updated_at: string;
  total_packages: number;
  summary: {
    redact_pending: number;
    redact_active: number;
    redact_succeeded: number;
    redact_failed: number;
    redact_skipped: number;
    prepare_pending: number;
    prepare_active: number;
    prepare_succeeded: number;
    prepare_failed: number;
  };
  items: ReprocessItem[];
}

export function loadOrCreateLedger(): ReprocessLedger {
  if (existsSync(LEDGER_PATH)) {
    try {
      const data = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
      return data;
    } catch (e) {
      console.warn('读取现有账本失败，重新解析清单', e);
    }
  }

  const manifestContent = readFileSync(MANIFEST_PATH, 'utf8');
  const idx = manifestContent.lastIndexOf('```json');
  if (idx === -1) throw new Error('无法在清单文件中找到 JSON 块');
  const endIdx = manifestContent.indexOf('```', idx + 7);
  const jsonStr = manifestContent.slice(idx + 7, endIdx).trim();
  const rawItems = JSON.parse(jsonStr);

  const items: ReprocessItem[] = rawItems.map((raw: any) => {
    const isClassD = raw.scope_type.includes('仅整理为agy');
    return {
      index: raw.index,
      ledger_id: raw.ledger_id,
      package_name: raw.package_name,
      scope_type: raw.scope_type,
      loaded_in_phase9: !!raw.loaded_in_phase9,
      workflow_id: raw.workflow_id || null,
      package_id: raw.package_id,
      revision_id: raw.revision_id,
      extraction_job_id: raw.extraction_job_id,
      old_redaction_id: raw.old_redaction_id,
      old_redact_job_id: raw.old_redact_job_id,
      old_prepare_job_id: raw.old_prepare_job_id,
      redact: {
        status: isClassD ? 'skipped' : 'pending',
        job_id: null,
        request_key: null,
        redaction_id: isClassD ? raw.old_redaction_id : null,
        error: null,
        updated_at: null,
      },
      prepare: {
        status: 'pending',
        job_id: null,
        request_key: null,
        preparation_id: null,
        combinations: null,
        error: null,
        updated_at: null,
      },
      notes: [],
    };
  });

  const ledger: ReprocessLedger = {
    version: 1,
    updated_at: new Date().toISOString(),
    total_packages: items.length,
    summary: {
      redact_pending: items.filter(x => x.redact.status === 'pending').length,
      redact_active: 0,
      redact_succeeded: 0,
      redact_failed: 0,
      redact_skipped: items.filter(x => x.redact.status === 'skipped').length,
      prepare_pending: items.length,
      prepare_active: 0,
      prepare_succeeded: 0,
      prepare_failed: 0,
    },
    items,
  };

  saveLedger(ledger);
  return ledger;
}

export function saveLedger(ledger: ReprocessLedger) {
  ledger.updated_at = new Date().toISOString();
  ledger.summary = {
    redact_pending: ledger.items.filter(x => x.redact.status === 'pending').length,
    redact_active: ledger.items.filter(x => ['queued', 'running'].includes(x.redact.status)).length,
    redact_succeeded: ledger.items.filter(x => x.redact.status === 'succeeded').length,
    redact_failed: ledger.items.filter(x => x.redact.status === 'failed').length,
    redact_skipped: ledger.items.filter(x => x.redact.status === 'skipped').length,
    prepare_pending: ledger.items.filter(x => x.prepare.status === 'pending').length,
    prepare_active: ledger.items.filter(x => ['queued', 'running'].includes(x.prepare.status)).length,
    prepare_succeeded: ledger.items.filter(x => x.prepare.status === 'succeeded').length,
    prepare_failed: ledger.items.filter(x => x.prepare.status === 'failed').length,
  };
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf8');
}

// 获取 Agent lane 实时容量
export function getAgentQueueCapacity(): { limit: number; running: number; queued: number; waiting: number; available: number } {
  try {
    const proc = Bun.spawnSync(['bun', 'cli/index.ts', 'queue', 'show'], { stdout: 'pipe' });
    const output = proc.stdout.toString();
    const idx = output.indexOf('{');
    if (idx !== -1) {
      const parsed = JSON.parse(output.slice(idx));
      const agent = parsed.data?.capacity?.agent;
      if (agent) {
        return {
          limit: Number(agent.limit) || 14,
          running: Number(agent.running) || 0,
          queued: Number(agent.queued) || 0,
          waiting: Number(agent.waiting) || 0,
          available: Number(agent.available) || 0,
        };
      }
    }
  } catch (e: any) {
    console.warn('获取 queue show 失败，回退默认容量估算:', e.message);
  }
  return { limit: 14, running: 0, queued: 0, waiting: 0, available: 14 };
}

// 刷新单个任务状态
async function refreshJobStatus(item: ReprocessItem) {
  // 1. 刷新 redact
  if (item.redact.job_id && ['queued', 'running'].includes(item.redact.status)) {
    try {
      const res = await fetch(`${API_BASE}/api/material-library/jobs/${item.redact.job_id}`);
      if (res.ok) {
        const job = await res.json();
        if (job.status === 'succeeded') {
          item.redact.status = 'succeeded';
          item.redact.updated_at = new Date().toISOString();
          const revRes = await fetch(`${API_BASE}/api/material-library/packages/${item.package_id}/revisions`);
          if (revRes.ok) {
            const revData = await revRes.json();
            const targetRev = revData.items?.find((r: any) => r.id === item.revision_id);
            const redaction = targetRev?.redactions?.find((red: any) => red.redaction_job_id === item.redact.job_id);
            if (redaction?.id) {
              item.redact.redaction_id = redaction.id;
              item.notes.push(`[${new Date().toISOString()}] 脱敏成功，新 redaction_id: ${redaction.id}`);
            }
          }
        } else if (['failed', 'cancelled'].includes(job.status)) {
          item.redact.status = 'failed';
          item.redact.error = job.error_message || job.error_code || '脱敏失败';
          item.redact.updated_at = new Date().toISOString();
          item.notes.push(`[${new Date().toISOString()}] 脱敏失败: ${item.redact.error}`);
        } else {
          item.redact.status = job.status;
        }
      }
    } catch (e: any) {
      console.warn(`获取 job ${item.redact.job_id} 状态失败:`, e.message);
    }
  }

  // 2. 刷新 prepare
  if (item.prepare.job_id && ['queued', 'running'].includes(item.prepare.status)) {
    try {
      const res = await fetch(`${API_BASE}/api/material-library/jobs/${item.prepare.job_id}`);
      if (res.ok) {
        const job = await res.json();
        if (job.status === 'succeeded') {
          item.prepare.status = 'succeeded';
          item.prepare.preparation_id = job.id;
          item.prepare.combinations = job.result_summary?.combination_count ?? null;
          item.prepare.updated_at = new Date().toISOString();
          item.notes.push(`[${new Date().toISOString()}] 整理成功，组合数: ${item.prepare.combinations}`);
        } else if (['failed', 'cancelled'].includes(job.status)) {
          item.prepare.status = 'failed';
          item.prepare.error = job.error_message || job.error_code || '整理失败';
          item.prepare.updated_at = new Date().toISOString();
          item.notes.push(`[${new Date().toISOString()}] 整理失败: ${item.prepare.error}`);
        } else {
          item.prepare.status = job.status;
        }
      }
    } catch (e: any) {
      console.warn(`获取 job ${item.prepare.job_id} 状态失败:`, e.message);
    }
  }
}

// 派发脱敏
async function dispatchRedact(item: ReprocessItem) {
  const requestKey = randomUUID();
  const isResume = item.redact.status === 'failed' && item.redact.job_id;
  const payload: any = {
    kind: 'redact',
    execution_target: 'local',
    request_key: requestKey,
    project_id: PROJECT_ID,
    extraction_job_id: item.extraction_job_id,
    agent_settings: {
      model: REDACT_MODEL,
      reasoning_effort: REASONING_EFFORT,
    },
  };
  if (isResume) {
    payload.previous_job_id = item.redact.job_id;
  }

  const res = await fetch(`${API_BASE}/api/material-library/revisions/${item.revision_id}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    item.redact.error = `派发脱敏失败 (${res.status}): ${err}`;
    item.notes.push(`[${new Date().toISOString()}] 派发脱敏失败: ${err}`);
    return false;
  }

  const data = await res.json();
  item.redact.job_id = data.id;
  item.redact.request_key = requestKey;
  item.redact.status = 'queued';
  item.redact.error = null;
  item.redact.updated_at = new Date().toISOString();
  item.notes.push(`[${new Date().toISOString()}] 成功派发脱敏任务 job_id=${data.id}`);
  return true;
}

// 派发整理
async function dispatchPrepare(item: ReprocessItem) {
  const redactionId = item.redact.redaction_id || (item.scope_type.includes('仅整理为agy') ? item.old_redaction_id : null);
  if (!redactionId) {
    console.warn(`材料包 ${item.package_name} 缺少有效 redaction_id，无法派发整理`);
    return false;
  }

  const requestKey = randomUUID();
  const payload = {
    redaction_id: redactionId,
    request_key: requestKey,
    project_id: PROJECT_ID,
    agent_settings: {
      model: PREPARE_MODEL,
      reasoning_effort: REASONING_EFFORT,
    },
    force: true,
  };

  const res = await fetch(`${API_BASE}/api/material-library/revisions/${item.revision_id}/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    item.prepare.error = `派发整理失败 (${res.status}): ${err}`;
    item.notes.push(`[${new Date().toISOString()}] 派发整理失败: ${err}`);
    return false;
  }

  const data = await res.json();
  item.prepare.job_id = data.id;
  item.prepare.request_key = requestKey;
  item.prepare.status = 'queued';
  item.prepare.error = null;
  item.prepare.updated_at = new Date().toISOString();
  item.notes.push(`[${new Date().toISOString()}] 成功派发整理任务 job_id=${data.id}`);
  return true;
}

// 单轮执行闭环：满载 running + 排满 waiting
export async function runIteration() {
  const ledger = loadOrCreateLedger();
  console.log(`\n=== 检查轮次开始 [${new Date().toISOString()}] ===`);

  // 1. 刷新所有在途任务状态
  console.log('正在刷新活动任务状态...');
  for (const item of ledger.items) {
    await refreshJobStatus(item);
  }
  saveLedger(ledger);

  // 2. 获取实时队列容量
  let capacity = getAgentQueueCapacity();
  console.log(`实时队列容量: limit=${capacity.limit}, running=${capacity.running}, queued=${capacity.queued}, waiting=${capacity.waiting}, available=${capacity.available}`);

  let dispatchedCount = 0;

  // 3. 优先调度就绪的整理（prepare）任务（脱敏已就绪且整理待派发）
  for (const item of ledger.items) {
    if (capacity.available <= 0) break;

    const redactDone = item.redact.status === 'succeeded' || item.redact.status === 'skipped';
    const prepareNeedsRun = item.prepare.status === 'pending' || (item.prepare.status === 'failed' && !item.prepare.job_id);
    const hasRedactionId = item.redact.redaction_id || (item.scope_type.includes('仅整理为agy') ? item.old_redaction_id : null);

    if (redactDone && prepareNeedsRun && hasRedactionId) {
      console.log(`[整理入队] 派发整理: ${item.package_name} (#${item.index})`);
      const ok = await dispatchPrepare(item);
      if (ok) {
        capacity.available--;
        dispatchedCount++;
        saveLedger(ledger);
      }
    }
  }

  // 4. 其次调度待脱敏（redact）任务，持续将等待队列也排满
  for (const item of ledger.items) {
    if (capacity.available <= 0) break;

    const redactNeedsRun = item.redact.status === 'pending' || (item.redact.status === 'failed' && item.redact.error?.includes('timeout'));
    if (redactNeedsRun) {
      console.log(`[脱敏入队] 派发脱敏: ${item.package_name} (#${item.index})`);
      const ok = await dispatchRedact(item);
      if (ok) {
        capacity.available--;
        dispatchedCount++;
        saveLedger(ledger);
      }
    }
  }

  saveLedger(ledger);

  // 再次回读终态容量
  const endCap = getAgentQueueCapacity();
  console.log(`本轮新派发数量: ${dispatchedCount}`);
  console.log(`终态队列容量: limit=${endCap.limit}, running=${endCap.running}, queued=${endCap.queued}, waiting=${endCap.waiting}, available=${endCap.available}`);
  console.log('最新进度汇总:', JSON.stringify(ledger.summary, null, 2));
  console.log(`=== 检查轮次结束 ===\n`);

  return {
    ledger,
    dispatchedCount,
    endCap,
  };
}

if (import.meta.main) {
  runIteration()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('运行异常:', err);
      process.exit(1);
    });
}
