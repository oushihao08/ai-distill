/**
 * 职责：高经第九期出题自动补位与调度脚本（参数化 CLI 驱动、模型与推理强度，显式传参不读数据库模型默认）。
 * 核心闭环：
 * 1. 读取 /api/system/execution-queue 获取本机 Agent 槽位实时容量；
 * 2. 检查已加载但尚未建题的材料包、已建题但尚未派发出题的工作流，优先补齐闭环；
 * 3. 筛选已完成提取+脱敏+整理（material-preparation-v2）且未在本主项目占用的第九期材料包，依次：
 *    加载到期次 -> 创建唯一题目工作流 -> 显式携带 provider/model/reasoning_effort 派发出题；
 * 4. 持续补位直到 Agent 可用槽位耗尽（或达到 --limit / 合法候选耗尽），结束前回读队列验收并写入对账记录。
 *
 * 入口示例：
 *   bun scripts/runtime/phase9-authoring-dispatch.ts --provider agy --model agy:gemini-4-carbon --effort medium
 *   bun scripts/runtime/phase9-authoring-dispatch.ts --provider codex --model gpt-6.1-sol --effort medium
 *   bun scripts/runtime/phase9-authoring-dispatch.ts --provider agy --model agy:gemini-4-carbon --effort medium --dry-run
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../server/db';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3700';
const DEFAULT_PROJECT_ID = '68619f74-c864-49a0-bbe6-495202e62556'; // 豆包高经济价值 - 第九期
const LEDGER_PATH = resolve(process.cwd(), '执行观察/phase9-materials-intake-20261110/authoring_dispatch_ledger.json');

interface CliOptions {
  projectId: string;
  provider: 'codex' | 'agy';
  model: string;
  reasoningEffort: string;
  limit?: number;
  dryRun: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    }
  }

  const rawProvider = (flags.get('provider') || process.env.AUTHORING_PROVIDER || 'agy').trim().toLowerCase();
  const provider = rawProvider === 'antigravity' ? 'agy' : rawProvider;
  if (provider !== 'codex' && provider !== 'agy') {
    throw new Error(`--provider 仅支持 codex 或 agy (antigravity)，当前收到: ${rawProvider}`);
  }

  const defaultModel = provider === 'agy' ? 'agy:gemini-4-carbon' : 'gpt-6.1-sol';
  const model = (flags.get('model') || process.env.AUTHORING_MODEL || defaultModel).trim();
  const reasoningEffort = (flags.get('effort') || flags.get('reasoning-effort') || process.env.AUTHORING_EFFORT || 'medium').trim().toLowerCase();
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) {
    throw new Error(`--effort 无效: ${reasoningEffort}`);
  }

  const limitStr = flags.get('limit');
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`--limit 须为非负整数: ${limitStr}`);
  }

  return {
    projectId: (flags.get('project') || process.env.AUTHORING_PROJECT_ID || DEFAULT_PROJECT_ID).trim(),
    provider,
    model,
    reasoningEffort,
    ...(limit !== undefined ? { limit } : {}),
    dryRun,
  };
}

async function apiJson<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`${method} ${path} 失败 (${res.status}): ${msg}`), { status: res.status, payload: parsed });
  }
  return parsed as T;
}

async function readAgentQueueCapacity() {
  const q = await apiJson<any>('/api/system/execution-queue');
  const agent = q.capacity?.agent;
  if (!agent) throw new Error('无法读取本机 execution-queue agent 容量');
  const activeAuthoringItems = (Array.isArray(q.items) ? q.items : []).filter(
    (item: any) => item.lane === 'agent' && item.route === 'authoring' && ['queued', 'running'].includes(item.state)
  );
  return {
    limit: Number(agent.limit ?? 0),
    running: Number(agent.running ?? 0),
    queued: Number(agent.queued ?? 0),
    reserved: Number(agent.reserved ?? 0),
    waiting: Number(agent.waiting ?? 0),
    available: Number(agent.available ?? 0),
    activeAuthoringCount: activeAuthoringItems.length,
  };
}

interface AuthoringLedgerRecord {
  package_id: string;
  package_name: string;
  revision_id: string;
  redaction_id: string;
  preparation_id?: string;
  link_id?: string;
  question_request_key?: string;
  workflow_id?: string;
  attempt_id?: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  status: string;
  updated_at: string;
  error?: string;
}

async function loadLedger(): Promise<{ updated_at: string; items: Record<string, AuthoringLedgerRecord> }> {
  try {
    const content = await readFile(LEDGER_PATH, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.items) return parsed;
  } catch {}
  return { updated_at: new Date().toISOString(), items: {} };
}

async function saveLedger(ledger: { updated_at: string; items: Record<string, AuthoringLedgerRecord> }) {
  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  ledger.updated_at = new Date().toISOString();
  await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf8');
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  console.log(
    `[AuthoringDispatch] 启动出题补位 | project=${opts.projectId} | provider=${opts.provider} | model=${opts.model} | effort=${opts.reasoningEffort}${opts.dryRun ? ' | DRY-RUN' : ''}`
  );

  const initialCap = await readAgentQueueCapacity();
  console.log(
    `[Queue-Start] Agent 槽位: limit=${initialCap.limit}, running=${initialCap.running}, queued=${initialCap.queued}, available=${initialCap.available} (活动出题=${initialCap.activeAuthoringCount})`
  );

  const ledger = await loadLedger();
  const pool = createPool();

  try {
    // 1. 查询本期已加载材料包、已建工作流及各题出题状态
    const [loadedData, projectData, readyPackagesRes, wfStepRes] = await Promise.all([
      apiJson<{ items: any[] }>(`/api/projects/${opts.projectId}/loaded-materials`),
      apiJson<{ project: any; workflows: any[] }>(`/api/projects/${opts.projectId}`),
      pool.query(
        `
        SELECT
          p.id AS package_id,
          p.name AS package_name,
          p.current_revision_id AS revision_id,
          prep.id AS preparation_id,
          prep.redaction_id AS redaction_id,
          EXISTS (
            SELECT 1 FROM ai_distill.project_material_uses mu
            JOIN ai_distill.projects proj ON proj.project_group_id = mu.project_group_id
            WHERE proj.id = $1
              AND mu.package_id = p.id
          ) AS used_in_group
        FROM ai_distill.library_packages p
        JOIN LATERAL (
          SELECT mp.id, mp.redaction_id
          FROM ai_distill.library_preparations mp
          JOIN ai_distill.library_redactions rd ON rd.id = mp.redaction_id
          WHERE mp.package_id = p.id
            AND mp.revision_id = p.current_revision_id
            AND mp.redaction_id IS NOT NULL
            AND mp.result->>'format' = 'material-preparation-v2'
          ORDER BY mp.created_at DESC
          LIMIT 1
        ) prep ON TRUE
        WHERE p.deleted_at IS NULL
          AND (p.name LIKE '豆包高经济第九期-%' OR p.name LIKE '高经九期-%')
        ORDER BY p.created_at ASC, p.id ASC
        `,
        [opts.projectId]
      ),
      pool.query(
        `
        SELECT
          w.id AS workflow_id,
          w.title,
          qls.package_id,
          qls.project_material_id AS link_id,
          qls.revision_id,
          qls.redaction_id,
          s.status AS step4_status,
          EXISTS (
            SELECT 1 FROM ai_distill.step_attempts a
            WHERE a.workflow_id = w.id AND a.ordinal = 4 AND a.status IN ('waiting', 'running')
          ) AS has_active_attempt,
          (
            SELECT a.id FROM ai_distill.step_attempts a
            WHERE a.workflow_id = w.id AND a.ordinal = 4
            ORDER BY a.attempt DESC LIMIT 1
          ) AS latest_attempt_id
        FROM ai_distill.workflows w
        LEFT JOIN ai_distill.question_library_sources qls ON qls.workflow_id = w.id
        LEFT JOIN ai_distill.steps s ON s.workflow_id = w.id AND s.ordinal = 4
        WHERE w.project_id = $1 AND w.deleted_at IS NULL
        ORDER BY w.created_at ASC, w.id ASC
        `,
        [opts.projectId]
      ),
    ]);

    const loadedByPkg = new Map<string, any>();
    for (const item of loadedData.items || []) {
      if (!item.removed_at) loadedByPkg.set(item.package_id, item);
    }

    const wfByPkg = new Map<string, any>();
    const pendingAuthorWorkflows: any[] = [];
    let succeededWorkflows = 0;
    let activeWorkflows = 0;
    let failedWorkflows = 0;

    for (const wf of wfStepRes.rows) {
      if (wf.package_id) wfByPkg.set(wf.package_id, wf);
      if (wf.has_active_attempt || wf.step4_status === 'running') {
        activeWorkflows++;
      } else if (wf.step4_status === 'succeeded') {
        succeededWorkflows++;
      } else if (wf.step4_status === 'failed') {
        failedWorkflows++;
      } else if (wf.step4_status === 'waiting' && !wf.latest_attempt_id) {
        // 已建题但尚未派发过任何出题尝试的工作流
        pendingAuthorWorkflows.push(wf);
      }
    }

    // 已加载到期次但尚未建题的材料包
    const loadedWithoutQuestion: any[] = [];
    for (const [pkgId, link] of loadedByPkg.entries()) {
      if (!wfByPkg.has(pkgId) && link.selected_redaction_id) {
        loadedWithoutQuestion.push(link);
      }
    }

    // 已整理完成、未加载且未在同主项目占用的新材料包候选
    const newReadyCandidates = readyPackagesRes.rows.filter(
      (row: any) => !loadedByPkg.has(row.package_id) && !wfByPkg.has(row.package_id) && !row.used_in_group
    );

    console.log(
      `[Inventory] 已完成出题=${succeededWorkflows} | 运行/排队中=${activeWorkflows} | 历史失败(隔离不自动重跑)=${failedWorkflows} | 已建题待首派=${pendingAuthorWorkflows.length} | 已加载待建题=${loadedWithoutQuestion.length} | 新就绪待加载包=${newReadyCandidates.length}`
    );

    if (opts.dryRun) {
      console.log(`[DryRun] 预览完成，未执行任何写入或派发。`);
      return;
    }

    // 目标：Agent 满载 14 个 running + 额外 6 个 queued，总在途任务保持 20 个
    const targetInFlight = 20;
    const currentInFlight = initialCap.running + initialCap.queued;
    let budget = opts.limit !== undefined ? opts.limit : Math.max(0, targetInFlight - currentInFlight);
    console.log(`[Target-Capacity] 目标在途=${targetInFlight} (14运行+6排队) | 当前在途=${currentInFlight} (运行=${initialCap.running}, 排队=${initialCap.queued}) | 本轮计划补位=${budget}`);
    let dispatchedCount = 0;
    let loadedCount = 0;
    let createdQuestionCount = 0;

    const authoringPayload = {
      provider: opts.provider,
      model: opts.model,
      reasoning_effort: opts.reasoningEffort,
    };

    // 阶段 A：优先派发已建题但尚未派发出题的工作流
    for (const wf of pendingAuthorWorkflows) {
      if (budget <= 0) break;
      try {
        const res = await apiJson<{ id: string; reused?: boolean }>(`/api/workflows/${wf.workflow_id}/author`, 'POST', authoringPayload);
        dispatchedCount++;
        budget--;
        if (wf.package_id) {
          ledger.items[wf.package_id] = {
            ...(ledger.items[wf.package_id] ?? {}),
            package_id: wf.package_id,
            package_name: wf.title,
            revision_id: wf.revision_id ?? '',
            redaction_id: wf.redaction_id ?? '',
            link_id: wf.link_id,
            workflow_id: wf.workflow_id,
            attempt_id: res.id,
            provider: opts.provider,
            model: opts.model,
            reasoning_effort: opts.reasoningEffort,
            status: 'queued',
            updated_at: new Date().toISOString(),
          };
          await saveLedger(ledger);
        }
        console.log(`  [Dispatch-Existing] ${wf.title} -> workflow=${wf.workflow_id}, attempt=${res.id}`);
      } catch (err: any) {
        console.error(`  [Error-Existing] ${wf.title} 派发失败: ${err.message}`);
        if (err.status === 429 || err.status === 503 || String(err.message).includes('容量')) break;
      }
    }

    // 阶段 B：补齐已加载但未建题的材料包并立即派发出题
    for (const link of loadedWithoutQuestion) {
      if (budget <= 0) break;
      const reqKey = ledger.items[link.package_id]?.question_request_key || randomUUID();
      try {
        const qRes = await apiJson<{ id: string }>(`/api/projects/${opts.projectId}/loaded-materials/${link.id}/questions`, 'POST', {
          request_key: reqKey,
          redaction_id: link.selected_redaction_id,
          expected_link_version: Number(link.lock_version),
          title: link.package_name,
          question_tags: [],
        });
        createdQuestionCount++;
        const aRes = await apiJson<{ id: string }>(`/api/workflows/${qRes.id}/author`, 'POST', authoringPayload);
        dispatchedCount++;
        budget--;
        ledger.items[link.package_id] = {
          package_id: link.package_id,
          package_name: link.package_name,
          revision_id: link.selected_revision_id,
          redaction_id: link.selected_redaction_id,
          link_id: link.id,
          question_request_key: reqKey,
          workflow_id: qRes.id,
          attempt_id: aRes.id,
          provider: opts.provider,
          model: opts.model,
          reasoning_effort: opts.reasoningEffort,
          status: 'queued',
          updated_at: new Date().toISOString(),
        };
        await saveLedger(ledger);
        console.log(`  [Create+Dispatch] ${link.package_name} -> workflow=${qRes.id}, attempt=${aRes.id}`);
      } catch (err: any) {
        console.error(`  [Error-Loaded] ${link.package_name} 建题/派发失败: ${err.message}`);
        if (err.status === 429 || err.status === 503 || String(err.message).includes('容量')) break;
      }
    }

    // 阶段 C：对新就绪材料包执行 加载 -> 建题 -> 派发出题 完整闭环，持续补位直到槽位打满
    for (const cand of newReadyCandidates) {
      if (budget <= 0) break;
      const reqKey = randomUUID();
      try {
        const loadRes = await apiJson<any>(`/api/projects/${opts.projectId}/loaded-materials`, 'POST', {
          package_id: cand.package_id,
          redaction_id: cand.redaction_id,
        });
        const linkItem = loadRes.item ?? loadRes;
        const linkId = linkItem.id;
        const lockVersion = Number(linkItem.lock_version ?? 1);
        loadedCount++;

        const qRes = await apiJson<{ id: string }>(`/api/projects/${opts.projectId}/loaded-materials/${linkId}/questions`, 'POST', {
          request_key: reqKey,
          redaction_id: cand.redaction_id,
          expected_link_version: lockVersion,
          title: cand.package_name,
          question_tags: [],
        });
        createdQuestionCount++;

        const aRes = await apiJson<{ id: string }>(`/api/workflows/${qRes.id}/author`, 'POST', authoringPayload);
        dispatchedCount++;
        budget--;

        ledger.items[cand.package_id] = {
          package_id: cand.package_id,
          package_name: cand.package_name,
          revision_id: cand.revision_id,
          redaction_id: cand.redaction_id,
          preparation_id: cand.preparation_id,
          link_id: linkId,
          question_request_key: reqKey,
          workflow_id: qRes.id,
          attempt_id: aRes.id,
          provider: opts.provider,
          model: opts.model,
          reasoning_effort: opts.reasoningEffort,
          status: 'queued',
          updated_at: new Date().toISOString(),
        };
        await saveLedger(ledger);
        console.log(
          `  [Load+Create+Dispatch] ${cand.package_name} -> link=${linkId}, workflow=${qRes.id}, attempt=${aRes.id} (${opts.provider}:${opts.model}@${opts.reasoningEffort})`
        );

        loadedByPkg.set(cand.package_id, linkItem);
        wfByPkg.set(cand.package_id, { workflow_id: qRes.id, title: cand.package_name });

        // 实时重算在途任务数，严格保持 14 运行 + 6 排队（总在途 20）
        const liveCap = await readAgentQueueCapacity();
        const liveInFlight = liveCap.running + liveCap.queued;
        if (opts.limit === undefined) {
          budget = Math.max(0, targetInFlight - liveInFlight);
        } else {
          budget = Math.min(budget, Math.max(0, targetInFlight - liveInFlight));
        }
      } catch (err: any) {
        console.error(`  [Error-Candidate] ${cand.package_name} 处理失败(仅隔离该包): ${err.message}`);
        ledger.items[cand.package_id] = {
          package_id: cand.package_id,
          package_name: cand.package_name,
          revision_id: cand.revision_id,
          redaction_id: cand.redaction_id,
          preparation_id: cand.preparation_id,
          provider: opts.provider,
          model: opts.model,
          reasoning_effort: opts.reasoningEffort,
          status: 'isolated_error',
          error: err.message,
          updated_at: new Date().toISOString(),
        };
        await saveLedger(ledger);
        if (err.status === 429 || err.status === 503 || String(err.message).includes('容量')) break;
      }
    }

    // 结束前回读实时队列（空槽强制规划门验收）
    const endCap = await readAgentQueueCapacity();
    console.log(
      `\n[Summary] 本轮新加载=${loadedCount} | 新建题=${createdQuestionCount} | 新派发出题=${dispatchedCount} | 结束时 Agent 槽位: limit=${endCap.limit}, running=${endCap.running}, queued=${endCap.queued}, available=${endCap.available} (活动出题=${endCap.activeAuthoringCount})`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[Fatal] 出题调度脚本执行异常:`, err);
  process.exit(1);
});
