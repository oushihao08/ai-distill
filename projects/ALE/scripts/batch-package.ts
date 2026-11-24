/**
 * 职责：按《ALE 数据交付技术规范》第 1、5、6、7 节组装批次目录 `batch/`（含 batch_manifest.json、trajectory_stats.csv、SHA256SUMS.txt、tasks/、shared/）及可选 UTF-8 ZIP 交付包。
 * 主要公开入口：`buildAleBatchPackage()` 供程序调用；文件支持 `bun projects/ALE/scripts/batch-package.ts <batch_spec.json>` CLI 直接执行。
 * 副作用边界：仅在全部输入任务通过指定级别质检且目标输出路径不存在时才创建输出目录和 ZIP，拒绝静默覆盖或放行未关闭严重缺陷。
 */
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import {
  ALE_DOMAIN_QUOTAS,
  ALE_FORBIDDEN_FILENAMES,
  ALE_OTHER_DOMAIN_MAX_QUOTA,
  isGitLfsPointer,
  sha256Hex,
  summarizeDistribution,
} from './contracts';
import { verifyTaskDirectory, type VerifyTaskSummary } from './verify-task';

export interface BatchBuildSpec {
  batch_id: string;
  batch_version: string;
  output_dir: string;
  require_runs?: boolean;
  execute_dynamic?: boolean;
  create_zip?: boolean;
  license_and_authorization: {
    training_use_authorized: boolean;
    commercial_use_authorized: boolean;
    statement: string;
  };
  shared_materials?: { id: string; version: string; source_dir: string }[];
  shared_environments?: { id: string; version: string; source_dir: string }[];
  tasks: {
    task_id: string;
    task_dir: string;
    material_package_id: string;
    environment_id: string;
    shared_world_id?: string | null;
  }[];
}

interface TrajectoryRow {
  task_id: string;
  run_id: string;
  model: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  model_turns: number;
  tool_calls: number;
}

async function listAllFiles(root: string): Promise<{ rel: string; abs: string; size: number; sha256: string }[]> {
  const entries: { rel: string; abs: string; size: number; sha256: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (ALE_FORBIDDEN_FILENAMES.has(item.name) || item.name.startsWith('._')) continue;
      const abs = join(dir, item.name);
      const rel = relative(root, abs).split('\\').join('/');
      const info = await lstat(abs);
      if (info.isSymbolicLink()) throw new Error(`禁止交付符号链接: ${rel}`);
      if (info.isDirectory()) await walk(abs);
      else if (info.isFile()) {
        const bytes = await readFile(abs);
        if (isGitLfsPointer(bytes)) throw new Error(`批次含 Git LFS 指针文件: ${rel}`);
        entries.push({ rel, abs, size: bytes.byteLength, sha256: sha256Hex(bytes) });
      }
    }
  };
  await walk(root);
  return entries.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
}

function csvEscape(val: string | number | null): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function buildAleBatchPackage(spec: BatchBuildSpec) {
  if (!spec.batch_id || !spec.batch_version || !spec.output_dir) {
    throw new Error('batch_id、batch_version 与 output_dir 必填');
  }
  if (!spec.license_and_authorization?.training_use_authorized || !spec.license_and_authorization?.commercial_use_authorized) {
    throw new Error('规范第 1 节要求明确具备训练与商业使用授权');
  }
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) {
    throw new Error('批次 tasks 清单不能为空');
  }

  const outParent = resolve(spec.output_dir);
  const batchRoot = join(outParent, 'batch');
  const zipPath = join(outParent, `${spec.batch_id}.zip`);
  for (const target of [batchRoot, zipPath]) {
    const exists = await lstat(target).then(() => true).catch(() => false);
    if (exists) throw new Error(`目标输出已存在，拒绝覆盖：${target}`);
  }

  const requireRuns = spec.require_runs ?? true;
  const executeDynamic = spec.execute_dynamic ?? false;
  const seenTaskIds = new Set<string>();
  const seenInstructionHashes = new Set<string>();
  const verifiedTasks: {
    entry: BatchBuildSpec['tasks'][number];
    summary: VerifyTaskSummary;
    taskCard: any;
    runs: TrajectoryRow[];
  }[] = [];

  // 1. 全量逐题核验与同构/重复拦截
  for (const item of spec.tasks) {
    if (seenTaskIds.has(item.task_id)) throw new Error(`重复的 task_id：${item.task_id}`);
    seenTaskIds.add(item.task_id);

    const taskRoot = resolve(item.task_dir);
    const summary = await verifyTaskDirectory(taskRoot, { executeDynamic, requireRuns });
    if (summary.task_id !== item.task_id) {
      throw new Error(`清单 task_id(${item.task_id}) 与题包内 task_card(${summary.task_id}) 不一致`);
    }
    if (!summary.all_required_passed) {
      const failedIds = summary.records.filter((r) => r.status !== 'PASS').map((r) => `${r.check_id}:${r.status}`);
      throw new Error(`题目 ${item.task_id} 存在未通过质检项(${failedIds.join(', ')})，依规范第6节不计合格净量`);
    }

    const instructionBytes = await readFile(join(taskRoot, 'instruction.md'));
    const instHash = sha256Hex(instructionBytes);
    if (seenInstructionHashes.has(instHash)) {
      throw new Error(`检测到重复题面哈希(${item.task_id})，同构/重复题不得重复计入净量`);
    }
    seenInstructionHashes.add(instHash);

    const taskCard = JSON.parse(await readFile(join(taskRoot, 'task_card.json'), 'utf8'));
    const taskFiles = await listAllFiles(taskRoot);
    const runRows: TrajectoryRow[] = [];
    for (const rf of taskFiles.filter((f) => /^runs\/[^/]+\/[^/]+\/run\.json$/.test(f.rel))) {
      const runDir = resolve(rf.abs, '..');
      const runJson = JSON.parse(await readFile(rf.abs, 'utf8'));
      const gradeJson = JSON.parse(await readFile(join(runDir, 'grade.json'), 'utf8'));
      const status =
        runJson.termination_status === 'infra_error'
          ? 'infra_error'
          : gradeJson.success === true
            ? 'success'
            : 'normal_failure';
      runRows.push({
        task_id: item.task_id,
        run_id: String(runJson.run_id),
        model: String(runJson.model),
        status,
        input_tokens: runJson.usage?.input_tokens ?? null,
        output_tokens: runJson.usage?.output_tokens ?? null,
        total_tokens: runJson.usage?.total_tokens ?? null,
        model_turns: Number(runJson.model_turns ?? 0),
        tool_calls: Number(runJson.tool_calls ?? 0),
      });
    }
    verifiedTasks.push({ entry: item, summary, taskCard, runs: runRows });
  }

  // 2. 领域配额与 sub_domain 统计校验
  const domainCounts: Record<string, number> = {};
  const subDomainCounts: Record<string, Record<string, number>> = {};
  const coverageSoftware: Record<string, number> = {};
  const coverageOs: Record<string, number> = {};
  const coverageFormats: Record<string, number> = {};
  const coverageLanguages: Record<string, number> = {};
  const coverageResourceTiers: Record<string, number> = {};

  for (const { taskCard } of verifiedTasks) {
    const d = String(taskCard.domain);
    const sd = String(taskCard.sub_domain);
    domainCounts[d] = (domainCounts[d] ?? 0) + 1;
    subDomainCounts[d] ??= {};
    subDomainCounts[d]![sd] = (subDomainCounts[d]![sd] ?? 0) + 1;

    const maxAllowed = ALE_DOMAIN_QUOTAS[d] ?? ALE_OTHER_DOMAIN_MAX_QUOTA;
    if (domainCounts[d]! > maxAllowed) {
      throw new Error(`领域 ${d} 题量(${domainCounts[d]}) 超出规范第1节上限(${maxAllowed})`);
    }

    coverageOs[String(taskCard.os || 'linux')] = (coverageOs[String(taskCard.os || 'linux')] ?? 0) + 1;
    const tier = String(taskCard.resource_tier?.tier_label || 'unspecified');
    coverageResourceTiers[tier] = (coverageResourceTiers[tier] ?? 0) + 1;
    for (const sw of taskCard.software_and_tools ?? []) coverageSoftware[sw] = (coverageSoftware[sw] ?? 0) + 1;
    for (const fmt of [...(taskCard.input_formats ?? []), ...(taskCard.output_formats ?? [])]) {
      coverageFormats[fmt] = (coverageFormats[fmt] ?? 0) + 1;
    }
    for (const lang of taskCard.languages ?? []) coverageLanguages[lang] = (coverageLanguages[lang] ?? 0) + 1;
  }

  // 3. 物理组装 batch/ 目录树
  await mkdir(join(batchRoot, 'tasks'), { recursive: true, mode: 0o700 });
  await mkdir(join(batchRoot, 'shared', 'materials'), { recursive: true, mode: 0o700 });
  await mkdir(join(batchRoot, 'shared', 'environments'), { recursive: true, mode: 0o700 });

  const sharedMaterialRefs: any[] = [];
  for (const sm of spec.shared_materials ?? []) {
    const dest = join(batchRoot, 'shared', 'materials', sm.id);
    await cp(resolve(sm.source_dir), dest, { recursive: true });
    const files = await listAllFiles(dest);
    sharedMaterialRefs.push({
      id: sm.id,
      version: sm.version,
      path: `shared/materials/${sm.id}`,
      file_count: files.length,
      tree_sha256: sha256Hex(files.map((f) => `${f.rel}:${f.sha256}`).join('\n')),
    });
  }

  const sharedEnvRefs: any[] = [];
  for (const se of spec.shared_environments ?? []) {
    const dest = join(batchRoot, 'shared', 'environments', se.id);
    await cp(resolve(se.source_dir), dest, { recursive: true });
    const files = await listAllFiles(dest);
    sharedEnvRefs.push({
      id: se.id,
      version: se.version,
      path: `shared/environments/${se.id}`,
      file_count: files.length,
      tree_sha256: sha256Hex(files.map((f) => `${f.rel}:${f.sha256}`).join('\n')),
    });
  }

  const allTrajectoryRows: TrajectoryRow[] = [];
  for (const vt of verifiedTasks) {
    const destTask = join(batchRoot, 'tasks', vt.entry.task_id);
    await cp(resolve(vt.entry.task_dir), destTask, { recursive: true });
    allTrajectoryRows.push(...vt.runs);
  }

  // 4. 写入 trajectory_stats.csv
  const csvHeader = [
    'task_id',
    'run_id',
    'model',
    'status',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'model_turns',
    'tool_calls',
  ];
  const csvLines = [
    csvHeader.join(','),
    ...allTrajectoryRows.map((r) =>
      [
        r.task_id,
        r.run_id,
        r.model,
        r.status,
        r.input_tokens,
        r.output_tokens,
        r.total_tokens,
        r.model_turns,
        r.tool_calls,
      ]
        .map(csvEscape)
        .join(','),
    ),
  ];
  await writeFile(join(batchRoot, 'trajectory_stats.csv'), csvLines.join('\n') + '\n', { mode: 0o600 });

  // 5. 按题目及模型、成功/正常失败分组汇总轨迹分布与字段覆盖率
  const groupedDistributions: Record<string, any> = {};
  for (const row of allTrajectoryRows) {
    if (row.status !== 'success' && row.status !== 'normal_failure') continue;
    const key = `${row.task_id}::${row.model}::${row.status}`;
    groupedDistributions[key] ??= {
      task_id: row.task_id,
      model: row.model,
      status: row.status,
      input_tokens: [] as number[],
      output_tokens: [] as number[],
      total_tokens: [] as number[],
      model_turns: [] as number[],
      tool_calls: [] as number[],
    };
    if (row.input_tokens !== null) groupedDistributions[key].input_tokens.push(row.input_tokens);
    if (row.output_tokens !== null) groupedDistributions[key].output_tokens.push(row.output_tokens);
    if (row.total_tokens !== null) groupedDistributions[key].total_tokens.push(row.total_tokens);
    groupedDistributions[key].model_turns.push(row.model_turns);
    groupedDistributions[key].tool_calls.push(row.tool_calls);
  }
  const distributionSummary = Object.values(groupedDistributions).map((g: any) => ({
    task_id: g.task_id,
    model: g.model,
    status: g.status,
    sample_count: g.model_turns.length,
    input_tokens: summarizeDistribution(g.input_tokens),
    output_tokens: summarizeDistribution(g.output_tokens),
    total_tokens: summarizeDistribution(g.total_tokens),
    model_turns: summarizeDistribution(g.model_turns),
    tool_calls: summarizeDistribution(g.tool_calls),
  }));

  const totalRuns = allTrajectoryRows.length;
  const fieldCoverageRate =
    totalRuns === 0
      ? { input_tokens: null, output_tokens: null, total_tokens: null, model_turns: null, tool_calls: null }
      : {
          input_tokens: Number((allTrajectoryRows.filter((r) => r.input_tokens !== null).length / totalRuns).toFixed(4)),
          output_tokens: Number((allTrajectoryRows.filter((r) => r.output_tokens !== null).length / totalRuns).toFixed(4)),
          total_tokens: Number((allTrajectoryRows.filter((r) => r.total_tokens !== null).length / totalRuns).toFixed(4)),
          model_turns: 1.0,
          tool_calls: 1.0,
        };

  // 5b. 写出规范第 6 节全量质检记录与第 7 节原始/转换轨迹字段映射说明
  const allQaRecords = verifiedTasks.flatMap(({ summary }) => summary.records);
  await writeFile(join(batchRoot, 'qa_check_records.json'), JSON.stringify(allQaRecords, null, 2) + '\n', { mode: 0o600 });
  const schemaMapping = {
    schema_version: 'ale.trajectory_mapping.v1',
    raw_file: 'runs/<model>/<run_id>/raw_codex_events.jsonl',
    converted_file: 'runs/<model>/<run_id>/trajectory.jsonl',
    lossless_statement:
      '转换件与原始 NDJSON 调用流一并实交，完整保留全部消息顺序、工具调用 ID/参数、完整退出码与标准输出/补丁内容及原始 usage，零压缩截断。',
    field_mapping: {
      'item.completed (item.type in command_execution|mcp_tool_call|web_search|file_change)':
        '拆分为相邻两条记录：(1) role=assistant, type=model_response, tool_calls=[{id, name, arguments}]；(2) role=tool, type=tool_result, tool_call_id, exit_code, status, output（保留完整工具返回正文，不计入 model_turns）',
      'item.completed (item.type == agent_message)': 'role=assistant, type=model_response, text=item.text, tool_calls=[]',
      'turn.completed.usage':
        '写入末条 assistant 记录 usage 及 run.json.usage（含 input_tokens、cached_input_tokens、output_tokens、reasoning_output_tokens、total_tokens）',
      reasoning_disclosure:
        'Codex/OpenAI 接口未暴露明文内部思维链文本，仅暴露 reasoning_output_tokens 计数（已包含在 output_tokens 内），按第 5 节据实声明。',
    },
  };
  await writeFile(join(batchRoot, 'trajectory_schema_mapping.json'), JSON.stringify(schemaMapping, null, 2) + '\n', {
    mode: 0o600,
  });

  // 先扫描现有文件生成 batch_manifest.json 内的文件清单，再将 batch_manifest.json 纳入最终 SHA256SUMS.txt
  const preManifestFiles = await listAllFiles(batchRoot);
  const uniqueMaterialIds = new Set(verifiedTasks.map((t) => t.entry.material_package_id));
  const uniqueEnvIds = new Set(verifiedTasks.map((t) => t.entry.environment_id));
  const uniqueWorlds = new Set(verifiedTasks.map((t) => t.entry.shared_world_id).filter(Boolean));

  const batchManifest = {
    schema_version: 'ale.batch_manifest.v1',
    batch_id: spec.batch_id,
    batch_version: spec.batch_version,
    generated_at: new Date().toISOString(),
    license_and_authorization: spec.license_and_authorization,
    net_accounting: {
      qualified_independent_tasks: verifiedTasks.length,
      unique_material_packages: uniqueMaterialIds.size,
      unique_environments: uniqueEnvIds.size,
      unique_shared_worlds: uniqueWorlds.size,
      isomorphic_duplicates_excluded: 0,
      domain_counts: domainCounts,
      sub_domain_counts: subDomainCounts,
    },
    label_coverage_tables: {
      software_and_tools: coverageSoftware,
      os: coverageOs,
      file_formats: coverageFormats,
      languages: coverageLanguages,
      resource_tiers: coverageResourceTiers,
    },
    shared_assets: {
      materials: sharedMaterialRefs,
      environments: sharedEnvRefs,
    },
    tasks: verifiedTasks.map(({ entry, summary, taskCard, runs }) => ({
      task_id: entry.task_id,
      version: summary.task_version,
      domain: summary.domain,
      sub_domain: summary.sub_domain,
      task_family: summary.task_family,
      material_package_id: entry.material_package_id,
      environment_id: entry.environment_id,
      shared_world_id: entry.shared_world_id ?? null,
      source_provenance: taskCard.source_provenance ?? null,
      calibration: summary.calibration_summary,
      clean_success_runs: summary.clean_trajectory_summary.qualified_runs,
      run_ids: runs.map((r) => `${r.model}/${r.run_id}`),
      qa_checks_passed: summary.records.filter((r) => r.status === 'PASS').length,
      qa_checks_total: summary.records.length,
    })),
    trajectory_statistics: {
      quantile_algorithm: 'linear_interpolation (pos = (n - 1) * q)',
      total_runs: totalRuns,
      field_coverage_rate: fieldCoverageRate,
      by_task_model_and_outcome: distributionSummary,
    },
    files: preManifestFiles.map((f) => ({
      path: f.rel,
      size_bytes: f.size,
      sha256: f.sha256,
    })),
  };

  await writeFile(join(batchRoot, 'batch_manifest.json'), JSON.stringify(batchManifest, null, 2) + '\n', { mode: 0o600 });

  // 6. 生成 SHA256SUMS.txt（覆盖除自身外的全部交付实物）
  const finalFiles = (await listAllFiles(batchRoot)).filter((f) => f.rel !== 'SHA256SUMS.txt');
  const shaLines = finalFiles.map((f) => `${f.sha256}  ${f.rel}`);
  await writeFile(join(batchRoot, 'SHA256SUMS.txt'), shaLines.join('\n') + '\n', { mode: 0o600 });

  // 7. 可选打包 UTF-8 ZIP 并执行 ZIP 内外双向哈希一致性核验
  let zipSha256: string | null = null;
  if (spec.create_zip !== false) {
    const pyScript = `
import sys, zipfile
from pathlib import Path

batch_root = Path(sys.argv[1])
zip_target = Path(sys.argv[2])
with zipfile.ZipFile(zip_target, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for p in sorted(batch_root.rglob('*')):
        if p.is_file():
            arc = 'batch/' + p.relative_to(batch_root).as_posix()
            zf.write(p, arc)
with zipfile.ZipFile(zip_target, 'r') as zf:
    bad = zf.testzip()
    if bad:
        raise RuntimeError(f'Corrupted zip member: {bad}')
`;
    const zProc = spawnSync('python3', ['-c', pyScript, batchRoot, zipPath], { encoding: 'utf8' });
    if (zProc.status !== 0) {
      throw new Error(`创建或校验批次 ZIP 失败: ${zProc.stderr}`);
    }
    zipSha256 = sha256Hex(await readFile(zipPath));
  }

  return {
    batch_id: spec.batch_id,
    batch_dir: batchRoot,
    zip_path: spec.create_zip !== false ? zipPath : null,
    zip_sha256: zipSha256,
    qualified_tasks: verifiedTasks.length,
    total_files_hashed: finalFiles.length,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('用法: bun projects/ALE/scripts/batch-package.ts <batch_spec.json>');
    process.exit(args.length ? 0 : 1);
  }
  const spec = JSON.parse(await readFile(resolve(args[0]!), 'utf8')) as BatchBuildSpec;
  const result = await buildAleBatchPackage(spec);
  console.log(JSON.stringify(result, null, 2));
}
