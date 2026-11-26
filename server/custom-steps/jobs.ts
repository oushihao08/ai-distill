/**
 * 职责：项目定制步骤（Custom Steps）的沙盒隔离执行器、单槽位子运行（Sub-run）状态机编排器、下游门控与状态投影。
 * 主要公开入口：
 * - `runBeforeAnchorGates()`：在基础步骤派发前运行项目注册的轻量前置关卡（0 槽位）。
 * - `invalidateDownstreamCustomSteps()`：基础步骤重跑时自动作废下游旧版本定制步骤运行。
 * - `assertBeforePublishCustomStepsReady()`：归档前核验该项目注册的必过定制步骤均在当前题目摘要下达成 `succeeded`。
 * - `listWorkflowCustomSteps()` / `enqueueCustomStep()` / `cancelCustomStep()` / `runNextCustomStep()`。
 * 安全不变量：
 * - 未注册定制步骤的项目（如豆包、Work）直接内存短路返回，零数据库查询、零行为影响。
 * - 所有文件副作用强制限制在经 `realpath` 校验的 `.storage/<workflow_id>/custom-steps/<project_key>/` 沙盒树内。
 * - 任何项目定制步骤抛出的异常均捕获结算至 `custom_step_runs`，绝不篡改基础表 `steps` 或中断主 worker。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { HTTPException } from 'hono/http-exception';
import { join, relative, resolve, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { canonicalJson } from '../../shared/workflow-config';
import {
  forgetLocalRegistrations,
  localClaimSql,
  localExecutionQueue,
  localQueueEnabled,
  localQueueLimits,
  localWaitingSql,
  registerLocalJobs,
  releaseRolledBackRegistrations,
  supersedeForeignPending,
  withLocalQueueRoot,
} from '../execution-queue/runtime';
import { resolveStepProjectKey } from '../lifecycle/steps';
import { classifyLogError, logEvent, withLogContext } from '../logging';
import { readCurrentRedactionForDocx, readOriginalFilesForDelivery } from '../materials/redacted-docx-export';
import { readQuestionMaterials } from '../question-materials';
import { assertWorkflowNotArchived } from '../workflow-archive-guard';
import {
  MAX_ALLOWED_PARALLEL_SUBRUNS,
  validateRepairEvaluationJson,
  type CustomStepDefinition,
  type InlineBeforeGateContext,
  type RecordedSubRun,
  type RepairEvaluationJson,
  type SubRunDecision,
  type WorkflowCustomStepView,
} from './contract';
import type { CustomStepRegistry } from './registry';

type Db = Pick<Pool | PoolClient, 'query'>;

export function resolveParallelCap(def: CustomStepDefinition, config?: Record<string, unknown>): number {
  const preset = typeof config?.preset === 'string' ? config.preset : undefined;
  const presetDefault =
    preset === 'sample_3'
      ? 3
      : preset === 'sample_5'
        ? 5
        : preset === 'formal_8plus1'
          ? (def.max_parallel_subruns ?? 12)
          : (def.max_parallel_subruns ?? 8);
  const raw = Number(config?.max_parallel_subruns ?? presetDefault);
  if (!Number.isFinite(raw)) return Math.min(MAX_ALLOWED_PARALLEL_SUBRUNS, Math.max(1, Math.trunc(presetDefault)));
  return Math.min(MAX_ALLOWED_PARALLEL_SUBRUNS, Math.max(1, Math.trunc(raw)));
}

function safeSegment(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..' || /[\x00-\x1f]/.test(clean)) {
    throw new Error(`非法沙盒路径段(${label}): ${value}`);
  }
  return clean;
}

export function computeAuthoringSourceDigest(questionAttempt: { id: string; input?: unknown; result?: any }): string {
  const q = questionAttempt.result;
  return createHash('sha256')
    .update(
      canonicalJson({
        mode: 'author_only_sealed',
        question_attempt_id: questionAttempt.id,
        source: questionAttempt.input ?? null,
        question: q?.question ?? '',
        question_version: q?.question_version ?? '',
        rubric: q?.rubric ?? [],
        rubric_version: q?.rubric_version ?? '',
        attachment_ids: q?.attachment_ids ?? [],
        ...(q?.scoring_policy ? { scoring_policy: q.scoring_policy } : {}),
        answer_requirements: q?.answer_requirements ?? null,
      }),
    )
    .digest('hex');
}

export async function customStepsTableAvailable(db: Db): Promise<boolean> {
  const res = await db.query("SELECT to_regclass('ai_distill.custom_step_runs') IS NOT NULL AS available");
  return Boolean(res.rows[0]?.available);
}

/** 构造并经 realpath 校验无符号链接逃逸的定制步骤沙盒目录。 */
export async function prepareCagedDirectories(
  storageRoot: string,
  workflowId: string,
  projectKey: string,
  stepKey: string,
  subRunKey: string,
): Promise<{ projectWorkflowDir: string; sandboxDir: string }> {
  await mkdir(resolve(storageRoot), { recursive: true, mode: 0o700 });
  const realRoot = await realpath(resolve(storageRoot));
  const wfSeg = safeSegment(workflowId, 'workflow_id');
  const projSeg = safeSegment(projectKey, 'project_key');
  const stepSeg = safeSegment(stepKey, 'step_key');
  const subSeg = safeSegment(subRunKey, 'sub_run_key');

  const projectWorkflowCandidate = join(realRoot, wfSeg, 'custom-steps', projSeg);
  const sandboxCandidate = join(projectWorkflowCandidate, stepSeg, subSeg);
  await mkdir(sandboxCandidate, { recursive: true, mode: 0o700 });

  const [projectWorkflowDir, sandboxDir] = await Promise.all([
    realpath(projectWorkflowCandidate),
    realpath(sandboxCandidate),
  ]);
  const relProj = relative(realRoot, projectWorkflowDir);
  const relSandbox = relative(projectWorkflowDir, sandboxDir);
  if (
    !relProj ||
    relProj.startsWith(`..${sep}`) ||
    relProj === '..' ||
    !relSandbox ||
    relSandbox.startsWith(`..${sep}`) ||
    relSandbox === '..'
  ) {
    throw new Error('定制步骤沙盒目录检测到符号链接越界');
  }
  return { projectWorkflowDir, sandboxDir };
}

/** 在基础步骤派发前运行项目注册的同步/内联前置关卡（如出题前输入哈希锁定）；未注册项目直接返回 undefined。 */
export async function runBeforeAnchorGates(
  registry: CustomStepRegistry,
  projectKey: string | null | undefined,
  ordinal: 1 | 4 | 8 | 9,
  context: Omit<InlineBeforeGateContext, 'project_key'>,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  const gates = registry.listForProject(projectKey, { ordinal, placement: 'before' }).filter((d) => d.mode === 'inline_before_gate');
  if (!gates.length || !projectKey) return undefined;

  const aggregated: Record<string, Record<string, unknown>> = {};
  for (const gate of gates) {
    const out = await gate.runBeforeGate!({ ...context, project_key: projectKey });
    if (out?.frozen_metadata && Object.keys(out.frozen_metadata).length > 0) {
      aggregated[gate.step_key] = out.frozen_metadata;
    }
  }
  return Object.keys(aggregated).length ? aggregated : undefined;
}

/** 当上游基础步骤（如 ordinal=4 出题）重新派发时，将该工作流下游挂起的定制步骤标为 skipped 并取消本机排队意图。 */
export async function invalidateDownstreamCustomSteps(
  db: Db,
  storageRoot: string | undefined,
  registry: CustomStepRegistry,
  projectKey: string | null | undefined,
  workflowId: string,
  fromOrdinal: number,
): Promise<void> {
  if (!registry.hasProject(projectKey)) return;
  if (!(await customStepsTableAvailable(db))) return;

  const cancelled = await db.query(
    `UPDATE ai_distill.custom_step_runs
     SET status = 'skipped', error = '上游步骤重新派发，旧版定制步骤自动失效', finished_at = now()
     WHERE workflow_id = $1 AND anchor_ordinal >= $2 AND status IN ('waiting', 'running')
     RETURNING id`,
    [workflowId, fromOrdinal],
  );
  if (localQueueEnabled() && cancelled.rows.length) {
    const applyCancel = () => {
      const q = localExecutionQueue();
      for (const row of cancelled.rows) {
        const local = q.get(String(row.id));
        if (local && ['pending_registration', 'queued', 'running'].includes(local.state)) {
          q.cancel(String(row.id));
        }
      }
    };
    if (storageRoot) {
      await withLocalQueueRoot(storageRoot, async () => applyCancel());
    } else {
      applyCancel();
    }
  }
}

function mapRecordedSubRuns(rows: any[]): RecordedSubRun[] {
  return rows.map((row) => ({
    id: String(row.id),
    sub_run_key: String(row.sub_run_key),
    status: row.status,
    config: (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>,
    result: row.result && typeof row.result === 'object' ? (row.result as Record<string, unknown>) : null,
    repair_evaluation:
      row.repair_evaluation && typeof row.repair_evaluation === 'object' && !Array.isArray(row.repair_evaluation)
        ? (row.repair_evaluation as RepairEvaluationJson)
        : null,
    error: typeof row.error === 'string' ? row.error : null,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    finished_at:
      row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ? String(row.finished_at) : null,
  }));
}

function deriveStepSummary(
  def: CustomStepDefinition,
  workflowId: string,
  sourceDigest: string,
  currentRuns: RecordedSubRun[],
  options?: Record<string, unknown>,
): {
  status: WorkflowCustomStepView['status'];
  progress_label: string | null;
  summary: Record<string, unknown> | null;
  repair_evaluation: RepairEvaluationJson | null;
  error: string | null;
  decision?: SubRunDecision;
} {
  if (!currentRuns.length) {
    return { status: 'not_started', progress_label: null, summary: null, repair_evaluation: null, error: null };
  }

  const persistedRepair =
    currentRuns.find((r) => r.repair_evaluation?.updated_by === 'user')?.repair_evaluation ??
    currentRuns.find((r) => r.repair_evaluation)?.repair_evaluation ??
    null;

  if (def.mode === 'queued_single') {
    const latest = currentRuns[0]!;
    const computedRepair =
      persistedRepair ??
      (latest.status === 'failed'
        ? (def.buildRepairEvaluation?.({ sub_runs: currentRuns, result: latest.result, error: latest.error }) ?? null)
        : null);
    return {
      status: latest.status,
      progress_label:
        latest.status === 'succeeded'
          ? '检查通过'
          : latest.status === 'running'
            ? '执行中'
            : latest.status === 'waiting'
              ? '排队中'
              : latest.error || latest.status,
      summary: latest.result,
      repair_evaluation: computedRepair,
      error: latest.error,
    };
  }

  const orderedAsc = [...currentRuns].reverse();
  const frozenOptions = options ?? orderedAsc[0]?.config;
  const decision = def.planSubRuns!({
    project_key: def.project_key,
    workflow_id: workflowId,
    source_digest: sourceDigest,
    options: frozenOptions,
    sub_runs: orderedAsc,
  });

  if (decision.action === 'succeeded') {
    return {
      status: 'succeeded',
      progress_label: decision.progress_label,
      summary: decision.summary,
      repair_evaluation: null,
      error: null,
      decision,
    };
  }
  if (decision.action === 'failed' || decision.action === 'early_stop_failed') {
    const repairEval =
      persistedRepair ??
      decision.repair_evaluation ??
      def.buildRepairEvaluation?.({ sub_runs: orderedAsc, decision }) ??
      null;
    return {
      status: 'failed',
      progress_label: decision.progress_label,
      summary: decision.summary ?? null,
      repair_evaluation: repairEval,
      error: decision.reason,
      decision,
    };
  }
  const hasRunning = currentRuns.some((r) => r.status === 'running');
  const hasWaiting = currentRuns.some((r) => r.status === 'waiting');
  return {
    status: hasRunning ? 'running' : hasWaiting ? 'waiting' : 'not_started',
    progress_label: decision.progress_label,
    summary: decision.summary ?? null,
    repair_evaluation: persistedRepair,
    error: null,
    decision,
  };
}

/** 列出指定工作流的全部排队型定制步骤状态；未注册项目直接返回空数组，不查库。 */
export async function listWorkflowCustomSteps(
  db: Db,
  registry: CustomStepRegistry,
  workflowId: string,
): Promise<{ available: boolean; project_key: string | null; source_digest: string | null; steps: WorkflowCustomStepView[] }> {
  const wfRes = await db.query(
    `SELECT w.id, w.project_id, p.name AS project_name, p.parent_name
     FROM ai_distill.workflows w
     JOIN ai_distill.projects p ON p.id = w.project_id AND p.deleted_at IS NULL
     WHERE w.id = $1 AND w.deleted_at IS NULL`,
    [workflowId],
  );
  const wf = wfRes.rows[0];
  if (!wf) throw new HTTPException(404, { message: '工作流不存在' });

  const projectKey = resolveStepProjectKey({ parent_name: wf.parent_name, project_name: wf.project_name });
  const defs = registry.listForProject(projectKey, { queuedOnly: true });
  if (!defs.length) {
    return { available: true, project_key: projectKey, source_digest: null, steps: [] };
  }

  const tableReady = await customStepsTableAvailable(db);
  const authorRes = await db.query(
    `SELECT a.id, a.status, a.input, a.result, s.status AS step_status
     FROM ai_distill.steps s
     LEFT JOIN LATERAL (
       SELECT id, status, input, result
       FROM ai_distill.step_attempts
       WHERE workflow_id = s.workflow_id AND ordinal = 4
       ORDER BY attempt DESC LIMIT 1
     ) a ON TRUE
     WHERE s.workflow_id = $1 AND s.ordinal = 4`,
    [workflowId],
  );
  const authorRow = authorRes.rows[0];
  const authorReady =
    authorRow?.step_status === 'succeeded' &&
    authorRow?.status === 'succeeded' &&
    Boolean(authorRow?.result?.question_version);
  const currentDigest = authorReady ? computeAuthoringSourceDigest(authorRow) : null;

  const allRuns: any[] =
    tableReady && currentDigest
      ? (
          await db.query(
            `SELECT id, step_key, sub_run_key, status, config, result, repair_evaluation, error, started_at, finished_at
             FROM ai_distill.custom_step_runs
             WHERE workflow_id = $1 AND source_digest = $2
             ORDER BY started_at DESC, id DESC`,
            [workflowId, currentDigest],
          )
        ).rows
      : [];

  const views: WorkflowCustomStepView[] = [];
  for (const def of defs) {
    const stepRuns = mapRecordedSubRuns(allRuns.filter((r) => r.step_key === def.step_key));
    const derived =
      currentDigest && tableReady
        ? deriveStepSummary(def, workflowId, currentDigest, stepRuns)
        : { status: 'not_started' as const, progress_label: null, summary: null, repair_evaluation: null, error: null };

    let ready = Boolean(tableReady && authorReady && currentDigest);
    let readyReason: string | null = !tableReady
      ? '当前数据库尚未应用 065_project_custom_steps.sql 迁移'
      : !authorReady
        ? '须先完成当前版本的出题步骤'
        : null;

    if (ready && def.anchor.placement === 'after') {
      const priorDefs = defs.filter(
        (other) =>
          other.anchor.ordinal === def.anchor.ordinal &&
          other.anchor.placement === 'after' &&
          other.anchor.order < def.anchor.order,
      );
      for (const prior of priorDefs) {
        const priorView = views.find((v) => v.step_key === prior.step_key);
        if (priorView?.status !== 'succeeded') {
          ready = false;
          readyReason = `须先通过前置定制步骤：${prior.name}`;
          break;
        }
      }
    }

    const activeCount = stepRuns.filter((r) => r.status === 'waiting' || r.status === 'running').length;
    views.push({
      project_key: def.project_key,
      step_key: def.step_key,
      name: def.name,
      description: def.description,
      anchor: def.anchor,
      mode: def.mode,
      lane: def.lane,
      max_parallel_subruns: def.mode === 'queued_subruns' ? (def.max_parallel_subruns ?? 8) : null,
      blocks_downstream_ordinal: def.blocks_downstream_ordinal ?? null,
      allow_explicit_pilot_skip: Boolean(def.allow_explicit_pilot_skip),
      status: derived.status,
      ready: ready && activeCount === 0 && derived.status !== 'succeeded',
      ready_reason: activeCount > 0 ? '该定制步骤正在排队或运行中' : readyReason,
      progress_label: derived.progress_label,
      summary: derived.summary,
      repair_evaluation: derived.repair_evaluation,
      error: derived.error,
      active_sub_runs: activeCount,
      total_sub_runs: stepRuns.length,
      sub_runs: stepRuns,
    });
  }

  return { available: tableReady, project_key: projectKey, source_digest: currentDigest, steps: views };
}

/** 交付归档（ordinal=8）派发前门控：仅拦截注册了 `blocks_downstream_ordinal: 8` 的项目，老项目零查询放行。 */
export async function assertBeforePublishCustomStepsReady(
  db: Db,
  registry: CustomStepRegistry,
  projectKey: string | null | undefined,
  workflowId: string,
  currentSourceDigest?: string,
  options?: { pilot_skip_optional?: boolean },
): Promise<void> {
  const resolvedProjectKey = resolveStepProjectKey({ parent_name: projectKey ?? undefined, project_name: projectKey ?? undefined });
  const blockers = registry
    .listForProject(resolvedProjectKey, { queuedOnly: true })
    .filter((d) => d.blocks_downstream_ordinal === 8);
  if (!blockers.length) return;

  // 若当前数据库尚未启用 065 可选迁移，保持向后兼容不硬崩旧试包流程；一旦建表即严格执行门控。
  if (!(await customStepsTableAvailable(db))) return;

  let effectiveDigest = currentSourceDigest;
  if (!effectiveDigest) {
    const author = (
      await db.query(
        "SELECT id, status, input, result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1",
        [workflowId],
      )
    ).rows[0];
    if (!author || author.status !== 'succeeded') {
      throw new HTTPException(409, { message: '归档前尚未找到有效出题版本' });
    }
    effectiveDigest = computeAuthoringSourceDigest(author);
  }

  const rows = (
    await db.query(
      `SELECT id, step_key, sub_run_key, status, config, result, error, started_at, finished_at
       FROM ai_distill.custom_step_runs
       WHERE workflow_id = $1 AND source_digest = $2
       ORDER BY started_at DESC, id DESC`,
      [workflowId, effectiveDigest],
    )
  ).rows;

  const missingNames: string[] = [];
  for (const def of blockers) {
    if (options?.pilot_skip_optional && def.allow_explicit_pilot_skip) continue;
    const stepRuns = mapRecordedSubRuns(rows.filter((r) => r.step_key === def.step_key));
    const derived = deriveStepSummary(def, workflowId, effectiveDigest, stepRuns);
    if (derived.status !== 'succeeded') {
      missingNames.push(`${def.name}${derived.error ? `（${derived.error}）` : ''}`);
    }
  }

  if (missingNames.length) {
    throw new HTTPException(409, {
      message: `归档前须先通过当前题目版本的项目专属步骤：${missingNames.join('；')}`,
    });
  }
}

async function insertQueuedSubRuns(
  db: PoolClient,
  def: CustomStepDefinition,
  workflowId: string,
  projectId: string,
  sourceDigest: string,
  specs: Array<{ sub_run_key: string; input?: Record<string, unknown>; config?: Record<string, unknown> }>,
): Promise<string[]> {
  if (!specs.length) return [];
  const createdIds: string[] = [];
  const intents: Array<{ id: string; kind: 'custom_step'; lane: CustomStepDefinition['lane']; route: 'custom_step' }> = [];

  for (const spec of specs) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO ai_distill.custom_step_runs(
         id, workflow_id, project_id, project_key, step_key,
         anchor_ordinal, placement, step_order, sub_run_key,
         lane, execution_target, status, source_digest, input, config
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'local','waiting',$11,$12,$13)`,
      [
        id,
        workflowId,
        projectId,
        def.project_key,
        def.step_key,
        def.anchor.ordinal,
        def.anchor.placement,
        def.anchor.order,
        spec.sub_run_key,
        def.lane,
        sourceDigest,
        JSON.stringify(spec.input ?? {}),
        JSON.stringify(spec.config ?? {}),
      ],
    );
    createdIds.push(id);
    intents.push({ id, kind: 'custom_step', lane: def.lane, route: 'custom_step' });
  }

  await registerLocalJobs(db, intents);
  return createdIds;
}

/** 派发或续推指定定制步骤；对 `queued_subruns`（如 8+1）按 `max_parallel_subruns` 窗口单槽位分批入队。 */
export async function enqueueCustomStep(
  pool: Pool,
  storageRoot: string,
  registry: CustomStepRegistry,
  workflowId: string,
  stepKey: string,
  options?: Record<string, unknown>,
): Promise<{ enqueued_ids: string[]; status: string; progress_label: string | null }> {
  if (!localQueueEnabled()) {
    throw new HTTPException(409, { message: '项目定制步骤需要启用本机独立队列（EXECUTION_QUEUE_MODE=local）' });
  }
  const def = registry.getByStepKey(stepKey);
  if (!def || def.mode === 'inline_before_gate') {
    throw new HTTPException(404, { message: `未找到可派发的定制步骤: ${stepKey}` });
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await assertWorkflowNotArchived(db, workflowId);
    if (!(await customStepsTableAvailable(db))) {
      throw new HTTPException(409, { message: '当前数据库尚未应用 065_project_custom_steps.sql 迁移' });
    }

    const wfRes = await db.query(
      `SELECT w.id, w.project_id, p.name AS project_name, p.parent_name
       FROM ai_distill.workflows w
       JOIN ai_distill.projects p ON p.id = w.project_id AND p.deleted_at IS NULL
       WHERE w.id = $1 AND w.deleted_at IS NULL
       FOR UPDATE OF w`,
      [workflowId],
    );
    const wf = wfRes.rows[0];
    if (!wf) throw new HTTPException(404, { message: '工作流不存在' });
    const projectKey = resolveStepProjectKey({ parent_name: wf.parent_name, project_name: wf.project_name });
    if (projectKey !== def.project_key) {
      throw new HTTPException(409, { message: `步骤 ${stepKey} 仅属于项目 ${def.project_key}，禁止跨项目调用` });
    }

    const author = (
      await db.query(
        "SELECT id, status, input, result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1",
        [workflowId],
      )
    ).rows[0];
    const step4 = (await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=4', [workflowId])).rows[0];
    if (!author || author.status !== 'succeeded' || step4?.status !== 'succeeded' || !author.result?.question_version) {
      throw new HTTPException(409, { message: '须先完成当前版本的出题步骤' });
    }
    const sourceDigest = computeAuthoringSourceDigest(author);

    // 校验前置同锚点定制步骤已全部通过
    const priorDefs = registry
      .listForProject(projectKey, { ordinal: def.anchor.ordinal, placement: def.anchor.placement, queuedOnly: true })
      .filter((other) => other.anchor.order < def.anchor.order);
    if (priorDefs.length) {
      const priorRows = (
        await db.query(
          `SELECT id, step_key, sub_run_key, status, config, result, error, started_at, finished_at
           FROM ai_distill.custom_step_runs
           WHERE workflow_id = $1 AND source_digest = $2`,
          [workflowId, sourceDigest],
        )
      ).rows;
      for (const prior of priorDefs) {
        const priorSummary = deriveStepSummary(
          prior,
          workflowId,
          sourceDigest,
          mapRecordedSubRuns(priorRows.filter((r) => r.step_key === prior.step_key)),
        );
        if (priorSummary.status !== 'succeeded') {
          throw new HTTPException(409, { message: `须先通过前置定制步骤：${prior.name}` });
        }
      }
    }

    await withLocalQueueRoot(storageRoot, () => supersedeForeignPending(db, { kind: 'custom_step', id: workflowId, stepKey }));

    const existingRows = (
      await db.query(
        `SELECT id, sub_run_key, status, config, result, error, started_at, finished_at
         FROM ai_distill.custom_step_runs
         WHERE workflow_id = $1 AND step_key = $2 AND source_digest = $3
         ORDER BY started_at DESC, id DESC`,
        [workflowId, stepKey, sourceDigest],
      )
    ).rows;
    const recorded = mapRecordedSubRuns(existingRows);

    if (def.mode === 'queued_single') {
      const active = recorded.find((r) => r.status === 'waiting' || r.status === 'running');
      if (active) {
        await db.query('COMMIT');
        forgetLocalRegistrations(db);
        return { enqueued_ids: [active.id], status: active.status, progress_label: '已在执行或排队中' };
      }
      const ids = await withLocalQueueRoot(storageRoot, () =>
        insertQueuedSubRuns(db, def, workflowId, wf.project_id, sourceDigest, [
          { sub_run_key: 'main', config: options ?? {} },
        ]),
      );
      await db.query('COMMIT');
      forgetLocalRegistrations(db);
      return { enqueued_ids: ids, status: 'queued', progress_label: '已入队' };
    }

    // queued_subruns：若用户传 reset_failed=true 或 regrade_only=true，允许将旧子运行归档跳过以开启新一轮标定或秒级重评
    let effectiveRecorded = recorded;
    if (
      (options?.reset_failed === true || options?.regrade_only === true) &&
      !recorded.some((r) => r.status === 'waiting' || r.status === 'running')
    ) {
      await db.query(
        `UPDATE ai_distill.custom_step_runs
         SET status = 'skipped', error = COALESCE(error, '') || $4
         WHERE workflow_id = $1 AND step_key = $2 AND source_digest = $3`,
        [workflowId, stepKey, sourceDigest, options?.regrade_only === true ? ' [离线重评归档]' : ' [显式重置重跑]'],
      );
      effectiveRecorded = [];
    }

    const activeCount = effectiveRecorded.filter((r) => r.status === 'waiting' || r.status === 'running').length;
    const cap = resolveParallelCap(def, options);
    const decision = def.planSubRuns!({
      project_key: def.project_key,
      workflow_id: workflowId,
      source_digest: sourceDigest,
      options,
      sub_runs: [...effectiveRecorded].reverse(),
    });

    if (decision.action === 'succeeded') {
      await db.query('COMMIT');
      forgetLocalRegistrations(db);
      return { enqueued_ids: [], status: 'succeeded', progress_label: decision.progress_label };
    }
    if (decision.action === 'failed' || decision.action === 'early_stop_failed') {
      throw new HTTPException(409, {
        message: `${decision.reason}（如需在修订前强制重跑可传 reset_failed=true 或 regrade_only=true，正式标定建议先修订题目）`,
      });
    }

    const queueAvailable = await withLocalQueueRoot(storageRoot, async () => {
      const q = localExecutionQueue();
      const limits = localQueueLimits(q);
      return q.capacity(def.lane, limits[def.lane]).available;
    });
    const availableWindow = Math.min(Math.max(0, cap - activeCount), queueAvailable > 0 ? queueAvailable : 1);
    const toEnqueue = decision.action === 'enqueue' ? decision.next_sub_runs.slice(0, availableWindow) : [];
    const ids = await withLocalQueueRoot(storageRoot, () =>
      insertQueuedSubRuns(
        db,
        def,
        workflowId,
        wf.project_id,
        sourceDigest,
        toEnqueue.map((spec) => ({
          sub_run_key: spec.sub_run_key,
          input: spec.input,
          config: { ...(options ?? {}), ...(spec.config ?? {}) },
        })),
      ),
    );

    await db.query('COMMIT');
    forgetLocalRegistrations(db);
    return {
      enqueued_ids: ids,
      status: ids.length || activeCount > 0 ? 'queued' : 'waiting',
      progress_label: decision.progress_label,
    };
  } catch (err) {
    await db.query('ROLLBACK');
    await releaseRolledBackRegistrations(db);
    throw err;
  } finally {
    db.release();
  }
}

export async function cancelCustomStep(
  pool: Pool,
  storageRoot: string,
  registry: CustomStepRegistry,
  workflowId: string,
  stepKey: string,
): Promise<{ cancelled_ids: string[] }> {
  const def = registry.getByStepKey(stepKey);
  if (!def) throw new HTTPException(404, { message: `未知定制步骤: ${stepKey}` });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (!(await customStepsTableAvailable(db))) {
      await db.query('COMMIT');
      return { cancelled_ids: [] };
    }
    const res = await db.query(
      `UPDATE ai_distill.custom_step_runs
       SET status = 'cancelled', error = '用户手动取消定制步骤', finished_at = now()
       WHERE workflow_id = $1 AND step_key = $2 AND status IN ('waiting', 'running')
       RETURNING id`,
      [workflowId, stepKey],
    );
    const ids = res.rows.map((r) => String(r.id));
    await db.query('COMMIT');
    if (localQueueEnabled() && ids.length) {
      await withLocalQueueRoot(storageRoot, async () => {
        const q = localExecutionQueue();
        for (const id of ids) q.cancel(id);
      });
    }
    return { cancelled_ids: ids };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

/** 消费本机队列认领的单条定制步骤子运行（固定只占当前通道 1 个槽位），完成后自动推进多子运行状态机（早停或补位）。 */
export async function runNextCustomStep(
  pool: Pool,
  storageRoot: string,
  registry: CustomStepRegistry,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const db = await pool.connect();
  let claimed: any;
  let authorRow: any;

  try {
    await db.query('BEGIN');
    if (!(await customStepsTableAvailable(db))) {
      await db.query('COMMIT');
      return false;
    }
    claimed = (
      await db.query(
        `SELECT r.*, w.title AS workflow_title
         FROM ai_distill.custom_step_runs r
         JOIN ai_distill.workflows w ON w.id = r.workflow_id AND w.deleted_at IS NULL
         JOIN ai_distill.projects p ON p.id = r.project_id AND p.deleted_at IS NULL
         WHERE ${localWaitingSql('r')} ${localClaimSql('r')}
         ORDER BY r.started_at ASC
         FOR UPDATE OF r SKIP LOCKED
         LIMIT 1`,
      )
    ).rows[0];
    if (!claimed) {
      await db.query('COMMIT');
      return false;
    }

    authorRow = (
      await db.query(
        "SELECT id, status, input, result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1",
        [claimed.workflow_id],
      )
    ).rows[0];
    const currentDigest =
      authorRow?.status === 'succeeded' && authorRow?.result?.question_version
        ? computeAuthoringSourceDigest(authorRow)
        : null;

    if (!currentDigest || currentDigest !== claimed.source_digest) {
      await db.query(
        "UPDATE ai_distill.custom_step_runs SET status='skipped', error='题目版本已变更，旧定制步骤跳过', finished_at=now() WHERE id=$1",
        [claimed.id],
      );
      await db.query('COMMIT');
      return true;
    }

    await db.query(
      "UPDATE ai_distill.custom_step_runs SET status='running', heartbeat_at=now() WHERE id=$1",
      [claimed.id],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }

  const def = registry.getByStepKey(String(claimed.step_key));
  if (!def || !def.executeRun || def.project_key !== claimed.project_key) {
    await pool.query(
      "UPDATE ai_distill.custom_step_runs SET status='failed', error='未找到匹配的受信任项目定制步骤定义', finished_at=now() WHERE id=$1",
      [claimed.id],
    );
    return true;
  }

  const heartbeatTimer = setInterval(() => {
    pool
      .query("UPDATE ai_distill.custom_step_runs SET heartbeat_at=now() WHERE id=$1 AND status='running'", [claimed.id])
      .catch(() => {});
  }, 15000);
  heartbeatTimer.unref();

  let runStatus: 'succeeded' | 'failed' | 'cancelled' = 'failed';
  let runResult: Record<string, unknown> | null = null;
  let runError: string | null = null;

  try {
    const { projectWorkflowDir, sandboxDir } = await prepareCagedDirectories(
      storageRoot,
      String(claimed.workflow_id),
      def.project_key,
      def.step_key,
      String(claimed.sub_run_key),
    );
    const loadedMaterials = await readQuestionMaterials(pool, String(claimed.workflow_id), storageRoot);
    const structuredDocx = await readCurrentRedactionForDocx(pool, String(claimed.workflow_id)).catch(() => undefined);
    const preparedDocuments =
      structuredDocx && 'prepared_documents' in structuredDocx && Array.isArray(structuredDocx.prepared_documents)
        ? structuredDocx.prepared_documents
        : undefined;
    let originalFiles: Array<{ name: string; sha256: string; content_base64: string }> | undefined;
    if (
      loadedMaterials.origin.kind === 'library_v1' &&
      loadedMaterials.origin.material_mode === 'original' &&
      !(structuredDocx && 'selected_materials' in structuredDocx && structuredDocx.selected_materials)
    ) {
      const snapRow = (
        await pool
          .query('SELECT snapshot_manifest FROM ai_distill.question_library_sources WHERE workflow_id=$1', [
            String(claimed.workflow_id),
          ])
          .catch(() => ({ rows: [] }))
      ).rows[0];
      const manifest = snapRow?.snapshot_manifest;
      const expected = Array.isArray(manifest?.files)
        ? manifest.files.map((f: any) => ({
            material_id: String(f.material_id),
            original_name: String(f.original_name),
            sha256: String(f.source_sha256),
          }))
        : [];
      if (expected.length) {
        const rawLoaded = await readOriginalFilesForDelivery(
          pool,
          String(claimed.workflow_id),
          storageRoot,
          expected,
        ).catch(() => undefined);
        if (rawLoaded?.length) {
          originalFiles = rawLoaded.map((f) => ({
            name: f.name,
            sha256: f.sha256,
            content_base64: Buffer.from(f.bytes).toString('base64'),
          }));
        }
      }
    }
    const modelAtts = loadedMaterials.model_attachments?.length
      ? loadedMaterials.model_attachments
      : loadedMaterials.attachments;
    const attachments = loadedMaterials.attachments.map((att, idx) => ({
      id: att.id,
      name: `材料-${String(idx + 1).padStart(3, '0')}.md`,
      sha256: att.sha256,
      text: att.content,
      model_sha256: modelAtts[idx]?.sha256,
      model_text: modelAtts[idx]?.content,
      ...(preparedDocuments ? { prepared_documents: preparedDocuments } : {}),
      ...(idx === 0 && originalFiles ? { original_files: originalFiles } : {}),
    }));

    const out = await withLogContext(
      {
        component: 'custom_steps',
        workflow_id: claimed.workflow_id,
        project_id: claimed.project_id,
        operation: `${def.step_key}:${claimed.sub_run_key}`,
      },
      () =>
        def.executeRun!({
          project_key: def.project_key,
          project_id: String(claimed.project_id),
          workflow_id: String(claimed.workflow_id),
          step_key: def.step_key,
          sub_run_key: String(claimed.sub_run_key),
          source_digest: String(claimed.source_digest),
          sandbox_dir: sandboxDir,
          project_workflow_dir: projectWorkflowDir,
          question_draft: authorRow.result as Record<string, unknown>,
          attachments,
          run_config: (claimed.config ?? {}) as Record<string, unknown>,
          run_input: (claimed.input ?? {}) as Record<string, unknown>,
          signal,
        }),
    );

    const stepPassed = out.passed !== false;
    runStatus = signal.aborted ? 'cancelled' : stepPassed ? 'succeeded' : 'failed';
    runResult = out;
    runError = stepPassed ? null : String(out.failure_reason ?? '定制步骤检查未通过');
  } catch (err) {
    runStatus = signal.aborted ? 'cancelled' : 'failed';
    runError = err instanceof Error ? err.message.slice(0, 500) : '定制步骤运行异常';
    logEvent('custom_step.failed', {
      level: 'warn',
      component: 'custom_steps',
      workflow_id: claimed.workflow_id,
      step_key: def.step_key,
      sub_run_key: claimed.sub_run_key,
      ...classifyLogError(err),
    });
  } finally {
    clearInterval(heartbeatTimer);
  }

  // 结算当前子运行，并在同一事务中推进 queued_subruns 状态机（早停取消未开始任务、补充下一槽位子任务，并持久化结构化 repair_evaluation JSON）
  const settleDb = await pool.connect();
  const toCancelInLocalQueue: string[] = [];
  try {
    await settleDb.query('BEGIN');
    const singleRepairEval =
      def.mode === 'queued_single' && runStatus === 'failed'
        ? (def.buildRepairEvaluation?.({ sub_runs: [], result: runResult, error: runError }) ?? null)
        : null;

    await settleDb.query(
      `UPDATE ai_distill.custom_step_runs
       SET status = $2, result = $3, error = $4, repair_evaluation = COALESCE($5::jsonb, repair_evaluation), finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [
        claimed.id,
        runStatus,
        runResult ? JSON.stringify(runResult) : null,
        runError,
        singleRepairEval ? JSON.stringify(singleRepairEval) : null,
      ],
    );

    if (def.mode === 'queued_subruns' && runStatus !== 'cancelled') {
      await settleDb.query('SELECT id FROM ai_distill.workflows WHERE id=$1 FOR UPDATE', [claimed.workflow_id]);
      const siblingRows = (
        await settleDb.query(
          `SELECT id, sub_run_key, status, config, result, repair_evaluation, error, started_at, finished_at
           FROM ai_distill.custom_step_runs
           WHERE workflow_id = $1 AND step_key = $2 AND source_digest = $3
           ORDER BY started_at ASC, id ASC`,
          [claimed.workflow_id, def.step_key, claimed.source_digest],
        )
      ).rows;
      const recorded = mapRecordedSubRuns(siblingRows);
      const decision = def.planSubRuns!({
        project_key: def.project_key,
        workflow_id: String(claimed.workflow_id),
        source_digest: String(claimed.source_digest),
        options: (claimed.config ?? {}) as Record<string, unknown>,
        sub_runs: recorded,
      });

      if (decision.action === 'early_stop_failed' || decision.action === 'failed') {
        const subRepairEval =
          decision.repair_evaluation ??
          def.buildRepairEvaluation?.({ sub_runs: recorded, decision }) ??
          null;
        if (subRepairEval) {
          await settleDb.query(
            `UPDATE ai_distill.custom_step_runs
             SET repair_evaluation = $2::jsonb
             WHERE id = $1`,
            [claimed.id, JSON.stringify(subRepairEval)],
          );
        }
      }

      if ((decision.action === 'early_stop_failed' || decision.action === 'succeeded') && decision.cancel_waiting_sub_runs) {
        const cancelNote =
          decision.action === 'succeeded'
            ? `目标已达成，自动取消多余排队子任务（${decision.progress_label}）`
            : `自动早停止损：${decision.reason}`;
        const cancelledSiblings = await settleDb.query(
          `UPDATE ai_distill.custom_step_runs
           SET status = 'cancelled', error = $4, finished_at = now()
           WHERE workflow_id = $1 AND step_key = $2 AND source_digest = $3 AND status = 'waiting'
           RETURNING id`,
          [claimed.workflow_id, def.step_key, claimed.source_digest, cancelNote],
        );
        for (const row of cancelledSiblings.rows) toCancelInLocalQueue.push(String(row.id));
      } else if (decision.action === 'enqueue' && decision.next_sub_runs.length > 0) {
        const activeCount = recorded.filter((r) => r.status === 'waiting' || r.status === 'running').length;
        const cap = resolveParallelCap(def, (claimed.config ?? {}) as Record<string, unknown>);
        const queueAvailable = await withLocalQueueRoot(storageRoot, async () => {
          const q = localExecutionQueue();
          const limits = localQueueLimits(q);
          return q.capacity(def.lane, limits[def.lane]).available;
        });
        const room = Math.min(Math.max(0, cap - activeCount), queueAvailable > 0 ? queueAvailable : 0);
        const batch = decision.next_sub_runs.slice(0, room);
        if (batch.length > 0) {
          await withLocalQueueRoot(storageRoot, () =>
            insertQueuedSubRuns(
              settleDb,
              def,
              String(claimed.workflow_id),
              String(claimed.project_id),
              String(claimed.source_digest),
              batch.map((spec) => ({
                sub_run_key: spec.sub_run_key,
                input: spec.input,
                config: { ...(claimed.config ?? {}), ...(spec.config ?? {}) },
              })),
            ),
          );
        }
      }
    }

    await settleDb.query('COMMIT');
    forgetLocalRegistrations(settleDb);
  } catch (err) {
    await settleDb.query('ROLLBACK');
    await releaseRolledBackRegistrations(settleDb);
    throw err;
  } finally {
    settleDb.release();
  }

  if (localQueueEnabled() && toCancelInLocalQueue.length) {
    await withLocalQueueRoot(storageRoot, async () => {
      const q = localExecutionQueue();
      for (const id of toCancelInLocalQueue) q.cancel(id);
    });
  }

  return true;
}

/** 人工或代理显式保存结构化 JSON 返修评价（强制校验为 JSON 对象，写入 custom_step_runs.repair_evaluation）。 */
export async function saveCustomStepRepairEvaluation(
  pool: Pool,
  registry: CustomStepRegistry,
  workflowId: string,
  stepKey: string,
  rawPayload: unknown,
): Promise<{ step_key: string; repair_evaluation: RepairEvaluationJson }> {
  const def = registry.getByStepKey(stepKey);
  if (!def || def.mode === 'inline_before_gate') {
    throw new HTTPException(404, { message: `未找到定制步骤: ${stepKey}` });
  }
  let validated: RepairEvaluationJson;
  try {
    validated = validateRepairEvaluationJson(rawPayload);
  } catch (err) {
    throw new HTTPException(400, { message: err instanceof Error ? err.message : '返修评价 JSON 格式无效' });
  }
  if (!(await customStepsTableAvailable(pool))) {
    throw new HTTPException(409, { message: '当前数据库尚未应用 065_project_custom_steps.sql 迁移' });
  }
  const latest = (
    await pool.query(
      `SELECT id
       FROM ai_distill.custom_step_runs
       WHERE workflow_id = $1 AND step_key = $2
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [workflowId, stepKey],
    )
  ).rows[0];
  if (!latest) {
    throw new HTTPException(409, { message: '该定制步骤尚无执行记录，无法绑定返修评价 JSON' });
  }
  await pool.query(
    `UPDATE ai_distill.custom_step_runs
     SET repair_evaluation = $2::jsonb
     WHERE id = $1`,
    [latest.id, JSON.stringify(validated)],
  );
  return { step_key: stepKey, repair_evaluation: validated };
}

/** 在增量重出题前读取最近一次非空的结构化返修评价 JSON；未注册定制步骤的项目 0 查询直接返回 undefined。 */
export async function readLatestCustomRepairEvaluation(
  db: Db,
  registry: CustomStepRegistry,
  projectKey: string | null | undefined,
  workflowId: string,
): Promise<RepairEvaluationJson | undefined> {
  if (!registry.hasProject(projectKey)) return undefined;
  if (!(await customStepsTableAvailable(db))) return undefined;

  const row = (
    await db.query(
      `SELECT step_key, repair_evaluation
       FROM ai_distill.custom_step_runs
       WHERE workflow_id = $1 AND repair_evaluation IS NOT NULL
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [workflowId],
    )
  ).rows[0];
  if (!row?.repair_evaluation || typeof row.repair_evaluation !== 'object' || Array.isArray(row.repair_evaluation)) {
    return undefined;
  }
  return row.repair_evaluation as RepairEvaluationJson;
}
