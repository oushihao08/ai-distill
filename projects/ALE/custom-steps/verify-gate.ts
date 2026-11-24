/**
 * 职责：ALE 出题后第 1 道定制步骤（`ale_verify_gate`，`internal` 通道，0 Agent 槽位）：
 *       在专属沙盒展开 `tasks/<task_id>/`、校验冻结输入哈希、拦截“全员一票否决”误杀配置，并实跑 B01/B02/B03 及 M01–M09 单因子反例。
 * 主要公开入口：`executeAleVerifyGate(ctx)`、`auditAleRubricGateBalance(rubricSpec, allowAllKeyGates)`。
 * 边界：纯本地确定性验证，不调用大模型，严禁访问其他项目目录。
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolatedRunContext, RecordedSubRun, RepairEvaluationJson } from '../../../server/custom-steps/contract';
import { materializeAleTaskFromDraft } from '../scripts/delivery';
import { resolveAleInputMaterials } from '../scripts/docx-material';

export function auditAleRubricGateBalance(
  rubricSpec: any,
  allowAllKeyGates = false,
): { passed: boolean; total: number; key_gates: number; key_gate_weight_ratio?: number; warning_or_error: string | null } {
  const criteria = Array.isArray(rubricSpec?.criteria) ? rubricSpec.criteria : [];
  const total = criteria.length;
  const keyGates = criteria.filter((c: any) => c?.is_key_gate === true).length;
  const totalWeight = criteria.reduce((acc: number, c: any) => acc + (Number(c?.weight) > 0 ? Number(c.weight) : 0), 0);
  const keyGateWeight = criteria.reduce(
    (acc: number, c: any) => acc + (c?.is_key_gate === true && Number(c?.weight) > 0 ? Number(c.weight) : 0),
    0,
  );
  const weightRatio = totalWeight > 0 ? keyGateWeight / totalWeight : 0;

  if (total >= 4 && keyGates === total && !allowAllKeyGates) {
    return {
      passed: false,
      total,
      key_gates: keyGates,
      key_gate_weight_ratio: Number(weightRatio.toFixed(4)),
      warning_or_error: `防误杀门控拦截：共 ${total} 条判据全部被设为 is_key_gate=true，任何边缘小瑕都会触发整题归零（极易 0/N 报废）；请按 65/35–75/25 分层保留至少 2 条非一票否决项，或显式传 allow_all_key_gates=true`,
    };
  }
  if (total >= 5 && weightRatio > 0.8 && !allowAllKeyGates) {
    return {
      passed: false,
      total,
      key_gates: keyGates,
      key_gate_weight_ratio: Number(weightRatio.toFixed(4)),
      warning_or_error: `防连坐门控拦截：is_key_gate=true 条目合计权重占比达 ${(weightRatio * 100).toFixed(1)}%（${keyGates}/${total} 项），超过 80% 上限，极易引发多门独立相乘导致 +1 示范模型 0/6 死锁；请将核心门控总权重收拢至 65%–75%，旁支/复核项设为 is_key_gate=false`,
    };
  }
  return {
    passed: true,
    total,
    key_gates: keyGates,
    key_gate_weight_ratio: Number(weightRatio.toFixed(4)),
    warning_or_error: null,
  };
}

export async function prepareStagedMaterialsForAleDraft(
  draft: Record<string, unknown>,
  attachments: IsolatedRunContext['attachments'],
): Promise<Array<{ name: string; bytes?: Uint8Array; text?: string }>> {
  const rawApproach = String(draft.answer_approach ?? '');
  const match = /<<<ALE_PACKAGE_JSON\s*([\s\S]*?)\s*ALE_PACKAGE_JSON>>>/.exec(rawApproach);
  const directPkg = (draft as any)?.rubric?.[0]?.metadata?.ale_package ?? (draft as any)?.ale_package;
  const parsedPkg = directPkg ?? (match?.[1] ? JSON.parse(match[1]) : null);
  const declaredInputs: Array<{ path?: string; sha256?: string }> = Array.isArray(parsedPkg?.task_card?.inputs)
    ? parsedPkg.task_card.inputs
    : [];

  return resolveAleInputMaterials(declaredInputs, attachments);
}

export function auditAleAntiSpoilerDesign(
  instructionText: string,
  variantsManifest: any,
  options?: { allow_wide_schema?: boolean; allow_without_decoy_variant?: boolean; grade_py_source?: string },
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!options?.allow_wide_schema) {
    const backtickSpans = Array.from(instructionText.matchAll(/`([^`\n]{20,})`/g)).map((m) => m[1] ?? '');
    for (const span of backtickSpans) {
      const parts = span.split(/[、，,]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 16) {
        issues.push(
          `防剧透门禁拦截：instruction.md 单处枚举了 ${parts.length} 个固定字段（"${parts.slice(0, 5).join('、')}..."），超过 16 个终点键上限；严禁将中间推导步骤写成宽表说明书喂给模型，只允许锁定 6–12 个业务终点结果键`,
        );
        break;
      }
    }
  }
  if (!options?.allow_without_decoy_variant && variantsManifest && Array.isArray(variantsManifest.variants)) {
    const hasShallowDecoy = variantsManifest.variants.some((v: any) => v?.kind === 'shallow_decoy_trap');
    if (!hasShallowDecoy) {
      issues.push(
        '高波动压难门禁拦截：variant_fixtures 缺少 kind="shallow_decoy_trap"（如 M10_shallow_decoy_trap）表层诱饵仿真反例；必须构造采信表层汇总假象的仿真答卷并实测确认其 score<=0.78 且 success=false，防止 8/8 过易报废',
      );
    }
  }
  if (typeof options?.grade_py_source === 'string' && options.grade_py_source.length > 0) {
    if (/load_workbook\s*\([^)]*data_only\s*=\s*True/i.test(options.grade_py_source) && !options.grade_py_source.includes('ExcelEvaluator')) {
      issues.push(
        '跨模型公平门禁拦截：grade.py 单纯使用 openpyxl(data_only=True) 读取缓存值而未走 ExcelEvaluator AST 重算，会单边误杀无 LibreOffice 下 cached=None 的 +1 示范模型；请改用 ale_grader_lib.ExcelEvaluator',
      );
    }
  }
  return { passed: issues.length === 0, issues };
}

export async function executeAleVerifyGate(ctx: IsolatedRunContext): Promise<Record<string, unknown>> {
  const stagedRoot = join(ctx.project_workflow_dir, 'staged');
  await rm(stagedRoot, { recursive: true, force: true });

  const inputMaterials = await prepareStagedMaterialsForAleDraft(ctx.question_draft, ctx.attachments);
  const materialized = await materializeAleTaskFromDraft({
    draft: ctx.question_draft,
    taskIdFallback: `ALE-${ctx.workflow_id.slice(0, 8).toUpperCase()}`,
    inputMaterials,
    outputParentDir: stagedRoot,
    executeDynamic: true,
  });

  const rubricSpec = JSON.parse(await readFile(join(materialized.task_dir, 'tests/rubric.json'), 'utf8'));
  const instructionText = await readFile(join(materialized.task_dir, 'instruction.md'), 'utf8');
  const gradePySource = await readFile(join(materialized.task_dir, 'tests/grade.py'), 'utf8').catch(() => '');
  let variantsManifest: any = null;
  try {
    variantsManifest = JSON.parse(await readFile(join(materialized.task_dir, 'tests/reference/variants/manifest.json'), 'utf8'));
  } catch {
    variantsManifest = null;
  }

  const allowAllKeyGates = ctx.run_config.allow_all_key_gates === true;
  const gateAudit = auditAleRubricGateBalance(rubricSpec, allowAllKeyGates);
  const antiSpoiler = auditAleAntiSpoilerDesign(instructionText, variantsManifest, {
    allow_wide_schema: ctx.run_config.allow_wide_schema === true,
    allow_without_decoy_variant: ctx.run_config.allow_without_decoy_variant === true,
    grade_py_source: gradePySource,
  });

  const failedCheckRecords = materialized.summary.records.filter((r) => r.status === 'FAIL');
  if (!gateAudit.passed || !antiSpoiler.passed || failedCheckRecords.length > 0) {
    const reasons = [
      ...failedCheckRecords.map((r) => `${r.check_id}: ${r.observed}`),
      ...(gateAudit.warning_or_error ? [gateAudit.warning_or_error] : []),
      ...antiSpoiler.issues,
    ];
    return {
      passed: false,
      failure_reason: reasons.join(' | '),
      task_id: materialized.task_id,
      staged_task_dir: materialized.task_dir,
      gate_balance: gateAudit,
      anti_spoiler: antiSpoiler,
      records: materialized.summary.records,
    };
  }

  return {
    passed: true,
    task_id: materialized.task_id,
    staged_task_dir: materialized.task_dir,
    package_hash: materialized.summary.package_hash,
    gate_balance: gateAudit,
    anti_spoiler: antiSpoiler,
    records: materialized.summary.records,
  };
}

export function buildAleVerifyRepairEvaluation(ctx: {
  sub_runs: ReadonlyArray<RecordedSubRun>;
  result?: Record<string, unknown> | null;
  error?: string | null;
}): RepairEvaluationJson | null {
  const res = ctx.result ?? ctx.sub_runs[0]?.result ?? null;
  const errText = ctx.error ?? ctx.sub_runs[0]?.error ?? null;
  const records = Array.isArray(res?.records) ? (res.records as Array<Record<string, unknown>>) : [];
  const failedChecks = records.filter((r) => r.status === 'FAIL');

  const hotspots = failedChecks.map((r) => ({
    criterion_id: String(r.check_id ?? 'CHK_VERIFY'),
    fail_rate: 1,
    observed_samples: [r.observed ?? errText ?? '未通过'],
  }));

  const actions: string[] = [];
  if (res?.gate_balance && (res.gate_balance as any).passed === false) {
    actions.push('按 70/30 分层调整 rubric.json 与 grade.py 的 is_key_gate，保留至少 1–3 条非一票否决细节项');
  }
  for (const fc of failedChecks) {
    actions.push(`修复 ${String(fc.check_id)}：${String(fc.observed ?? '')}`);
  }
  if (!actions.length && errText) {
    actions.push(`修复反例硬筛阻断项：${errText}`);
  }
  if (!actions.length) return null;

  return {
    schema_version: 'custom_repair_eval_v1',
    verdict: 'verify_gate_blocked',
    recommended_scope: 'grader_only_regrade',
    failed_criteria_hotspots: hotspots,
    action_items: actions,
    generated_at: new Date().toISOString(),
    updated_by: 'auto_diagnostic',
  };
}
