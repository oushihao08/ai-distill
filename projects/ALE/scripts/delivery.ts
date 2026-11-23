/**
 * 职责：ALE 项目单题交付组装器与 ai-distill 第 8 步归档钩子。
 * 主要公开入口：
 *   1. `deliverFromWorkbench(input, outputParentDir)`：由 `server/publishing/project-delivery.ts` 在归档达标题目时自动以子进程调用；自动安全同步已验证的 staged `runs/`、`review/` 及同契约复评 `tests/grade.py`，并强制实跑动态反例与全量成功轨迹离线重评；
 *   2. CLI 模式：`bun projects/ALE/scripts/delivery.ts --from-draft <result.json> --materials-dir <dir> --out <dir> [--staged-task-dir <dir>] [--execute]`，直接将出题草稿与材料组装为第 7 节 `tasks/<task_id>/` 目录树并执行 `verify-task.ts`。
 * 副作用边界：仅向指定输出目录写入单题包、`check_records_<task_id>.json` 与诚实状态报告；拒绝任何符号链接；复用 `server/document-generation` 生成真实 OOXML `.docx` 与带活公式的 `.xlsx`；绝不伪造未执行的模型标定或买方接收状态。
 */
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../../shared/workflow-config';
import { buildDocx } from '../../../server/document-generation/docx';
import { buildXlsx, type WorkbookSheet } from '../../../server/document-generation/xlsx';
import type { DeliveryInput } from '../../../server/publishing/project-delivery';
import { ALE_FORBIDDEN_FILENAMES, isSafeRelativePath, sha256Hex } from './contracts';
import { verifyTaskDirectory } from './verify-task';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ALE_GRADER_LIB_SRC = join(SCRIPTS_DIR, 'ale_grader_lib.py');
const OFFICE_LINT_SRC = join(SCRIPTS_DIR, 'office_lint.py');

export interface AleStagedDeliveryBinding {
  task_id: string;
  staged_task_dir: string;
  has_runs: boolean;
  has_review: boolean;
  has_staged_grade_py: boolean;
}

export type AleDeliveryInput = DeliveryInput & {
  ale_staged?: AleStagedDeliveryBinding;
};

interface AleReferenceFileSpec {
  path: string;
  kind: 'docx' | 'xlsx' | 'text' | 'json';
  content: string;
  sheets?: {
    name: string;
    columns: string[];
    rows: (string | number | boolean | { formula: string; cached_value: number | null })[][];
  }[];
}

function toWorkbookSheets(rawSheets: NonNullable<AleReferenceFileSpec['sheets']>, noteText?: string): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = rawSheets.map((s) => ({
    name: s.name,
    columns: s.columns,
    rows: s.rows.map((rowArr) => {
      const rec: Record<string, unknown> = {};
      s.columns.forEach((col, i) => {
        rec[col] = rowArr[i] ?? '';
      });
      return rec;
    }),
  }));
  if (noteText && noteText.trim()) {
    sheets.push({
      name: '测算口径与依据说明',
      columns: ['段落序号', '口径与核验说明'],
      rows: noteText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, idx) => ({ 段落序号: idx + 1, 口径与核验说明: line })),
    });
  }
  return sheets;
}

async function writeArtifactBySpec(baseDir: string, spec: AleReferenceFileSpec): Promise<void> {
  if (!isSafeRelativePath(spec.path)) throw new Error(`参考产物相对路径不安全: ${spec.path}`);
  const target = join(baseDir, spec.path);
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
  if (spec.kind === 'docx' || spec.path.toLowerCase().endsWith('.docx')) {
    const bytes = await buildDocx(spec.content, { style: 'legal' });
    await writeFile(target, bytes, { mode: 0o600 });
  } else if (spec.kind === 'xlsx' || spec.path.toLowerCase().endsWith('.xlsx')) {
    if (!spec.sheets?.length) throw new Error(`XLSX 参考产物缺少结构化 sheets: ${spec.path}`);
    const bytes = buildXlsx(toWorkbookSheets(spec.sheets, spec.content));
    await writeFile(target, bytes, { mode: 0o600 });
  } else {
    await writeFile(target, spec.content, { mode: 0o600 });
  }
}

function extractAlePackage(draft: any): { alePkg: any; cleanDerivation: string } {
  const direct = draft?.rubric?.[0]?.metadata?.ale_package ?? draft?.ale_package;
  const rawApproach = String(draft?.answer_approach ?? '');
  const markerRe = /<<<ALE_PACKAGE_JSON\s*([\s\S]*?)\s*ALE_PACKAGE_JSON>>>/;
  const match = markerRe.exec(rawApproach);
  if (direct && typeof direct === 'object') {
    return { alePkg: direct, cleanDerivation: rawApproach.replace(markerRe, '').trim() };
  }
  if (match && match[1]) {
    try {
      const parsed = JSON.parse(match[1]);
      return { alePkg: parsed, cleanDerivation: rawApproach.replace(markerRe, '').trim() };
    } catch (err) {
      throw new Error(`解析 answer_approach 内 <<<ALE_PACKAGE_JSON>>> 失败: ${(err as Error).message}`);
    }
  }
  throw new Error(
    '题包缺少可执行 ALE 资产（需在 answer_approach 末尾附 <<<ALE_PACKAGE_JSON ... ALE_PACKAGE_JSON>>> 或在 rubric[0].metadata.ale_package 提供）',
  );
}

export async function materializeAleTaskFromDraft(options: {
  draft: any;
  taskIdFallback: string;
  inputMaterials: { name: string; bytes?: Uint8Array; text?: string }[];
  outputParentDir: string;
  executeDynamic?: boolean;
}) {
  const { draft, inputMaterials, outputParentDir } = options;
  const { alePkg, cleanDerivation } = extractAlePackage(draft);

  const taskCard = alePkg.task_card;
  const taskId = String(taskCard?.task_id || options.taskIdFallback);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(taskId)) {
    throw new Error(`task_id 格式无效: ${taskId}`);
  }

  const taskRoot = join(resolve(outputParentDir), 'tasks', taskId);
  await mkdir(join(taskRoot, 'environment', 'input'), { recursive: true, mode: 0o700 });
  await mkdir(join(taskRoot, 'environment', 'tools'), { recursive: true, mode: 0o755 });
  await mkdir(join(taskRoot, 'tests', 'reference'), { recursive: true, mode: 0o700 });
  await mkdir(join(taskRoot, 'solution', 'artifacts'), { recursive: true, mode: 0o700 });

  // 1. 写入 task_card.json 与 instruction.md
  await writeFile(join(taskRoot, 'task_card.json'), JSON.stringify(taskCard, null, 2) + '\n', { mode: 0o600 });
  const instructionText = String(draft.question ?? alePkg.instruction_md ?? '').trim();
  if (!instructionText) throw new Error('instruction.md (question) 正文为空');
  await writeFile(join(taskRoot, 'instruction.md'), instructionText.replace(/\r\n/g, '\n') + '\n', { mode: 0o600 });

  // 2. 写入 environment/（Dockerfile、env.json、requirements.lock、reset.sh、tools/office_lint.py、input/）
  await writeFile(join(taskRoot, 'environment', 'env.json'), JSON.stringify(alePkg.env_spec, null, 2) + '\n', { mode: 0o600 });
  const officeLintDest = join(taskRoot, 'environment', 'tools', 'office_lint.py');
  await copyFile(OFFICE_LINT_SRC, officeLintDest);
  await chmod(officeLintDest, 0o755);

  if (alePkg.dockerfile) {
    let dfText = String(alePkg.dockerfile).replace(/\r\n/g, '\n').trimEnd() + '\n';
    if (!/\bCOPY\b[^\n]*\btools\b/.test(dfText)) {
      dfText += 'COPY tools/ /workspace/tools/\n';
    }
    await writeFile(join(taskRoot, 'environment', 'Dockerfile'), dfText, { mode: 0o600 });
  }
  if (alePkg.requirements_lock) {
    await writeFile(
      join(taskRoot, 'environment', 'requirements.lock'),
      String(alePkg.requirements_lock).replace(/\r\n/g, '\n'),
      { mode: 0o600 },
    );
  }
  const resetSh = String(alePkg.reset_sh || '#!/usr/bin/env bash\nset -euo pipefail\nrm -rf /workspace/output/*\n').replace(
    /\r\n/g,
    '\n',
  );
  const resetPath = join(taskRoot, 'environment', 'reset.sh');
  await writeFile(resetPath, resetSh, { mode: 0o755 });
  await chmod(resetPath, 0o755);

  for (const [idx, mat] of inputMaterials.entries()) {
    const cleanName = basename(mat.name || `material_${idx + 1}.txt`).replace(/[\\/\x00-\x1f]/g, '_');
    const dest = join(taskRoot, 'environment', 'input', cleanName);
    if (mat.bytes) {
      await writeFile(dest, mat.bytes, { mode: 0o600 });
    } else if (typeof mat.text === 'string') {
      await writeFile(dest, mat.text, { mode: 0o600 });
    }
  }

  // 3. 写入 solution/（solve.sh、artifacts/ 及推导说明）
  const solvePath = join(taskRoot, 'solution', 'solve.sh');
  const solveSh = String(alePkg.solve_sh || '#!/usr/bin/env bash\nset -euo pipefail\n').replace(/\r\n/g, '\n');
  await writeFile(solvePath, solveSh, { mode: 0o755 });
  await chmod(solvePath, 0o755);

  if (cleanDerivation) {
    await writeFile(join(taskRoot, 'solution', 'derivation_notes.md'), cleanDerivation + '\n', { mode: 0o600 });
  }
  for (const refFile of (alePkg.reference_files ?? []) as AleReferenceFileSpec[]) {
    await writeArtifactBySpec(join(taskRoot, 'solution', 'artifacts'), refFile);
  }

  // 4. 写入 tests/（rubric.json、ale_grader_lib.py 公共判分底座库、grade.py、reference/ 真值及单因子反例集）
  await writeFile(join(taskRoot, 'tests', 'rubric.json'), JSON.stringify(alePkg.rubric_spec, null, 2) + '\n', { mode: 0o600 });
  const graderLibDest = join(taskRoot, 'tests', 'ale_grader_lib.py');
  await copyFile(ALE_GRADER_LIB_SRC, graderLibDest);
  await chmod(graderLibDest, 0o644);
  const gradePath = join(taskRoot, 'tests', 'grade.py');
  await writeFile(gradePath, String(alePkg.grade_py).replace(/\r\n/g, '\n'), { mode: 0o755 });
  await chmod(gradePath, 0o755);

  if (alePkg.reference_ground_truth !== undefined) {
    await writeFile(
      join(taskRoot, 'tests', 'reference', 'ground_truth.json'),
      JSON.stringify(alePkg.reference_ground_truth, null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  if (Array.isArray(alePkg.variant_fixtures) && alePkg.variant_fixtures.length) {
    const variantsRoot = join(taskRoot, 'tests', 'reference', 'variants');
    await mkdir(variantsRoot, { recursive: true, mode: 0o700 });
    const manifestEntries: any[] = [];
    for (const vf of alePkg.variant_fixtures) {
      const vfDir = join(variantsRoot, String(vf.id));
      await mkdir(vfDir, { recursive: true, mode: 0o700 });
      for (const fileSpec of (vf.files ?? []) as AleReferenceFileSpec[]) {
        await writeArtifactBySpec(vfDir, fileSpec);
      }
      manifestEntries.push({
        id: vf.id,
        kind: vf.kind,
        target_criterion_id: vf.target_criterion_id ?? null,
        expect_task_fail: vf.expect_task_fail ?? true,
        must_remain_passed_ids: vf.must_remain_passed_ids ?? [],
        description: vf.description ?? '',
      });
    }
    await writeFile(
      join(variantsRoot, 'manifest.json'),
      JSON.stringify({ variants: manifestEntries }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  // 5. 运行 verify-task 生成诚实质检记录与待办报告
  const summary = await verifyTaskDirectory(taskRoot, {
    executeDynamic: options.executeDynamic ?? false,
    requireRuns: false,
  });
  const checkRecordsPath = join(resolve(outputParentDir), `check_records_${taskId}.json`);
  await writeFile(checkRecordsPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });

  const statusReport = [
    `# ALE 单题交付预备包核验报告：${taskId}`,
    '',
    `- 任务版本：\`${summary.task_version}\`（包指纹：\`${summary.package_hash}\`）`,
    `- 所属领域：\`${summary.domain} / ${summary.sub_domain}\`（任务族：\`${summary.task_family}\`）`,
    `- 输出路径：\`tasks/${taskId}/\``,
    '',
    '## 一、当前质检项结果（按规范第 6 节标准）',
    '',
    '| check_id | 检查范围 | 执行方式 | 状态 | 观察结果 |',
    '| --- | --- | --- | --- | --- |',
    ...summary.records.map(
      (r) => `| \`${r.check_id}\` | ${r.scope} | \`${r.execution_mode}\` | **${r.status}** | ${r.observed.replace(/\|/g, '｜')} |`,
    ),
    '',
    '## 二、正式批次接收前仍须完成的独立步骤（严禁冒充已完成）',
    '',
    `- [${options.executeDynamic ? 'x' : ' '}] 在目标声明容器/VM 环境执行参考基线、\`no-op\`、等价解与单因子反例动态测试（\`CHK-05-DYNAMIC-QA\`）`,
    `- [${summary.calibration_summary.qualified_band ? 'x' : ' '}] 使用 \`GPT-6.1-Sol\` 或 \`Opus-5.5\`（\`reasoning_effort = max\`）干净状态独立执行 8 次标定，验证成功数落在 1–3 次（12.5% / 25% / 37.5%）`,
    `- [${summary.clean_trajectory_summary.present ? 'x' : ' '}] 采集至少 1 条 \`opus-5\` 或 \`gpt-5.6-sol\` 真实完整成功轨迹，完成 \`review/<run_id>.json\` 防 hack 审计`,
    '- [ ] 运行 `bun projects/ALE/scripts/batch-package.ts` 汇总批次清单、去重净量、`trajectory_stats.csv` 与 `SHA256SUMS.txt`，经买方冻结哈希书面确认接收',
    '',
  ].join('\n');
  await writeFile(join(resolve(outputParentDir), `交付状态与待办核验_${taskId}.md`), statusReport, { mode: 0o600 });

  const hardFailed = summary.records.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  if (hardFailed.length) {
    throw new Error(`ALE 题包质检未通过: ${hardFailed.map((r) => `${r.check_id}(${r.observed})`).join('; ')}`);
  }

  return { task_id: taskId, task_dir: taskRoot, summary };
}

/** 对接 server/publishing/project-delivery.ts 第 8 步归档协议 */
export async function deliverFromWorkbench(input: any, outputParentDir: string): Promise<void> {
  if (!input || input.acceptance?.decision !== 'accepted') {
    throw new Error('仅已达标题目允许执行归档交付');
  }
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const materials: { name: string; bytes?: Uint8Array; text?: string }[] = [];
  const { alePkg: preExtracted } = extractAlePackage(input.question);
  const declaredInputs: Array<{ path?: string; sha256?: string }> = Array.isArray(preExtracted?.task_card?.inputs)
    ? preExtracted.task_card.inputs
    : [];
  const matchedByDeclaredHash = new Set<number>();

  for (const decl of declaredInputs) {
    const relPath = String(decl?.path ?? '');
    const targetName = relPath.startsWith('environment/input/') ? basename(relPath) : '';
    if (!targetName) continue;
    const matchIdx = attachments.findIndex(
      (att: any) =>
        (typeof att?.model_sha256 === 'string' && att.model_sha256 === decl.sha256 && typeof att?.model_text === 'string') ||
        (typeof att?.sha256 === 'string' && att.sha256 === decl.sha256 && typeof att?.text === 'string'),
    );
    if (matchIdx >= 0) {
      const att = attachments[matchIdx];
      const exactText = att.model_sha256 === decl.sha256 ? att.model_text : att.text;
      materials.push({ name: targetName, text: exactText });
      matchedByDeclaredHash.add(matchIdx);
    }
  }

  for (const [idx, att] of attachments.entries()) {
    if (matchedByDeclaredHash.has(idx)) continue;
    if (Array.isArray(att.original_files) && att.original_files.length) {
      for (const orig of att.original_files) {
        const bytes = new Uint8Array(Buffer.from(orig.content_base64, 'base64'));
        if (sha256Hex(bytes) !== orig.sha256) throw new Error(`原件 SHA-256 校验不匹配: ${orig.name}`);
        materials.push({ name: orig.name, bytes });
      }
    } else if (Array.isArray(att.prepared_documents) && att.prepared_documents.length) {
      for (const [docIdx, doc] of att.prepared_documents.entries()) {
        const docBytes = await buildDocx(doc.document ?? doc.text, { pagination: 'flow' });
        materials.push({ name: `${String(docIdx + 1).padStart(2, '0')}-${doc.title || '材料'}.docx`, bytes: docBytes });
      }
    } else if (typeof att.text === 'string' && att.text.trim()) {
      const docBytes = await buildDocx(att.text, { pagination: 'flow' });
      materials.push({ name: `${att.name || `材料_${idx + 1}`}.docx`, bytes: docBytes });
    }
  }

  await materializeAleTaskFromDraft({
    draft: input.question,
    taskIdFallback: `ALE-${String(input.workflow_id || 'TASK').slice(0, 8).toUpperCase()}`,
    inputMaterials: materials,
    outputParentDir,
    executeDynamic: true,
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--from-draft')) {
    const draftPath = resolve(args[args.indexOf('--from-draft') + 1]!);
    const matDir = resolve(args[args.indexOf('--materials-dir') + 1]!);
    const outDir = resolve(args[args.indexOf('--out') + 1]!);
    const executeDynamic = args.includes('--execute');

    const draft = JSON.parse(await readFile(draftPath, 'utf8'));
    const matEntries: { name: string; bytes: Uint8Array }[] = [];
    for (const entry of (await readdir(matDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.')) continue;
      const p = join(matDir, entry.name);
      const st = await lstat(p);
      if (st.isFile()) matEntries.push({ name: entry.name, bytes: await readFile(p) });
    }
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const res = await materializeAleTaskFromDraft({
      draft,
      taskIdFallback: 'ALE-LOCAL-0001',
      inputMaterials: matEntries,
      outputParentDir: outDir,
      executeDynamic,
    });
    console.log(JSON.stringify({ task_id: res.task_id, task_dir: res.task_dir, all_required_passed: res.summary.all_required_passed }, null, 2));
  } else {
    const parent = process.env.AI_DISTILL_DELIVERY_PARENT_DIR;
    if (!parent || !isAbsolute(parent)) {
      console.error('用法: bun projects/ALE/scripts/delivery.ts --from-draft <draft.json> --materials-dir <dir> --out <dir> [--execute]');
      process.exit(1);
    }
    const stdinText = await Bun.stdin.text();
    await deliverFromWorkbench(JSON.parse(stdinText), parent);
  }
}
