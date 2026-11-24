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
import { resolveAleInputMaterials } from './docx-material';
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

export function extractAlePackage(draft: any): { alePkg: any; cleanDerivation: string } {
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

export function buildAleTaskIdFallback(workflowId: unknown): string {
  return `ALE-${String(workflowId || 'TASK').slice(0, 8).toUpperCase()}`;
}

export function validateAleTaskId(taskId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(taskId) ||
    taskId.includes('..') ||
    taskId.includes('/') ||
    taskId.includes('\\')
  ) {
    throw new Error(`task_id 格式无效: ${taskId}`);
  }
  return taskId;
}

export function resolveAleTaskIdFromDraft(
  draft: any,
  workflowId?: unknown,
  explicitFallback?: string,
): { taskId: string; alePkg: any; cleanDerivation: string } {
  const { alePkg, cleanDerivation } = extractAlePackage(draft);
  const rawId = String(alePkg?.task_card?.task_id || explicitFallback || buildAleTaskIdFallback(workflowId));
  return {
    taskId: validateAleTaskId(rawId),
    alePkg,
    cleanDerivation,
  };
}

function isIgnoredSystemEntry(name: string): boolean {
  return ALE_FORBIDDEN_FILENAMES.has(name) || name.startsWith('._');
}

async function assertNoSymlinksInDirectory(rootDir: string, realRoot: string): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(rootDir, entry.name);
    const rel = relative(realRoot, abs).split('\\').join('/');
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      throw new Error(`暂存标定目录包含禁止交付的符号链接: ${rel}`);
    }
    const resolvedEntry = await realpath(abs);
    if (resolvedEntry !== realRoot && !resolvedEntry.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`暂存标定目录路径越界: ${rel}`);
    }
    if (st.isDirectory()) {
      await assertNoSymlinksInDirectory(abs, realRoot);
    } else if (!st.isFile()) {
      throw new Error(`暂存标定目录包含不支持的非常规文件: ${rel}`);
    }
  }
}

async function copySafeRegularTree(
  srcDir: string,
  destDir: string,
  realRoot: string,
  options?: { skipBlankFinalResponse?: boolean },
): Promise<void> {
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const entries = (await readdir(srcDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (isIgnoredSystemEntry(entry.name)) continue;
    const srcAbs = join(srcDir, entry.name);
    const destAbs = join(destDir, entry.name);
    const st = await lstat(srcAbs);
    if (st.isSymbolicLink()) {
      throw new Error(`拒绝复制符号链接: ${relative(realRoot, srcAbs)}`);
    }
    const actualSrc = await realpath(srcAbs);
    if (!actualSrc.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`拒绝复制越界路径: ${relative(realRoot, srcAbs)}`);
    }
    if (st.isDirectory()) {
      await copySafeRegularTree(srcAbs, destAbs, realRoot, options);
    } else if (st.isFile()) {
      const bytes = await readFile(srcAbs);
      if (options?.skipBlankFinalResponse && entry.name === 'final_response.txt') {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (!text.trim()) continue;
        } catch {
          // 保留非 UTF-8 文件交由后续 verify-task 拦截报告
        }
      }
      const mode = (st.mode & 0o111) !== 0 ? 0o755 : 0o600;
      await writeFile(destAbs, bytes, { mode });
      await chmod(destAbs, mode);
    } else {
      throw new Error(`拒绝复制非常规文件: ${relative(realRoot, srcAbs)}`);
    }
  }
}

async function validateAndPrepareStagedDir(stagedTaskDir: string, targetTaskRoot: string): Promise<string> {
  const candidate = resolve(stagedTaskDir);
  const rootStat = await lstat(candidate);
  if (rootStat.isSymbolicLink()) {
    throw new Error('拒绝使用符号链接作为 staged 任务目录');
  }
  if (!rootStat.isDirectory()) {
    throw new Error('staged 任务路径不是有效目录');
  }
  const realStagedDir = await realpath(candidate);
  const resolvedTarget = resolve(targetTaskRoot);
  if (realStagedDir === resolvedTarget || realStagedDir.startsWith(`${resolvedTarget}${sep}`)) {
    throw new Error('staged 任务目录不能指向目标输出目录自身或其子目录');
  }
  await assertNoSymlinksInDirectory(realStagedDir, realStagedDir);
  return realStagedDir;
}

async function syncStagedCalibrationAssets(params: {
  realStagedDir: string;
  taskRoot: string;
  taskId: string;
  alePkg: any;
}): Promise<{ hasRuns: boolean; hasReview: boolean; syncedGradePy: boolean }> {
  const { realStagedDir, taskRoot, taskId, alePkg } = params;

  const stagedCardPath = join(realStagedDir, 'task_card.json');
  const hasStagedCard = await lstat(stagedCardPath)
    .then((s) => s.isFile() && !s.isSymbolicLink())
    .catch(() => false);
  if (hasStagedCard) {
    const stagedCard = JSON.parse(await readFile(stagedCardPath, 'utf8'));
    const stagedTaskId = String(stagedCard?.task_id ?? '');
    if (stagedTaskId !== taskId) {
      throw new Error(`staged 任务目录 task_id(${stagedTaskId}) 与当前草稿(${taskId})不一致`);
    }
  }

  const stagedRubricPath = join(realStagedDir, 'tests', 'rubric.json');
  const hasStagedRubric = await lstat(stagedRubricPath)
    .then((s) => s.isFile() && !s.isSymbolicLink())
    .catch(() => false);
  if (hasStagedRubric) {
    const stagedRubric = JSON.parse(await readFile(stagedRubricPath, 'utf8'));
    if (canonicalJson(stagedRubric) !== canonicalJson(alePkg.rubric_spec)) {
      throw new Error('staged 任务目录 tests/rubric.json 与当前草稿不一致，拒绝同步过期或篡改的标定资产');
    }
  }

  let syncedGradePy = false;
  const stagedGradePath = join(realStagedDir, 'tests', 'grade.py');
  const hasStagedGrade = await lstat(stagedGradePath)
    .then((s) => s.isFile() && !s.isSymbolicLink())
    .catch(() => false);
  if (hasStagedGrade) {
    const stagedGradeText = new TextDecoder('utf-8', { fatal: true })
      .decode(await readFile(stagedGradePath))
      .replace(/\r\n/g, '\n');
    const draftGradeText = String(alePkg.grade_py).replace(/\r\n/g, '\n');
    if (stagedGradeText !== draftGradeText) {
      if (!hasStagedCard || !hasStagedRubric) {
        throw new Error('同步 staged tests/grade.py 前必须同时具备匹配的 task_card.json 与 tests/rubric.json');
      }
      const destGradePath = join(taskRoot, 'tests', 'grade.py');
      await writeFile(destGradePath, stagedGradeText, { mode: 0o755 });
      await chmod(destGradePath, 0o755);
      syncedGradePy = true;
    }
  }

  let hasRuns = false;
  const stagedRunsDir = join(realStagedDir, 'runs');
  const runsStat = await lstat(stagedRunsDir).catch(() => null);
  if (runsStat) {
    if (runsStat.isSymbolicLink() || !runsStat.isDirectory()) {
      throw new Error('staged runs 路径不是有效普通目录');
    }
    hasRuns = true;
    const destRunsRoot = join(taskRoot, 'runs');
    await mkdir(destRunsRoot, { recursive: true, mode: 0o700 });
    const modelEntries = (await readdir(stagedRunsDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const modelEntry of modelEntries) {
      if (isIgnoredSystemEntry(modelEntry.name)) continue;
      const modelSrc = join(stagedRunsDir, modelEntry.name);
      const modelDest = join(destRunsRoot, modelEntry.name);
      const mStat = await lstat(modelSrc);
      if (mStat.isSymbolicLink()) throw new Error(`拒绝复制符号链接: runs/${modelEntry.name}`);
      if (mStat.isFile()) {
        const bytes = await readFile(modelSrc);
        await writeFile(modelDest, bytes, { mode: 0o600 });
        await chmod(modelDest, 0o600);
        continue;
      }
      if (!mStat.isDirectory()) continue;

      const runEntries = (await readdir(modelSrc, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      );
      for (const runEntry of runEntries) {
        if (isIgnoredSystemEntry(runEntry.name)) continue;
        const runSrc = join(modelSrc, runEntry.name);
        const runDest = join(modelDest, runEntry.name);
        const rStat = await lstat(runSrc);
        if (rStat.isSymbolicLink()) throw new Error(`拒绝复制符号链接: runs/${modelEntry.name}/${runEntry.name}`);
        if (rStat.isFile()) {
          await mkdir(modelDest, { recursive: true, mode: 0o700 });
          const bytes = await readFile(runSrc);
          await writeFile(runDest, bytes, { mode: 0o600 });
          await chmod(runDest, 0o600);
          continue;
        }
        if (!rStat.isDirectory()) continue;

        // 仅复制已落盘 run.json 的完整运行记录，忽略并发早停时未提交的半成品目录
        const hasCommittedRunJson = await lstat(join(runSrc, 'run.json'))
          .then((s) => s.isFile() && !s.isSymbolicLink())
          .catch(() => false);
        if (!hasCommittedRunJson) continue;

        await copySafeRegularTree(runSrc, runDest, realStagedDir, { skipBlankFinalResponse: true });
      }
    }
  }

  let hasReview = false;
  const stagedReviewDir = join(realStagedDir, 'review');
  const reviewStat = await lstat(stagedReviewDir).catch(() => null);
  if (reviewStat) {
    if (reviewStat.isSymbolicLink() || !reviewStat.isDirectory()) {
      throw new Error('staged review 路径不是有效普通目录');
    }
    hasReview = true;
    await copySafeRegularTree(stagedReviewDir, join(taskRoot, 'review'), realStagedDir);
  }

  return { hasRuns, hasReview, syncedGradePy };
}

async function listRegularFilesRecursive(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (cur: string): Promise<void> => {
    const entries = await readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnoredSystemEntry(entry.name)) continue;
      const abs = join(cur, entry.name);
      const st = await lstat(abs);
      if (st.isDirectory()) await walk(abs);
      else if (st.isFile()) found.push(abs);
    }
  };
  await walk(dir);
  return found;
}

async function verifySavedRunArtifactsOffline(taskRoot: string): Promise<{ calIssues: string[]; trajIssues: string[] }> {
  const runsRoot = join(taskRoot, 'runs');
  const runsStat = await lstat(runsRoot).catch(() => null);
  if (!runsStat?.isDirectory()) return { calIssues: [], trajIssues: [] };

  const calIssues: string[] = [];
  const trajIssues: string[] = [];
  const tempBase = await mkdtemp(join(tmpdir(), 'ale-regrade-audit-'));
  try {
    const sandboxTask = join(tempBase, 'task');
    await mkdir(sandboxTask, { recursive: true, mode: 0o700 });
    for (const sub of ['task_card.json', 'instruction.md', 'environment', 'tests', 'solution']) {
      const src = join(taskRoot, sub);
      const st = await lstat(src).catch(() => null);
      if (!st) continue;
      await cp(src, join(sandboxTask, sub), { recursive: true });
    }

    const modelEntries = (await readdir(runsRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const modelEntry of modelEntries) {
      if (!modelEntry.isDirectory()) continue;
      const modelDir = join(runsRoot, modelEntry.name);
      const runEntries = (await readdir(modelDir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      );
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        const runDir = join(modelDir, runEntry.name);
        const runJsonPath = join(runDir, 'run.json');
        const gradeJsonPath = join(runDir, 'grade.json');
        const [hasRunJson, hasGradeJson] = await Promise.all([
          lstat(runJsonPath)
            .then((s) => s.isFile())
            .catch(() => false),
          lstat(gradeJsonPath)
            .then((s) => s.isFile())
            .catch(() => false),
        ]);
        if (!hasRunJson || !hasGradeJson) continue;

        const runData = JSON.parse(await readFile(runJsonPath, 'utf8'));
        const gradeData = JSON.parse(await readFile(gradeJsonPath, 'utf8'));
        const runId = String(runData.run_id || runEntry.name);
        const artifactsDir = join(runDir, 'artifacts');
        const artStat = await lstat(artifactsDir).catch(() => null);
        const savedArtifactFiles = artStat?.isDirectory() ? await listRegularFilesRecursive(artifactsDir) : [];

        if (gradeData.success === true) {
          if (!artStat?.isDirectory() || savedArtifactFiles.length === 0) {
            trajIssues.push(`成功轨迹 ${modelEntry.name}/${runId} 缺少已保存的 artifacts/ 交付物，无法完成离线产物重评`);
            continue;
          }

          const reviewPath = join(taskRoot, 'review', `${runId}.json`);
          const revStat = await lstat(reviewPath).catch(() => null);
          if (revStat?.isFile()) {
            const rev = JSON.parse(await readFile(reviewPath, 'utf8'));
            if (rev?.artifact_hashes && typeof rev.artifact_hashes === 'object') {
              for (const [relPath, expectedHash] of Object.entries(rev.artifact_hashes as Record<string, unknown>)) {
                if (!isSafeRelativePath(relPath)) {
                  trajIssues.push(`review/${runId}.json 含非法产物相对路径: ${relPath}`);
                  continue;
                }
                const afPath = join(artifactsDir, relPath);
                const afStat = await lstat(afPath).catch(() => null);
                if (!afStat?.isFile() || afStat.isSymbolicLink()) {
                  trajIssues.push(`成功轨迹 ${modelEntry.name}/${runId} 缺少 review 声明的产物: ${relPath}`);
                  continue;
                }
                const actualHash = sha256Hex(await readFile(afPath));
                if (actualHash !== expectedHash) {
                  trajIssues.push(`成功轨迹 ${modelEntry.name}/${runId} 保存产物哈希与 review/${runId}.json 不匹配: ${relPath}`);
                }
              }
            }
          }

          const outPath = join(tempBase, `regrade-${modelEntry.name}-${runId}.json`);
          const proc = spawnSync(
            'python3',
            [join(sandboxTask, 'tests', 'grade.py'), '--artifacts-dir', artifactsDir, '--output', outPath],
            {
              cwd: sandboxTask,
              encoding: 'utf8',
              timeout: 120_000,
              env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
            },
          );
          let regraded: any;
          try {
            regraded = JSON.parse(await readFile(outPath, 'utf8'));
          } catch {
            regraded = undefined;
          }
          const expectedScore = typeof gradeData.normalized_score === 'number' ? gradeData.normalized_score : null;
          const actualScore = typeof regraded?.normalized_score === 'number' ? regraded.normalized_score : null;
          if (
            proc.status !== 0 ||
            !regraded ||
            regraded.success !== true ||
            regraded.key_gates_passed !== true ||
            expectedScore === null ||
            actualScore === null ||
            Math.abs(actualScore - expectedScore) > 1e-6
          ) {
            trajIssues.push(
              `成功轨迹 ${modelEntry.name}/${runId} 离线重评分不一致(saved=${expectedScore}/true, regraded=${actualScore}/${regraded?.success}, code=${proc.status})`,
            );
          }
        } else if (savedArtifactFiles.length > 0 && runData.termination_status !== 'infra_error') {
          const outPath = join(tempBase, `regrade-fail-${modelEntry.name}-${runId}.json`);
          const proc = spawnSync(
            'python3',
            [join(sandboxTask, 'tests', 'grade.py'), '--artifacts-dir', artifactsDir, '--output', outPath],
            {
              cwd: sandboxTask,
              encoding: 'utf8',
              timeout: 120_000,
              env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
            },
          );
          let regraded: any;
          try {
            regraded = JSON.parse(await readFile(outPath, 'utf8'));
          } catch {
            regraded = undefined;
          }
          if (proc.status === 0 && regraded?.success === true && regraded?.key_gates_passed === true) {
            const msg = `申报失败轨迹 ${modelEntry.name}/${runId} 在当前 grade.py 离线重评中实测通过(score=${regraded.normalized_score})，疑似重评未覆盖全量轮次`;
            if (runData.run_role === 'calibration_8x') calIssues.push(msg);
            else trajIssues.push(msg);
          }
        }
      }
    }
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
  return { calIssues, trajIssues };
}

export async function materializeAleTaskFromDraft(options: {
  draft: any;
  taskIdFallback: string;
  inputMaterials: { name: string; bytes?: Uint8Array; text?: string }[];
  outputParentDir: string;
  executeDynamic?: boolean;
  stagedTaskDir?: string;
}) {
  const { draft, inputMaterials, outputParentDir } = options;
  const { taskId, alePkg, cleanDerivation } = resolveAleTaskIdFromDraft(draft, undefined, options.taskIdFallback);
  const taskCard = alePkg.task_card;

  const taskRoot = join(resolve(outputParentDir), 'tasks', taskId);
  const realStagedDir = options.stagedTaskDir
    ? await validateAndPrepareStagedDir(options.stagedTaskDir, taskRoot)
    : undefined;

  await rm(taskRoot, { recursive: true, force: true });
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

  // 4.5 若提供了 staged 任务目录，安全校验并同步 runs/、review/ 及同契约复评后的 tests/grade.py
  let hasRuns = false;
  if (realStagedDir) {
    const synced = await syncStagedCalibrationAssets({
      realStagedDir,
      taskRoot,
      taskId,
      alePkg,
    });
    hasRuns = synced.hasRuns || synced.hasReview;
  }

  // 5. 运行 verify-task 及全量成功轨迹保存产物离线重评，生成诚实质检记录与待办报告
  const effectiveExecuteDynamic = Boolean(options.executeDynamic || realStagedDir);
  const summary = await verifyTaskDirectory(taskRoot, {
    executeDynamic: effectiveExecuteDynamic,
    requireRuns: hasRuns,
  });

  if (effectiveExecuteDynamic && hasRuns) {
    const { calIssues, trajIssues } = await verifySavedRunArtifactsOffline(taskRoot);
    if (calIssues.length > 0) {
      const chk06 = summary.records.find((r) => r.check_id === 'CHK-06-CALIBRATION-8X');
      if (chk06) {
        chk06.observed = chk06.status === 'PASS' ? calIssues.join('; ') : `${chk06.observed}; ${calIssues.join('; ')}`;
        chk06.status = 'FAIL';
      }
      summary.calibration_summary.qualified_band = false;
      summary.all_required_passed = false;
    }
    if (trajIssues.length > 0) {
      const chk07 = summary.records.find((r) => r.check_id === 'CHK-07-CLEAN-TRAJECTORY');
      if (chk07) {
        chk07.observed = chk07.status === 'PASS' ? trajIssues.join('; ') : `${chk07.observed}; ${trajIssues.join('; ')}`;
        chk07.status = 'FAIL';
      }
      summary.all_required_passed = false;
    }
  }

  const checkRecordsPath = join(resolve(outputParentDir), `check_records_${taskId}.json`);
  await writeFile(checkRecordsPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });

  const chk05Passed = summary.records.find((r) => r.check_id === 'CHK-05-DYNAMIC-QA')?.status === 'PASS';
  const chk06Passed = summary.records.find((r) => r.check_id === 'CHK-06-CALIBRATION-8X')?.status === 'PASS';
  const chk07Passed = summary.records.find((r) => r.check_id === 'CHK-07-CLEAN-TRAJECTORY')?.status === 'PASS';

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
    `- [${effectiveExecuteDynamic && chk05Passed ? 'x' : ' '}] 在目标声明容器/VM 环境执行参考基线、\`no-op\`、等价解与单因子反例动态测试（\`CHK-05-DYNAMIC-QA\`）`,
    `- [${summary.calibration_summary.qualified_band && chk06Passed ? 'x' : ' '}] 使用 \`GPT-6.1-Sol\` 或 \`Opus-5.5\`（\`reasoning_effort = max\`）干净状态独立执行 8 次标定，验证成功数落在 1–3 次（12.5% / 25% / 37.5%）`,
    `- [${summary.clean_trajectory_summary.present && chk07Passed ? 'x' : ' '}] 采集至少 1 条 \`opus-5\` 或 \`gpt-5.6-sol\` 真实完整成功轨迹，完成 \`review/<run_id>.json\` 防 hack 审计与离线产物重评`,
    '- [ ] 运行 `bun projects/ALE/scripts/batch-package.ts` 汇总批次清单、去重净量、`trajectory_stats.csv` 与 `SHA256SUMS.txt`，经买方冻结哈希书面确认接收',
    '',
  ].join('\n');
  await writeFile(join(resolve(outputParentDir), `交付状态与待办核验_${taskId}.md`), statusReport, { mode: 0o600 });

  const hardFailed = summary.records.filter(
    (r) => r.status === 'FAIL' || r.status === 'ERROR' || (hasRuns && r.status === 'SKIP'),
  );
  if (hardFailed.length) {
    throw new Error(`ALE 题包质检未通过: ${hardFailed.map((r) => `${r.check_id}(${r.observed})`).join('; ')}`);
  }

  return { task_id: taskId, task_dir: taskRoot, summary };
}

/** 对接 server/publishing/project-delivery.ts 第 8 步归档协议 */
export async function deliverFromWorkbench(input: AleDeliveryInput | any, outputParentDir: string): Promise<void> {
  if (!input || input.acceptance?.decision !== 'accepted') {
    throw new Error('仅已达标题目允许执行归档交付');
  }
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const { taskId, alePkg: preExtracted } = resolveAleTaskIdFromDraft(input.question, input.workflow_id);
  const declaredInputs: Array<{ path?: string; sha256?: string }> = Array.isArray(preExtracted?.task_card?.inputs)
    ? preExtracted.task_card.inputs
    : [];
  const materials = await resolveAleInputMaterials(declaredInputs, attachments);

  let stagedTaskDir: string | undefined;
  if (input.ale_staged !== undefined && input.ale_staged !== null) {
    if (typeof input.ale_staged !== 'object') {
      throw new Error('ale_staged 绑定格式无效');
    }
    if (String(input.ale_staged.task_id ?? '') !== taskId) {
      throw new Error(`ale_staged.task_id(${input.ale_staged.task_id}) 与当前草稿 task_id(${taskId})不一致`);
    }
    if (typeof input.ale_staged.staged_task_dir !== 'string' || !isAbsolute(input.ale_staged.staged_task_dir)) {
      throw new Error('ale_staged.staged_task_dir 必须为已校验绝对路径');
    }
    stagedTaskDir = input.ale_staged.staged_task_dir;
  }

  await materializeAleTaskFromDraft({
    draft: input.question,
    taskIdFallback: buildAleTaskIdFallback(input.workflow_id),
    inputMaterials: materials,
    outputParentDir,
    executeDynamic: true,
    stagedTaskDir,
  });
}

function readRequiredFlagValue(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  const val = idx >= 0 ? args[idx + 1] : undefined;
  if (!val || val.startsWith('--')) {
    throw new Error(`参数 ${flag} 缺少路径值`);
  }
  return val;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--from-draft')) {
    const draftPath = resolve(readRequiredFlagValue(args, '--from-draft'));
    const matDir = resolve(readRequiredFlagValue(args, '--materials-dir'));
    const outDir = resolve(readRequiredFlagValue(args, '--out'));
    const stagedTaskDir = args.includes('--staged-task-dir')
      ? resolve(readRequiredFlagValue(args, '--staged-task-dir'))
      : undefined;
    const executeDynamic = args.includes('--execute') || Boolean(stagedTaskDir);

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
      stagedTaskDir,
    });
    console.log(JSON.stringify({ task_id: res.task_id, task_dir: res.task_dir, all_required_passed: res.summary.all_required_passed }, null, 2));
  } else {
    const parent = process.env.AI_DISTILL_DELIVERY_PARENT_DIR;
    if (!parent || !isAbsolute(parent)) {
      console.error('用法: bun projects/ALE/scripts/delivery.ts --from-draft <draft.json> --materials-dir <dir> --out <dir> [--staged-task-dir <dir>] [--execute]');
      process.exit(1);
    }
    const stdinText = await Bun.stdin.text();
    await deliverFromWorkbench(JSON.parse(stdinText), parent);
  }
}
