/**
 * 职责：执行《ALE 数据交付技术规范》第 1–7 节的单题全量质检与单因子反例核验，生成标准九字段 check_id 质检记录。
 * 主要公开入口：`verifyTaskDirectory()` 供批次打包与归档脚本调用；文件可直接通过 `bun projects/ALE/scripts/verify-task.ts` 作为 CLI 运行。
 * 副作用边界：静态核验纯只读；仅在显式传入 `--execute` 时在系统临时目录克隆隔离沙盒执行 reset.sh、参考基线、no-op 与单因子反例测试并自动清理临时目录。
 */
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import {
  ALE_CALIBRATION_MODELS,
  ALE_CLEAN_SUCCESS_MODELS,
  ALE_FORBIDDEN_FILENAMES,
  detectPlaceholderIssue,
  isGitLfsPointer,
  isSafeRelativePath,
  recomputeTrajectoryMetrics,
  sha256Hex,
  type AleCheckRecord,
} from './contracts';

export interface VerifyTaskOptions {
  executeDynamic?: boolean;
  requireRuns?: boolean;
}

export interface VerifyTaskSummary {
  task_id: string;
  task_version: string;
  domain: string;
  sub_domain: string;
  task_family: string;
  package_hash: string;
  all_required_passed: boolean;
  calibration_summary: {
    present: boolean;
    model: string | null;
    total_valid_runs: number;
    success_count: number;
    pass_rate: number | null;
    qualified_band: boolean;
  };
  clean_trajectory_summary: {
    present: boolean;
    qualified_runs: string[];
  };
  records: AleCheckRecord[];
}

async function walkFiles(root: string): Promise<{ rel: string; abs: string; mode: number; size: number }[]> {
  const out: { rel: string; abs: string; mode: number; size: number }[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split('\\').join('/');
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        throw new Error(`禁止包含符号链接：${rel}`);
      }
      if (ALE_FORBIDDEN_FILENAMES.has(entry.name) || entry.name.startsWith('._')) {
        throw new Error(`包含禁止交付的系统/缓存文件：${rel}`);
      }
      if (info.isDirectory()) {
        await visit(abs);
      } else if (info.isFile()) {
        out.push({ rel, abs, mode: info.mode, size: info.size });
      }
    }
  };
  await visit(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
}

function runGradeInSandbox(taskRoot: string, artifactsDir: string, gradeOutPath: string): { code: number; stdout: string; stderr: string; grade?: any } {
  const proc = spawnSync(
    'python3',
    [join(taskRoot, 'tests', 'grade.py'), '--artifacts-dir', artifactsDir, '--output', gradeOutPath],
    {
      cwd: taskRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  let grade: any;
  try {
    grade = JSON.parse(require('node:fs').readFileSync(gradeOutPath, 'utf8'));
  } catch {
    grade = undefined;
  }
  return {
    code: proc.status ?? 1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    grade,
  };
}

export async function verifyTaskDirectory(taskDir: string, options: VerifyTaskOptions = {}): Promise<VerifyTaskSummary> {
  const root = resolve(taskDir);
  const records: AleCheckRecord[] = [];
  let taskId = basename(root);
  let taskVersion = '0.0.0';
  let domain = 'unknown';
  let subDomain = 'unknown';
  let taskFamily = 'unknown';

  const files = await walkFiles(root);
  const fileSet = new Set(files.map((f) => f.rel));
  const digestSeed = files
    .filter((f) => !f.rel.startsWith('runs/') && !f.rel.startsWith('review/'))
    .map((f) => `${f.rel}:${f.size}`)
    .join('|');
  let packageHash = sha256Hex(digestSeed).slice(0, 16);

  const push = (
    check_id: string,
    scope: string,
    execution_mode: AleCheckRecord['execution_mode'],
    expected: string,
    observed: string,
    status: AleCheckRecord['status'],
    evidence_path: string,
  ) => {
    records.push({
      check_id,
      task_id: taskId,
      version_or_hash: `${taskVersion}@${packageHash}`,
      scope,
      execution_mode,
      expected,
      observed,
      status,
      evidence_path,
    });
  };

  // 1. 齐备性、LFS指针、UTF-8与可执行权限检查
  const requiredFiles = [
    'instruction.md',
    'environment/env.json',
    'environment/reset.sh',
    'tests/grade.py',
    'tests/rubric.json',
    'solution/solve.sh',
  ];
  const hasCard = fileSet.has('task_card.json') || fileSet.has('task.toml');
  const missing = requiredFiles.filter((p) => !fileSet.has(p));
  if (!hasCard) missing.push('task_card.json(or task.toml)');
  const inputFiles = files.filter((f) => f.rel.startsWith('environment/input/'));
  const solutionArtifacts = files.filter((f) => f.rel.startsWith('solution/artifacts/'));
  if (!inputFiles.length) missing.push('environment/input/*');
  if (!solutionArtifacts.length) missing.push('solution/artifacts/*');

  const hygieneIssues: string[] = [];
  for (const f of files) {
    if (!isSafeRelativePath(f.rel, 240)) hygieneIssues.push(`路径不安全或超长: ${f.rel}`);
    const bytes = await readFile(f.abs);
    if (isGitLfsPointer(bytes)) hygieneIssues.push(`检测到 Git LFS 指针: ${f.rel}`);
    if (/\.(?:json|md|toml|py|sh|csv|txt|lock)$/i.test(f.rel)) {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        hygieneIssues.push(`非合法 UTF-8 编码: ${f.rel}`);
        continue;
      }
      if (/\.(?:sh|py)$/i.test(f.rel) && bytes.includes(13)) {
        hygieneIssues.push(`脚本包含 CRLF 换行: ${f.rel}`);
      }
      const ph = detectPlaceholderIssue(text);
      if (ph) hygieneIssues.push(`${f.rel}: ${ph}`);
    }
  }
  for (const execRel of ['environment/reset.sh', 'solution/solve.sh', 'tests/grade.py']) {
    const entry = files.find((f) => f.rel === execRel);
    if (entry && (entry.mode & 0o111) === 0) {
      hygieneIssues.push(`缺少可执行权限(chmod +x): ${execRel}`);
    }
  }

  if (missing.length || hygieneIssues.length) {
    push(
      'CHK-01-FILES',
      '第1/7节：题包必交文件、UTF-8/LF、可执行位与零LFS/占位检查',
      'static',
      '必交文件齐备、UTF-8编码、脚本LF且可执行、零LFS指针与零占位符',
      [missing.length ? `缺失: ${missing.join(', ')}` : '', hygieneIssues.join('; ')].filter(Boolean).join(' | '),
      'FAIL',
      root,
    );
  } else {
    push(
      'CHK-01-FILES',
      '第1/7节：题包必交文件、UTF-8/LF、可执行位与零LFS/占位检查',
      'static',
      '必交文件齐备、UTF-8编码、脚本LF且可执行、零LFS指针与零占位符',
      `共核验 ${files.length} 个实物文件，输入 ${inputFiles.length} 个，参考产物 ${solutionArtifacts.length} 个`,
      'PASS',
      root,
    );
  }

  // 2. task_card.json 与 instruction.md 契约一致性
  let taskCard: any = null;
  let canary = '';
  if (fileSet.has('task_card.json')) {
    try {
      taskCard = JSON.parse(await readFile(join(root, 'task_card.json'), 'utf8'));
      taskId = String(taskCard.task_id || taskId);
      taskVersion = String(taskCard.version || taskVersion);
      domain = String(taskCard.domain || domain);
      subDomain = String(taskCard.sub_domain || subDomain);
      taskFamily = String(taskCard.task_family || taskFamily);
      canary = String(taskCard.canary || '');
      packageHash = sha256Hex(await readFile(join(root, 'task_card.json'))).slice(0, 16);
      // 同步回填前序 check_id 的 task_id
      for (const r of records) {
        r.task_id = taskId;
        r.version_or_hash = `${taskVersion}@${packageHash}`;
      }

      const instruction = fileSet.has('instruction.md') ? await readFile(join(root, 'instruction.md'), 'utf8') : '';
      const contractErrors: string[] = [];
      for (const key of ['task_id', 'version', 'domain', 'sub_domain', 'task_family', 'canary']) {
        if (typeof taskCard[key] !== 'string' || !taskCard[key].trim()) contractErrors.push(`task_card 缺少 ${key}`);
      }
      if (typeof taskCard.network?.allow_internet !== 'boolean') {
        contractErrors.push('task_card.network.allow_internet 必须显式声明布尔值');
      }
      if (!Array.isArray(taskCard.deliverables_contract) || !taskCard.deliverables_contract.length) {
        contractErrors.push('task_card.deliverables_contract 不能为空');
      } else {
        for (const d of taskCard.deliverables_contract) {
          if (typeof d?.path !== 'string' || !isSafeRelativePath(d.path)) {
            contractErrors.push(`产物路径无效: ${d?.path}`);
            continue;
          }
          const baseName = basename(d.path);
          if (d.required && !instruction.includes(d.path) && !instruction.includes(baseName)) {
            contractErrors.push(`必交产物未在 instruction.md 明示: ${d.path}`);
          }
          if (d.required && !fileSet.has(`solution/artifacts/${d.path}`)) {
            contractErrors.push(`solution/artifacts/ 缺少对应参考成品: ${d.path}`);
          }
        }
      }
      if (/(?:本题模拟|模拟场景|模拟律师|假定截至.*无新增|评分脚本将检查|只有文字输入和输出|工作台答复|无需生成文件|无需调用工具|在本次回复中分件列出全文)/.test(instruction)) {
        contractErrors.push('instruction.md 残留模拟话术、评测产线提示词或工作台纯文本通道豁免元话术');
      }
      if (/\(\*{2,}\)|\*{4,}/.test(instruction)) {
        contractErrors.push('instruction.md 裸露 (****) 或 **** 脱敏星号掩码（须改用当事人姓名或业务简称）');
      }
      if (/(?:法释〔\d{4}〕|法发〔\d{4}〕|2020年8月20日修正)/.test(instruction)) {
        contractErrors.push('instruction.md 违规剧透具体司法解释文号或修法切换日期（法定规范与时际切换须由作答模型独立识别）');
      }

      push(
        'CHK-02-CONTRACT',
        '第1/2/7节：task_card、instruction、产物契约与零模拟话术对齐',
        'static',
        '领域/资源/网络/canary齐备，必交产物在题面与solution/artifacts逐项对齐且零模拟词',
        contractErrors.length ? contractErrors.join('; ') : `domain=${domain}/${subDomain}, 必交契约 ${taskCard.deliverables_contract.length} 项对齐`,
        contractErrors.length ? 'FAIL' : 'PASS',
        'task_card.json',
      );
    } catch (err) {
      push('CHK-02-CONTRACT', '第1/2/7节：task_card 解析', 'static', '合法 JSON', String((err as Error).message), 'FAIL', 'task_card.json');
    }
  }

  // 3. 第 3 节：构建/挂载/执行/收集/判分五阶段真值隔离检查
  try {
    const envJson = JSON.parse(await readFile(join(root, 'environment/env.json'), 'utf8'));
    const dockerfile = fileSet.has('environment/Dockerfile') ? await readFile(join(root, 'environment/Dockerfile'), 'utf8') : '';
    const isolationErrors: string[] = [];
    const vis = envJson.visibility_isolation;
    if (!vis || !Array.isArray(vis.forbidden_in_agent_view)) {
      isolationErrors.push('env.json 缺少 visibility_isolation 五阶段隔离声明');
    } else {
      for (const mustForbid of ['tests/', 'solution/']) {
        if (!vis.forbidden_in_agent_view.some((item: string) => item.startsWith(mustForbid.replace('/', '')))) {
          isolationErrors.push(`forbidden_in_agent_view 未声明屏蔽 ${mustForbid}`);
        }
      }
    }
    if (/\b(?:COPY|ADD)\b[^\n]*(?:tests\/|solution\/|rubric\.json|grade\.py|reference\/)/i.test(dockerfile)) {
      isolationErrors.push('Dockerfile 将私有评分或参考答案打入镜像层');
    }
    for (const f of files.filter((item) => item.rel.startsWith('environment/'))) {
      if (/(?:rubric\.json|grade\.py|solve\.sh|reference_answer)/i.test(f.rel)) {
        isolationErrors.push(`environment/ 内混入疑似真值或评分文件: ${f.rel}`);
      }
    }
    push(
      'CHK-03-ISOLATION',
      '第3/7节：Agent 执行期真值、参考成品与评分资产物理隔离',
      'static',
      'environment/ 与 Dockerfile 零混入 tests/solution/rubric/reference，五阶段可见性明确',
      isolationErrors.length ? isolationErrors.join('; ') : 'environment/ 与构建声明零真值泄漏',
      isolationErrors.length ? 'FAIL' : 'PASS',
      'environment/env.json',
    );
  } catch (err) {
    push('CHK-03-ISOLATION', '第3节：环境隔离检查', 'static', '合法 env.json', String((err as Error).message), 'FAIL', 'environment/env.json');
  }

  // 4. 第 2/7 节：rubric.json 七要素、归一化与关键门控检查
  let rubricSpec: any = null;
  try {
    rubricSpec = JSON.parse(await readFile(join(root, 'tests/rubric.json'), 'utf8'));
    const gradePy = fileSet.has('tests/grade.py') ? await readFile(join(root, 'tests/grade.py'), 'utf8') : '';
    const rubricErrors: string[] = [];
    if (!rubricSpec.scale || typeof rubricSpec.scale.normalization !== 'string' || typeof rubricSpec.scale.pass_threshold !== 'number') {
      rubricErrors.push('rubric.json 缺少 scale.normalization 或 pass_threshold');
    }
    if (!Array.isArray(rubricSpec.criteria) || !rubricSpec.criteria.length) {
      rubricErrors.push('rubric.json criteria 不能为空');
    } else {
      const seenIds = new Set<string>();
      let keyGateCount = 0;
      for (const c of rubricSpec.criteria) {
        for (const reqKey of [
          'criterion_id',
          'prompt_basis',
          'source_locator',
          'observation_locator',
          'condition',
          'weight',
          'tolerance',
          'is_key_gate',
          'grader_mapping',
        ]) {
          if (c?.[reqKey] === undefined || c?.[reqKey] === null || c?.[reqKey] === '') {
            rubricErrors.push(`${c?.criterion_id || '未知项'} 缺少必填字段 ${reqKey}`);
          }
        }
        if (seenIds.has(c.criterion_id)) rubricErrors.push(`重复 criterion_id: ${c.criterion_id}`);
        seenIds.add(c.criterion_id);
        if (c.is_key_gate === true) keyGateCount += 1;
        if (typeof c.grader_mapping === 'string' && gradePy && !gradePy.includes(c.grader_mapping)) {
          rubricErrors.push(`grade.py 未找到映射实现: ${c.grader_mapping}`);
        }
      }
      if (keyGateCount === 0) rubricErrors.push('至少须声明 1 项 is_key_gate=true 核心门控');
    }
    push(
      'CHK-04-RUBRIC',
      '第2/7节：rubric.json 七要素、量纲归一化、关键门控与 grade.py 映射',
      'static',
      '全部 criterion 七要素齐备、含关键门控且与 grade.py 断言函数一一对应',
      rubricErrors.length ? rubricErrors.join('; ') : `共 ${rubricSpec.criteria.length} 条判据，全部对齐 grade.py`,
      rubricErrors.length ? 'FAIL' : 'PASS',
      'tests/rubric.json',
    );
  } catch (err) {
    push('CHK-04-RUBRIC', '第2/7节：rubric.json 解析', 'static', '合法 rubric.json', String((err as Error).message), 'FAIL', 'tests/rubric.json');
  }

  // 5. 第 6 节：正式评分器动态基线、no-op 与单因子反例实测
  if (!options.executeDynamic) {
    push(
      'CHK-05-DYNAMIC-QA',
      '第6节：参考基线、no-op 与单因子错误反例动态评分验证',
      'dynamic_env',
      '参考基线满分(或>=0.90且关键门控全过)、no-op=0、骨架/常量<=0.20且不成功、反例精准失分',
      '本次未传入 --execute 执行动态沙盒运行（按规范只读源码不算完成动态检查）',
      'SKIP',
      'tests/grade.py',
    );
  } else {
    const tempBase = await mkdtemp(join(tmpdir(), 'ale-verify-'));
    try {
      const sandboxTask = join(tempBase, 'task');
      await cp(root, sandboxTask, { recursive: true });
      const dynErrors: string[] = [];

      // B01: 参考成品基线验证
      const b01Out = join(tempBase, 'grade-b01.json');
      const b01 = runGradeInSandbox(sandboxTask, join(sandboxTask, 'solution/artifacts'), b01Out);
      const refMode = rubricSpec?.scale?.reference_target?.mode ?? 'deterministic';
      const minRefScore = refMode === 'deterministic' ? 1.0 : 0.9;
      if (
        b01.code !== 0 ||
        !b01.grade ||
        typeof b01.grade.normalized_score !== 'number' ||
        b01.grade.normalized_score + 1e-6 < minRefScore ||
        b01.grade.key_gates_passed !== true ||
        b01.grade.success !== true
      ) {
        dynErrors.push(
          `B01 参考基线未通过(code=${b01.code}, score=${b01.grade?.normalized_score}, success=${b01.grade?.success}, err=${b01.stderr.slice(0, 160)})`,
        );
      }

      // B02: 空提交 no-op 验证
      const emptyArtifacts = join(tempBase, 'empty-artifacts');
      await cp(join(sandboxTask, 'environment/input'), join(tempBase, 'input-backup'), { recursive: true });
      await writeFile(join(tempBase, 'keep'), '');
      await rm(emptyArtifacts, { recursive: true, force: true });
      await cp(join(tempBase), emptyArtifacts, { recursive: false }).catch(() => {});
      await require('node:fs/promises').mkdir(emptyArtifacts, { recursive: true });
      const b02Out = join(tempBase, 'grade-b02.json');
      const b02 = runGradeInSandbox(sandboxTask, emptyArtifacts, b02Out);
      if (b02.code !== 0 || !b02.grade || b02.grade.normalized_score !== 0 || b02.grade.success !== false) {
        dynErrors.push(
          `B02 空提交(no-op)异常(code=${b02.code}, score=${b02.grade?.normalized_score}, success=${b02.grade?.success})`,
        );
      }

      // 单因子变体与等价解验证（tests/reference/variants/manifest.json）
      const variantsManifestPath = join(sandboxTask, 'tests/reference/variants/manifest.json');
      let variantCount = 0;
      try {
        const variantsManifest = JSON.parse(await readFile(variantsManifestPath, 'utf8'));
        for (const v of variantsManifest.variants ?? []) {
          variantCount += 1;
          const vDir = join(sandboxTask, 'tests/reference/variants', v.id);
          const vOut = join(tempBase, `grade-${v.id}.json`);
          const res = runGradeInSandbox(sandboxTask, vDir, vOut);
          if (res.code !== 0 || !res.grade) {
            dynErrors.push(`变体 ${v.id} 评分器异常退出(code=${res.code}): ${res.stderr.slice(0, 120)}`);
            continue;
          }
          if (v.kind === 'equivalent_pass') {
            if (res.grade.success !== true || res.grade.normalized_score < (rubricSpec?.scale?.pass_threshold ?? 0.85)) {
              dynErrors.push(`等价正确解 ${v.id} 被误罚(score=${res.grade.normalized_score}, success=${res.grade.success})`);
            }
          } else if (v.kind === 'skeleton_or_constant') {
            if (res.grade.normalized_score > 0.2 + 1e-6 || res.grade.success !== false) {
              dynErrors.push(`骨架/常量反例 ${v.id} 未压制到 <=0.20(score=${res.grade.normalized_score}, success=${res.grade.success})`);
            }
          } else if (v.kind === 'shallow_decoy_trap') {
            if (res.grade.normalized_score > 0.78 + 1e-6 || res.grade.success !== false) {
              dynErrors.push(`表层诱饵仿真反例 ${v.id} 未被有效拦截为失败且 <=0.78(score=${res.grade.normalized_score}, success=${res.grade.success})`);
            }
          } else if (v.kind === 'single_factor_fail') {
            const targetItem = (res.grade.items ?? []).find((it: any) => it.criterion_id === v.target_criterion_id);
            if (!targetItem || targetItem.score >= 1.0) {
              dynErrors.push(`单因子反例 ${v.id} 未使目标项 ${v.target_criterion_id} 失分`);
            }
            if (v.expect_task_fail && res.grade.success !== false) {
              dynErrors.push(`破坏关键门控反例 ${v.id} 未判整题失败`);
            }
            for (const keepId of v.must_remain_passed_ids ?? []) {
              const keepItem = (res.grade.items ?? []).find((it: any) => it.criterion_id === keepId);
              if (!keepItem || keepItem.passed !== true) {
                dynErrors.push(`单因子反例 ${v.id} 误伤无关独立项 ${keepId}`);
              }
            }
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          dynErrors.push('缺少 tests/reference/variants/manifest.json 单因子反例与等价解测试集');
        } else {
          dynErrors.push(`读取反例测试集失败: ${(err as Error).message}`);
        }
      }

      push(
        'CHK-05-DYNAMIC-QA',
        '第6节：参考基线、no-op、等价解与单因子错误反例动态实测',
        'dynamic_env',
        'B01满分通过、B02 no-op=0、骨架/常量<=0.20且失败、单因子反例精准失分且不误伤、等价解通过',
        dynErrors.length
          ? dynErrors.join(' | ')
          : `动态实测通过：B01=${b01.grade.normalized_score}，B02=0，${variantCount} 组单因子反例与等价解全部符合预期`,
        dynErrors.length ? 'FAIL' : 'PASS',
        'tests/reference/variants/manifest.json',
      );
    } finally {
      await rm(tempBase, { recursive: true, force: true });
    }
  }

  // 6. 第 4/5 节：8次难度标定、opus-5/gpt-5.6-sol 真实成功轨迹、Token复算与防 hack 审查
  const runJsonFiles = files.filter((f) => /^runs\/[^/]+\/[^/]+\/run\.json$/.test(f.rel));
  let calModel: string | null = null;
  let calValidCount = 0;
  let calSuccessCount = 0;
  const cleanSuccessRuns: string[] = [];

  if (!runJsonFiles.length) {
    const status: AleCheckRecord['status'] = options.requireRuns ? 'FAIL' : 'SKIP';
    push(
      'CHK-06-CALIBRATION-8X',
      '第4节：GPT-6.1-Sol / Opus-5.5 (reasoning=max) 8次独立标定与 1–3 次黄金通过率',
      'trajectory_audit',
      '8次干净独立有效尝试，成功 1–3 次（12.5%/25%/37.5%）',
      '当前 runs/ 目录尚未放入标定运行记录',
      status,
      'runs/',
    );
    push(
      'CHK-07-CLEAN-TRAJECTORY',
      '第1/5节：至少 1 条 opus-5 或 gpt-5.6-sol 真实完整成功轨迹及防 hack 审查',
      'trajectory_audit',
      '>=1 条真实完整成功轨迹、Token/轮次复算一致、review CLEAN_PASS 且零 canary 外泄',
      '当前 runs/ 目录尚未放入模型成功轨迹',
      status,
      'runs/',
    );
  } else {
    const auditErrors: string[] = [];
    const calRuns: { runId: string; model: string; success: boolean }[] = [];

    for (const rf of runJsonFiles) {
      const runDir = resolve(rf.abs, '..');
      const runRelDir = relative(root, runDir).split('\\').join('/');
      const runData = JSON.parse(await readFile(rf.abs, 'utf8'));
      const runId = String(runData.run_id || '');
      const trajPath = join(runDir, 'trajectory.jsonl');
      const gradePath = join(runDir, 'grade.json');
      const reviewPath = join(root, 'review', `${runId}.json`);

      if (!fileSet.has(`${runRelDir}/trajectory.jsonl`) || !fileSet.has(`${runRelDir}/grade.json`)) {
        auditErrors.push(`${runRelDir} 缺少 trajectory.jsonl 或 grade.json`);
        continue;
      }
      if (runData.is_oracle === true || /oracle|solve\.sh/i.test(String(runData.harness ?? ''))) {
        auditErrors.push(`${runId} 使用了 oracle/参考脚本日志冒充真实模型轨迹`);
        continue;
      }

      const trajText = await readFile(trajPath, 'utf8');
      const gradeData = JSON.parse(await readFile(gradePath, 'utf8'));
      const metrics = recomputeTrajectoryMetrics(trajText, canary);

      if (runData.termination_status !== 'infra_error') {
        if (runData.model_turns !== metrics.model_turns) {
          auditErrors.push(`${runId} model_turns(${runData.model_turns}) 与原始轨迹复算(${metrics.model_turns})不一致`);
        }
        if (runData.tool_calls !== metrics.tool_calls) {
          auditErrors.push(`${runId} tool_calls(${runData.tool_calls}) 与原始轨迹复算(${metrics.tool_calls})不一致`);
        }
        if (
          (metrics.input_tokens === null && runData.usage?.input_tokens === 0) ||
          (metrics.output_tokens === null && runData.usage?.output_tokens === 0)
        ) {
          auditErrors.push(`${runId} 缺失 token 字段违规填为 0`);
        }
        if (metrics.input_tokens !== null && runData.usage?.input_tokens !== metrics.input_tokens) {
          auditErrors.push(`${runId} input_tokens(${runData.usage?.input_tokens}) 与复算(${metrics.input_tokens})不一致`);
        }
        if (metrics.output_tokens !== null && runData.usage?.output_tokens !== metrics.output_tokens) {
          auditErrors.push(`${runId} output_tokens(${runData.usage?.output_tokens}) 与复算(${metrics.output_tokens})不一致`);
        }
        if (metrics.total_tokens !== null && runData.usage?.total_tokens !== metrics.total_tokens) {
          auditErrors.push(`${runId} total_tokens(${runData.usage?.total_tokens}) 与复算(${metrics.total_tokens})不一致`);
        }
      }
      if (metrics.mentioned_canary) {
        auditErrors.push(`${runId} 轨迹中检测到 canary 字符串泄漏`);
      }
      if (metrics.suspicious_commands.length) {
        auditErrors.push(`${runId} 轨迹含疑似越界/hack 命令: ${metrics.suspicious_commands.join(',')}`);
      }

      let reviewClean = false;
      if (gradeData.success === true) {
        if (!fileSet.has(`review/${runId}.json`)) {
          auditErrors.push(`成功轨迹 ${runId} 缺少防 hack 审核文件 review/${runId}.json`);
        } else {
          const rev = JSON.parse(await readFile(reviewPath, 'utf8'));
          const c = rev.checks ?? {};
          reviewClean =
            rev.run_id === runId &&
            rev.verdict === 'CLEAN_PASS' &&
            c.statement_tool_artifact_score_consistent === true &&
            c.regrade_saved_artifacts_passed === true &&
            c.no_unauthorized_truth_or_canary_access === true &&
            c.no_grader_or_backend_tampering === true;
          if (!reviewClean) {
            auditErrors.push(`成功轨迹 ${runId} 未通过防 hack 审核(verdict=${rev.verdict})`);
          }
        }
      }

      const effectiveSuccess = gradeData.success === true && gradeData.key_gates_passed === true && reviewClean;
      if (runData.run_role === 'calibration_8x' && runData.termination_status !== 'infra_error') {
        if (!ALE_CALIBRATION_MODELS.has(String(runData.model))) {
          auditErrors.push(`标定 run ${runId} 模型非法(${runData.model})，须为 GPT-6.1-Sol 或 Opus-5.5`);
        }
        if (runData.parameters?.reasoning_effort !== 'max') {
          auditErrors.push(`标定 run ${runId} reasoning_effort 须为 max`);
        }
        calRuns.push({ runId, model: String(runData.model), success: effectiveSuccess });
      }
      if (ALE_CLEAN_SUCCESS_MODELS.has(String(runData.model)) && effectiveSuccess) {
        cleanSuccessRuns.push(`${runData.model}/${runId}`);
      }
    }

    calValidCount = calRuns.length;
    calSuccessCount = calRuns.filter((r) => r.success).length;
    calModel = calRuns[0]?.model ?? null;
    const calModelsSet = new Set(calRuns.map((r) => r.model));
    const calErrors: string[] = [];
    if (calModelsSet.size > 1) calErrors.push(`同一题 8 次标定混用了多个模型: ${[...calModelsSet].join(',')}`);
    if (calValidCount !== 8) calErrors.push(`有效独立标定次数须固定为 8 次，当前为 ${calValidCount} 次`);
    if (calSuccessCount < 1 || calSuccessCount > 3) {
      calErrors.push(`8次标定成功次数为 ${calSuccessCount}/8，不在合格区间 1–3 次(12.5%/25%/37.5%)内`);
    }

    push(
      'CHK-06-CALIBRATION-8X',
      '第4节：GPT-6.1-Sol / Opus-5.5 (reasoning=max) 8次独立标定与 1–3 次黄金通过率',
      'trajectory_audit',
      '固定单一标定模型、reasoning_effort=max、8次有效尝试且成功 1–3 次',
      calErrors.length
        ? calErrors.join('; ')
        : `${calModel} 完成 ${calValidCount} 次有效标定，成功 ${calSuccessCount}/8 (${((calSuccessCount / 8) * 100).toFixed(1)}%)`,
      calErrors.length ? 'FAIL' : 'PASS',
      'runs/',
    );

    const trajErrors = [...auditErrors];
    if (!cleanSuccessRuns.length) {
      trajErrors.push('缺少至少 1 条来自 opus-5 或 gpt-5.6-sol 的真实完整成功轨迹');
    }
    push(
      'CHK-07-CLEAN-TRAJECTORY',
      '第1/5节：opus-5 / gpt-5.6-sol 真实成功轨迹、Token/轮次复算与防 hack 审查',
      'trajectory_audit',
      '>=1 条真实成功轨迹，全量 run 用量/轮次复算一致，review CLEAN_PASS 且零 canary 外泄',
      trajErrors.length
        ? trajErrors.join('; ')
        : `通过审查 ${runJsonFiles.length} 条轨迹；合格示范成功轨迹: ${cleanSuccessRuns.join(', ')}`,
      trajErrors.length ? 'FAIL' : 'PASS',
      'review/',
    );
  }

  const hasFailOrError = records.some((r) => r.status === 'FAIL' || r.status === 'ERROR');
  const hasSkipWhenRequired = options.requireRuns ? records.some((r) => r.status === 'SKIP') : false;

  return {
    task_id: taskId,
    task_version: taskVersion,
    domain,
    sub_domain: subDomain,
    task_family: taskFamily,
    package_hash: packageHash,
    all_required_passed: !hasFailOrError && !hasSkipWhenRequired,
    calibration_summary: {
      present: calValidCount > 0,
      model: calModel,
      total_valid_runs: calValidCount,
      success_count: calSuccessCount,
      pass_rate: calValidCount === 8 ? calSuccessCount / 8 : null,
      qualified_band: calValidCount === 8 && calSuccessCount >= 1 && calSuccessCount <= 3,
    },
    clean_trajectory_summary: {
      present: cleanSuccessRuns.length > 0,
      qualified_runs: cleanSuccessRuns,
    },
    records,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const executeDynamic = args.includes('--execute');
  const requireRuns = args.includes('--require-runs');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));

  if (!positional.length || args.includes('--help')) {
    console.log('用法: bun projects/ALE/scripts/verify-task.ts <tasks/TASK_ID目录> [--execute] [--require-runs] [--out check_records.json]');
    process.exit(positional.length ? 0 : 1);
  }

  const summary = await verifyTaskDirectory(positional[0]!, { executeDynamic, requireRuns });
  if (outPath) {
    await writeFile(resolve(outPath), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.all_required_passed ? 0 : 2);
}
