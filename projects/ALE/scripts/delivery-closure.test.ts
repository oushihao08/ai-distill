/**
 * 职责：验证 ALE 第 8 步归档准备（`archive.ts`）、单题交付（`delivery.ts`）与批次打包（`batch-package.ts`）的端到端闭环及安全边界。
 * 被测对象：`projects/ALE/scripts/archive.ts`、`projects/ALE/scripts/delivery.ts`、`projects/ALE/scripts/batch-package.ts`。
 * 验证边界：仅在系统临时目录（`os.tmpdir()`）构造隔离草稿、模拟 `8+1` 标定轨迹与防 hack 审查产物，实跑 Python 沙盒评分与批次 ZIP 双向哈希校验，零数据库/网络/宿主机业务目录副作用，测试结束自动清理全部临时文件。
 */
import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocx } from '../../../server/document-generation/docx';
import { buildXlsx } from '../../../server/document-generation/xlsx';
import { loadProjectArchive, resolveProjectDelivery, type DeliveryInput } from '../../../server/publishing/project-delivery';
import { prepare as prepareAleArchive } from './archive';
import { buildAleBatchPackage } from './batch-package';
import { sha256Hex } from './contracts';
import { deliverFromWorkbench, materializeAleTaskFromDraft } from './delivery';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DELIVERY_SCRIPT_PATH = join(SCRIPTS_DIR, 'delivery.ts');

function buildGraderSource(acceptNetReceivableAlias: boolean): string {
  const keysExpr = acceptNetReceivableAlias ? '["净应收额", "净应收金额"]' : '["净应收额"]';
  return [
    '#!/usr/bin/env python3',
    'from __future__ import annotations',
    'import sys',
    'from pathlib import Path',
    'sys.path.insert(0, str(Path(__file__).resolve().parent))',
    'from ale_grader_lib import DocxExtractor, ExcelEvaluator, GradeReporter, parse_grade_cli_args, verify_frozen_inputs',
    '',
    'EXPECTED_INPUT_SHA = "__INPUT_SHA256__"',
    '',
    'def check_c01_source(args, tests_dir: Path):',
    '    ok, diff = verify_frozen_inputs({"附件1.txt": EXPECTED_INPUT_SHA}, input_dir=args.input_dir, artifacts_dir=args.artifacts_dir, tests_dir=tests_dir)',
    '    return (1.0 if ok else 0.0), True, (True if ok else diff)',
    '',
    'def check_c02_net_amount(ev: ExcelEvaluator | None):',
    '    if ev is None:',
    '        return 0.0, {"净应收额": 850.0, "has_formula": True}, "missing_workbook"',
    `    hit = ev.find_row_metric(${keysExpr}, sheet="汇总", prefer_formula=True)`,
    '    if hit is None:',
    `        raw_hit = ev.find_row_metric(${keysExpr}, sheet="汇总", prefer_formula=False)`,
    '        return 0.0, {"净应收额": 850.0, "has_formula": True}, {"raw_hit": raw_hit}',
    '    sh, coord, val, formula = hit',
    '    if not formula:',
    '        return 0.0, {"净应收额": 850.0, "has_formula": True}, {"val": val, "formula": None}',
    '    ok = abs(float(val) - 850.0) <= 0.01',
    '    return (1.0 if ok else 0.0), 850.0, {"sheet": sh, "coord": coord, "val": val, "formula": formula}',
    '',
    'def check_c03_deduction(ev: ExcelEvaluator | None):',
    '    if ev is None:',
    '        return 0.0, 150.0, "missing_workbook"',
    '    hit = ev.find_row_metric(["核减争议款", "争议核减额"], sheet="汇总", prefer_formula=False)',
    '    if hit is None:',
    '        return 0.0, 150.0, "not_found"',
    '    _, _, val, formula = hit',
    '    has_any_formula = any(bool(ev.get_formula(s, c)) for s in ev.sheet_order for c in ev.sheets[s].cells)',
    '    if not has_any_formula:',
    '        return 0.0, 150.0, {"val": val, "all_static_constants": True}',
    '    ok = abs(float(val) - 150.0) <= 0.01',
    '    return (1.0 if ok else 0.0), 150.0, {"val": val, "formula": formula}',
    '',
    'def check_c04_docx_verdict(doc: DocxExtractor | None, has_valid_formula: bool):',
    '    if doc is None:',
    '        return 0.0, "清收结论：建议按净额850元确权", "missing_docx"',
    '    if not has_valid_formula:',
    '        return 0.0, "需配套真实公式工作簿", "workbook_missing_live_formula"',
    '    txt = doc.full_text',
    '    ok = ("按净额850" in txt or "850.00" in txt) and ("确权" in txt)',
    '    return (1.0 if ok else 0.0), "含850净额确权结论", txt[:80]',
    '',
    'def main() -> None:',
    '    args = parse_grade_cli_args()',
    '    tests_dir = Path(__file__).resolve().parent',
    '    reporter = GradeReporter(task_id="FIN-CLOSE-E2E-001", rubric_path=tests_dir / "rubric.json", run_id=args.run_id)',
    '    art_dir = Path(args.artifacts_dir)',
    '    xlsx_path = art_dir / "output" / "结算核对.xlsx"',
    '    docx_path = art_dir / "output" / "核对说明.docx"',
    '    if not xlsx_path.is_file() and not docx_path.is_file():',
    '        reporter.fail_all_missing("no_output_deliverables")',
    '        reporter.write(args.output)',
    '        return',
    '    ev = ExcelEvaluator(xlsx_path) if xlsx_path.is_file() else None',
    '    doc = DocxExtractor(docx_path) if docx_path.is_file() else None',
    '    has_live_formula = bool(ev and any(bool(ev.get_formula(s, c)) for s in ev.sheet_order for c in ev.sheets[s].cells))',
    '    s1, e1, o1 = check_c01_source(args, tests_dir)',
    '    reporter.add_item("C01_source_integrity", s1, e1, o1, "environment/input/附件1.txt")',
    '    s2, e2, o2 = check_c02_net_amount(ev)',
    '    reporter.add_item("C02_net_amount", s2, e2, o2, "output/结算核对.xlsx#汇总")',
    '    s3, e3, o3 = check_c03_deduction(ev)',
    '    reporter.add_item("C03_deduction_item", s3, e3, o3, "output/结算核对.xlsx#汇总")',
    '    s4, e4, o4 = check_c04_docx_verdict(doc, has_live_formula)',
    '    reporter.add_item("C04_docx_verdict", s4, e4, o4, "output/核对说明.docx")',
    '    reporter.write(args.output)',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ].join('\n');
}

function createFixtureDraft(inputText: string, inputSha256: string) {
  const taskId = 'FIN-CLOSE-E2E-001';
  const canary = 'ALE-CANARY-BUSINESS_FINANCE-FIN-CLOSE-E2E-001-7D91A2';
  const gradePy = buildGraderSource(false).replace('__INPUT_SHA256__', inputSha256);
  const patchedGradePy = buildGraderSource(true).replace('__INPUT_SHA256__', inputSha256);

  const instructionMd = [
    '# 华东供应链账款结算核对与清收备忘录编制',
    '',
    '请查阅 `/workspace/input/附件1.txt` 中的原始对账台账与质量异议往来函，核实应收原值与争议扣款，完成以下两份正式交付物：',
    '',
    '1. `/workspace/output/结算核对.xlsx`：在 `汇总` 工作表中列出 `账面应收原值`、`核减争议款` 与 `净应收额`，其中 `净应收额` 须使用 Excel 活公式动态引用计算，不得硬编码静态常数。',
    '2. `/workspace/output/核对说明.docx`：简明给出核减依据及最终确权金额结论。',
  ].join('\n');

  const rubricSpec = {
    task_id: taskId,
    canary,
    scale: {
      normalization: 'weighted_sum',
      pass_threshold: 0.85,
      reference_target: { mode: 'deterministic', min_score: 1.0 },
    },
    criteria: [
      {
        criterion_id: 'C01_source_integrity',
        prompt_basis: '依据 /workspace/input/附件1.txt 原始资料开展核对，不得篡改只读输入',
        source_locator: 'environment/input/附件1.txt#L1-L6',
        observation_locator: 'environment/input/附件1.txt',
        condition: '只读输入 SHA-256 与冻结快照一致',
        weight: 15,
        tolerance: 'exact_sha256',
        is_key_gate: true,
        grader_mapping: 'check_c01_source',
      },
      {
        criterion_id: 'C02_net_amount',
        prompt_basis: '汇总表动态公式计算净应收额',
        source_locator: 'environment/input/附件1.txt#L2-L5',
        observation_locator: 'output/结算核对.xlsx#汇总!净应收额',
        condition: '净应收额等于 850.00 且由活公式计算',
        weight: 40,
        tolerance: '±0.01',
        is_key_gate: true,
        grader_mapping: 'check_c02_net_amount',
      },
      {
        criterion_id: 'C03_deduction_item',
        prompt_basis: '汇总表准确列示核减争议款',
        source_locator: 'environment/input/附件1.txt#L4-L5',
        observation_locator: 'output/结算核对.xlsx#汇总!核减争议款',
        condition: '核减争议款等于 150.00',
        weight: 25,
        tolerance: '±0.01',
        is_key_gate: true,
        grader_mapping: 'check_c03_deduction',
      },
      {
        criterion_id: 'C04_docx_verdict',
        prompt_basis: '核对说明.docx 载明最终净额确权结论',
        source_locator: 'environment/input/附件1.txt#L1-L6',
        observation_locator: 'output/核对说明.docx',
        condition: '文档准确陈述 850.00 元净额确权结论',
        weight: 20,
        tolerance: 'semantic_exact_number',
        is_key_gate: false,
        grader_mapping: 'check_c04_docx_verdict',
      },
    ],
  };

  const alePackage = {
    task_card: {
      task_id: taskId,
      version: '1.0.0',
      domain: 'business_finance',
      sub_domain: 'corporate_treasury',
      task_family: 'receivables_reconciliation',
      canary,
      os: 'linux',
      languages: ['zh'],
      software_and_tools: ['python3', 'openpyxl'],
      input_formats: ['txt'],
      output_formats: ['xlsx', 'docx'],
      resource_tier: { tier_label: 'standard_cpu_2c4g', cpu_cores: 2, memory_gb: 4, disk_gb: 10 },
      network: { allow_internet: false },
      inputs: [{ path: 'environment/input/附件1.txt', sha256: inputSha256, required: true }],
      deliverables_contract: [
        { path: 'output/结算核对.xlsx', format: 'xlsx', required: true },
        { path: 'output/核对说明.docx', format: 'docx', required: true },
      ],
    },
    instruction_md: instructionMd,
    env_spec: {
      base_image: 'python:3.12-slim',
      workdir: '/workspace',
      visibility_isolation: {
        agent_readable: ['/workspace/instruction.md', '/workspace/input/', '/workspace/tools/'],
        agent_writable: ['/workspace/output/', '/workspace/tmp/'],
        forbidden_in_agent_view: ['tests/', 'solution/', 'runs/', 'review/'],
      },
    },
    dockerfile: 'FROM python:3.12-slim\nWORKDIR /workspace\nCOPY input/ /workspace/input/\nCOPY tools/ /workspace/tools/\n',
    requirements_lock: 'openpyxl==3.1.5\npython-docx==1.1.2\n',
    reset_sh: '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p /workspace/output\nrm -rf /workspace/output/*\n',
    solve_sh: '#!/usr/bin/env bash\nset -euo pipefail\necho "Reference artifacts prebuilt in solution/artifacts"\n',
    rubric_spec: rubricSpec,
    grade_py: gradePy,
    reference_ground_truth: { gross: 1000, deduction: 150, net: 850 },
    reference_files: [
      {
        path: 'output/结算核对.xlsx',
        kind: 'xlsx' as const,
        content: '账面原值 1000 元，核减争议款 150 元，净应收额 850 元。',
        sheets: [
          {
            name: '汇总',
            columns: ['项目', '金额'],
            rows: [
              ['账面应收原值', 1000],
              ['核减争议款', 150],
              ['净应收额', { formula: '=B2-B3', cached_value: 850 }],
            ],
          },
        ],
      },
      {
        path: 'output/核对说明.docx',
        kind: 'docx' as const,
        content: '# 账款结算核对说明\n\n经核查原始对账单与质量折让确认函，核减争议款 150.00 元，建议按净额850.00元确权清收。',
      },
    ],
    variant_fixtures: [
      {
        id: 'B03_equivalent_sum_formula',
        kind: 'equivalent_pass',
        expect_task_fail: false,
        description: '使用 SUM 正负项公式等价计算净应收额',
        files: [
          {
            path: 'output/结算核对.xlsx',
            kind: 'xlsx' as const,
            content: '等价公式验证',
            sheets: [
              {
                name: '汇总',
                columns: ['指标项', '核算值'],
                rows: [
                  ['账面应收原值', 1000],
                  ['争议核减额', 150],
                  ['净应收额', { formula: '=ROUND(B2-B3, 2)', cached_value: 850 }],
                ],
              },
            ],
          },
          {
            path: 'output/核对说明.docx',
            kind: 'docx' as const,
            content: '# 核对意见\n\n核定净应收金额 850.00 元，建议按净额850元确权。',
          },
        ],
      },
      {
        id: 'M01_skeleton_static_constants',
        kind: 'skeleton_or_constant',
        expect_task_fail: true,
        description: '纯硬编码静态常数无任何 Excel 公式，压制至 <=0.20',
        files: [
          {
            path: 'output/结算核对.xlsx',
            kind: 'xlsx' as const,
            content: '',
            sheets: [
              {
                name: '汇总',
                columns: ['项目', '金额'],
                rows: [
                  ['账面应收原值', 1000],
                  ['核减争议款', 150],
                  ['净应收额', 850],
                ],
              },
            ],
          },
          {
            path: 'output/核对说明.docx',
            kind: 'docx' as const,
            content: '# 核对意见\n\n建议按净额850.00元确权。',
          },
        ],
      },
      {
        id: 'M10_shallow_decoy_trap',
        kind: 'shallow_decoy_trap',
        expect_task_fail: true,
        description: '轻信表层对账单原值 1000 元漏扣补充协议争议款 150 元',
        files: [
          {
            path: 'output/结算核对.xlsx',
            kind: 'xlsx' as const,
            content: '',
            sheets: [
              {
                name: '汇总',
                columns: ['项目', '金额'],
                rows: [
                  ['账面应收原值', 1000],
                  ['核减争议款', 0],
                  ['净应收额', { formula: '=B2-B3', cached_value: 1000 }],
                ],
              },
            ],
          },
          {
            path: 'output/核对说明.docx',
            kind: 'docx' as const,
            content: '# 核对意见\n\n按原值 1000.00 元全额催收。',
          },
        ],
      },
      {
        id: 'M03_single_factor_wrong_net',
        kind: 'single_factor_fail',
        target_criterion_id: 'C02_net_amount',
        expect_task_fail: true,
        must_remain_passed_ids: ['C01_source_integrity', 'C03_deduction_item', 'C04_docx_verdict'],
        description: '核减项与文书正确，仅净应收公式写反为加法导致 C02 精准失分',
        files: [
          {
            path: 'output/结算核对.xlsx',
            kind: 'xlsx' as const,
            content: '',
            sheets: [
              {
                name: '汇总',
                columns: ['项目', '金额'],
                rows: [
                  ['账面应收原值', 1000],
                  ['核减争议款', 150],
                  ['净应收额', { formula: '=B2+B3', cached_value: 1150 }],
                ],
              },
            ],
          },
          {
            path: 'output/核对说明.docx',
            kind: 'docx' as const,
            content: '# 核对说明\n\n最终建议按净额850.00元确权。',
          },
        ],
      },
    ],
  };

  const draft = {
    question_version: 'v1',
    rubric_version: 'v1',
    task_name: '华东供应链账款结算核对',
    task_type: 'ale_task',
    header: {},
    question: instructionMd,
    attachment_ids: ['11111111-1111-4111-8111-111111111111'],
    rubric: [
      {
        id: 'R1',
        points: 100,
        description: 'ALE 可执行评分契约',
        metadata: { ale_package: alePackage },
      },
    ],
    answer_approach: '先核验对账原值 1000 元，再依据补充函扣减争议款 150 元，得出净应收额 850 元。',
    reference_answer: '净应收额 850.00 元。',
  };

  return { taskId, canary, draft, patchedGradePy, inputText };
}

async function writeSimulatedRun(params: {
  stagedTaskDir: string;
  model: string;
  runId: string;
  role: 'calibration_8x' | 'clean_trajectory';
  success: boolean;
  useAliasAndWeekdayInWorkbook?: boolean;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const { stagedTaskDir, model, runId, role, success, useAliasAndWeekdayInWorkbook, inputTokens, outputTokens } = params;
  const runDir = join(stagedTaskDir, 'runs', model, runId);
  const outDir = join(runDir, 'artifacts', 'output');
  await mkdir(outDir, { recursive: true, mode: 0o700 });

  const trajEvents = [
    JSON.stringify({
      role: 'assistant',
      type: 'model_response',
      tool_calls: [{ id: 'call_1', name: 'command_execution', arguments: 'cat ./input/附件1.txt' }],
    }),
    JSON.stringify({
      role: 'assistant',
      type: 'model_response',
      text: success ? '已完成结算核对工作簿与说明文档生成。' : '已完成初步测算表。',
      tool_calls: [],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }),
  ];
  await writeFile(join(runDir, 'trajectory.jsonl'), trajEvents.join('\n') + '\n', { mode: 0o600 });

  const xlsxBytes = buildXlsx([
    {
      name: '汇总',
      columns: ['项目', '金额'],
      rows: success
        ? [
            { 项目: '账面应收原值', 金额: 1000 },
            { 项目: '核减争议款', 金额: 150 },
            useAliasAndWeekdayInWorkbook
              ? {
                  项目: '净应收金额',
                  金额: { formula: '=B2-B3+IF(WEEKDAY(DATE(2026,1,5),2)=1,0,0)', cached_value: 850 },
                }
              : {
                  项目: '净应收额',
                  金额: { formula: '=B2-B3', cached_value: 850 },
                },
          ]
        : [
            { 项目: '账面应收原值', 金额: 1000 },
            { 项目: '核减争议款', 金额: 0 },
            { 项目: '净应收额', 金额: { formula: '=B2-B3', cached_value: 1000 } },
          ],
    },
  ]);
  const docxBytes = await buildDocx(
    success
      ? '# 结算核对说明\n\n经核查扣减争议款 150.00 元，建议按净额850.00元确权。'
      : '# 结算核对说明\n\n暂按账面 1000.00 元统计。',
    { style: 'legal' },
  );
  await writeFile(join(outDir, '结算核对.xlsx'), xlsxBytes, { mode: 0o600 });
  await writeFile(join(outDir, '核对说明.docx'), docxBytes, { mode: 0o600 });

  const gradePayload = {
    task_id: 'FIN-CLOSE-E2E-001',
    run_id: runId,
    grader_version: '1.0.0',
    status: 'GRADED',
    normalized_score: success ? 1.0 : 0.15,
    key_gates_passed: success,
    success,
    items: [],
  };
  await writeFile(join(runDir, 'grade.json'), JSON.stringify(gradePayload, null, 2) + '\n', { mode: 0o600 });

  const runPayload = {
    schema_version: 'ale.run.v1',
    task_id: 'FIN-CLOSE-E2E-001',
    task_version: '1.0.0',
    run_id: runId,
    run_role: role,
    model,
    codex_version: 'codex-cli 0.169.0',
    harness: 'codex_cli_isolated_v1',
    is_oracle: false,
    parameters: { reasoning_effort: 'max', timeout_minutes: 45 },
    started_at: '2026-11-23T10:00:00.000Z',
    finished_at: '2026-11-23T10:05:00.000Z',
    termination_status: 'completed',
    model_turns: 2,
    tool_calls: 1,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(runPayload, null, 2) + '\n', { mode: 0o600 });

  if (success) {
    const reviewDir = join(stagedTaskDir, 'review');
    await mkdir(reviewDir, { recursive: true, mode: 0o700 });
    const reviewPayload = {
      run_id: runId,
      model,
      verdict: 'CLEAN_PASS',
      artifact_hashes: {
        'output/结算核对.xlsx': sha256Hex(xlsxBytes),
        'output/核对说明.docx': sha256Hex(docxBytes),
      },
      checks: {
        statement_tool_artifact_score_consistent: true,
        regrade_saved_artifacts_passed: true,
        no_unauthorized_truth_or_canary_access: true,
        no_grader_or_backend_tampering: true,
      },
      notes: '离线产物重评与 Canary 防泄漏核查通过。',
    };
    await writeFile(join(reviewDir, `${runId}.json`), JSON.stringify(reviewPayload, null, 2) + '\n', { mode: 0o600 });
  }
}

async function buildPopulatedStagedEnvironment(baseTmp: string) {
  const storageRoot = join(baseTmp, 'storage');
  const workflowId = 'wf-closure-0001';
  const inputText = [
    '对账单编号：DZ-2026-09',
    '账面应收原值：1000.00 元',
    '补充质量异议确认函：',
    '双方确认扣减批次损耗争议款：150.00 元',
    '其余款项无异议。',
  ].join('\n');
  const inputSha256 = sha256Hex(Buffer.from(inputText, 'utf8'));
  const { taskId, draft, patchedGradePy } = createFixtureDraft(inputText, inputSha256);

  const stagedParent = join(storageRoot, workflowId, 'custom-steps', 'ALE', 'staged');
  await mkdir(stagedParent, { recursive: true, mode: 0o700 });
  const matRes = await materializeAleTaskFromDraft({
    draft,
    taskIdFallback: 'ALE-FALLBACK',
    inputMaterials: [{ name: '附件1.txt', text: inputText }],
    outputParentDir: stagedParent,
    executeDynamic: false,
  });

  const stagedTaskDir = matRes.task_dir;
  // 模拟 regrade_only 阶段补充合法同义标签与 WEEKDAY 公式支持（保持 task_id 与 rubric.json 完全不变）
  const stagedGradePath = join(stagedTaskDir, 'tests', 'grade.py');
  await writeFile(stagedGradePath, patchedGradePy, { mode: 0o755 });
  await chmod(stagedGradePath, 0o755);

  // 写入 8 轮标定（2/8 = 25.0% 成功）+ 1 条 gpt-5.6-sol 示范成功轨迹（使用同义标签 + WEEKDAY 公式验证 grade.py 同步）
  for (let i = 1; i <= 8; i += 1) {
    const runId = `cal_run_${String(i).padStart(2, '0')}`;
    await writeSimulatedRun({
      stagedTaskDir,
      model: 'gpt-6.1-sol',
      runId,
      role: 'calibration_8x',
      success: i === 2 || i === 6,
      useAliasAndWeekdayInWorkbook: i === 6,
      inputTokens: 12000 + i * 100,
      outputTokens: 1500 + i * 50,
    });
  }
  await writeSimulatedRun({
    stagedTaskDir,
    model: 'gpt-5.6-sol',
    runId: 'demo_run_01',
    role: 'clean_trajectory',
    success: true,
    useAliasAndWeekdayInWorkbook: true,
    inputTokens: 15800,
    outputTokens: 2100,
  });

  // 模拟并发早停时尚未写入 run.json 的半成品槽位目录与空白 final_response.txt，验证同步时自动过滤半成品而不误伤正式轨迹
  const uncommittedRunDir = join(stagedTaskDir, 'runs', 'gpt-5.6-sol', 'demo_run_02');
  await mkdir(uncommittedRunDir, { recursive: true, mode: 0o700 });
  await writeFile(join(uncommittedRunDir, 'codex_stderr.log'), 'aborted on early stop\n', { mode: 0o600 });
  await writeFile(join(stagedTaskDir, 'runs', 'gpt-5.6-sol', 'demo_run_01', 'final_response.txt'), '   \n', {
    mode: 0o600,
  });

  const artifactId = '11111111-1111-4111-8111-111111111111';
  const mockPool = {
    query: async () => ({
      rows: [
        {
          id: artifactId,
          storage_path: null,
          sha256: inputSha256,
          content: inputText,
        },
      ],
    }),
  } as any;

  const deliveryInput: DeliveryInput = {
    version: 1,
    project_id: 'proj-ale-001',
    workflow_id: workflowId,
    title: '华东供应链账款结算核对',
    source_digest: 'digest-source-001',
    delivery_digest: 'digest-delivery-001',
    question_version: 'v1',
    rubric_version: 'v1',
    question: draft as any,
    acceptance: { decision: 'accepted', mode: 'author_only_sealed' },
    attachments: [],
  };

  return {
    storageRoot,
    workflowId,
    taskId,
    draft,
    inputText,
    inputSha256,
    stagedTaskDir,
    mockPool,
    deliveryInput,
    frozen: {
      material_origin: { kind: 'legacy' },
      materials: [{ id: artifactId, sha256: inputSha256 }],
    },
  };
}

test(
  'ALE archive.ts -> deliverFromWorkbench -> batch-package.ts completes full CHK-01..CHK-07 PASS & ZIP closure',
  async () => {
    const baseTmp = await mkdtemp(join(tmpdir(), 'ale-delivery-closure-'));
    try {
      // 确认 ALE 项目脚本在公共发布层可正常解析并加载 archive 钩子
      const resolvedDelivery = await resolveProjectDelivery('ALE');
      expect(resolvedDelivery.mode).toBe('script');
      const archiveMod = await loadProjectArchive(resolvedDelivery);
      expect(typeof archiveMod?.prepare).toBe('function');

      const env = await buildPopulatedStagedEnvironment(baseTmp);

      // 1. 执行第 8 步服务端准备钩子 archive.ts
      await prepareAleArchive(env.deliveryInput, {
        pool: env.mockPool,
        workflowId: env.workflowId,
        storageRoot: env.storageRoot,
        frozen: env.frozen,
      });

      const serializedInput = JSON.stringify(env.deliveryInput);
      expect(serializedInput).not.toContain('DATABASE_URL');
      const parsedForSubprocess = JSON.parse(serializedInput);
      expect(parsedForSubprocess.ale_staged).toBeDefined();
      expect(parsedForSubprocess.ale_staged.task_id).toBe(env.taskId);
      expect(parsedForSubprocess.ale_staged.has_runs).toBe(true);
      expect(parsedForSubprocess.ale_staged.has_review).toBe(true);
      expect(parsedForSubprocess.ale_staged.has_staged_grade_py).toBe(true);
      const realStorage = await realpath(env.storageRoot);
      expect(parsedForSubprocess.ale_staged.staged_task_dir.startsWith(`${realStorage}/`)).toBe(true);

      // 2. 执行第 8 步独立交付组装与动态核验 deliverFromWorkbench
      const archiveOutDir = join(baseTmp, 'archived-output');
      await mkdir(archiveOutDir, { recursive: true, mode: 0o700 });
      await deliverFromWorkbench(parsedForSubprocess, archiveOutDir);

      const checkRecordsPath = join(archiveOutDir, `check_records_${env.taskId}.json`);
      const checkSummary = JSON.parse(await readFile(checkRecordsPath, 'utf8'));
      expect(checkSummary.all_required_passed).toBe(true);
      expect(checkSummary.calibration_summary).toEqual({
        present: true,
        model: 'gpt-6.1-sol',
        total_valid_runs: 8,
        success_count: 2,
        pass_rate: 0.25,
        qualified_band: true,
      });
      expect(checkSummary.clean_trajectory_summary).toEqual({
        present: true,
        qualified_runs: ['gpt-5.6-sol/demo_run_01'],
      });

      const expectedCheckIds = [
        'CHK-01-FILES',
        'CHK-02-CONTRACT',
        'CHK-03-ISOLATION',
        'CHK-04-RUBRIC',
        'CHK-05-DYNAMIC-QA',
        'CHK-06-CALIBRATION-8X',
        'CHK-07-CLEAN-TRAJECTORY',
      ];
      expect(checkSummary.records.map((r: any) => r.check_id)).toEqual(expectedCheckIds);
      for (const rec of checkSummary.records) {
        expect(rec.status).toBe('PASS');
      }

      const reportMd = await readFile(join(archiveOutDir, `交付状态与待办核验_${env.taskId}.md`), 'utf8');
      expect(reportMd).toContain('- [x] 在目标声明容器/VM 环境执行参考基线');
      expect(reportMd).toContain('- [x] 使用 `GPT-6.1-Sol` 或 `Opus-5.5`');
      expect(reportMd).toContain('- [x] 采集至少 1 条 `opus-5` 或 `gpt-5.6-sol`');

      // 3. 将归档单题目录直接喂给 batch-package.ts 产出标准交付包与 ZIP
      const archivedTaskDir = join(archiveOutDir, 'tasks', env.taskId);
      const batchOutDir = join(baseTmp, 'batch-release');
      const batchResult = await buildAleBatchPackage({
        batch_id: 'ALE-BATCH-CLOSURE-001',
        batch_version: '1.0.0',
        output_dir: batchOutDir,
        require_runs: true,
        execute_dynamic: true,
        create_zip: true,
        license_and_authorization: {
          training_use_authorized: true,
          commercial_use_authorized: true,
          statement: 'Authorized internal test fixture for ALE delivery closure verification.',
        },
        tasks: [
          {
            task_id: env.taskId,
            task_dir: archivedTaskDir,
            material_package_id: 'MAT-PKG-001',
            environment_id: 'ENV-FIN-001',
          },
        ],
      });

      expect(batchResult.qualified_tasks).toBe(1);
      expect(batchResult.zip_path).toBe(join(resolve(batchOutDir), 'ALE-BATCH-CLOSURE-001.zip'));
      expect(batchResult.zip_sha256).toMatch(/^[0-9a-f]{64}$/);

      const manifest = JSON.parse(await readFile(join(batchOutDir, 'batch', 'batch_manifest.json'), 'utf8'));
      expect(manifest.schema_version).toBe('ale.batch_manifest.v1');
      expect(manifest.net_accounting.qualified_independent_tasks).toBe(1);
      expect(manifest.tasks[0].qa_checks_passed).toBe(7);
      expect(manifest.tasks[0].qa_checks_total).toBe(7);
      expect(manifest.tasks[0].clean_success_runs).toEqual(['gpt-5.6-sol/demo_run_01']);
      expect(manifest.trajectory_statistics.total_runs).toBe(9);

      const csvText = await readFile(join(batchOutDir, 'batch', 'trajectory_stats.csv'), 'utf8');
      const csvLines = csvText.trim().split('\n');
      expect(csvLines.length).toBe(10); // 表头 + 8 条标定 + 1 条示范（未提交半成品 demo_run_02 已被干净过滤）
      expect(csvText).not.toContain('demo_run_02');

      const shaSumsText = await readFile(join(batchOutDir, 'batch', 'SHA256SUMS.txt'), 'utf8');
      const shaEntries = shaSumsText
        .trim()
        .split('\n')
        .map((line) => {
          const [digest, relPath] = line.split('  ');
          return { digest: digest!, relPath: relPath! };
        });
      expect(shaEntries.length).toBeGreaterThan(20);
      for (const { digest, relPath } of shaEntries) {
        const diskBytes = await readFile(join(batchOutDir, 'batch', relPath));
        expect(sha256Hex(diskBytes)).toBe(digest);
      }

      // 校验生成的 .zip 内文件与 SHA256SUMS.txt 逐字节双向一致
      const zipVerifyPy = [
        'import hashlib, sys, zipfile',
        'zip_path, sums_path = sys.argv[1], sys.argv[2]',
        'expected = {}',
        'for line in open(sums_path, encoding="utf-8").read().splitlines():',
        '    if line.strip():',
        '        h, rel = line.split("  ", 1)',
        '        expected["batch/" + rel] = h',
        'with zipfile.ZipFile(zip_path, "r") as zf:',
        '    assert zf.testzip() is None',
        '    names = set(zf.namelist())',
        '    for arc, exp_h in expected.items():',
        '        assert arc in names, f"missing in zip: {arc}"',
        '        actual_h = hashlib.sha256(zf.read(arc)).hexdigest()',
        '        assert actual_h == exp_h, f"hash mismatch for {arc}: {actual_h} != {exp_h}"',
        '    assert "batch/SHA256SUMS.txt" in names',
      ].join('\n');
      const zipCheck = spawnSync(
        'python3',
        ['-c', zipVerifyPy, batchResult.zip_path!, join(batchOutDir, 'batch', 'SHA256SUMS.txt')],
        { encoding: 'utf8' },
      );
      expect(zipCheck.status).toBe(0);
    } finally {
      await rm(baseTmp, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  'anti-tamper gates reject stale offline regrades, cheat graders, and rubric contract drift',
  async () => {
    const baseTmp = await mkdtemp(join(tmpdir(), 'ale-delivery-antitamper-'));
    try {
      const env = await buildPopulatedStagedEnvironment(baseTmp);

      // 场景 A：若未同步复评后的 grade.py（staged 的 grade.py 回退为不支持同义标签的旧版），离线重评 CHK-07 必须拦截
      const oldGradePy = (env.draft.rubric[0] as any).metadata.ale_package.grade_py as string;
      const savedPatchedGradePy = await readFile(join(env.stagedTaskDir, 'tests', 'grade.py'), 'utf8');
      await writeFile(join(env.stagedTaskDir, 'tests', 'grade.py'), oldGradePy, { mode: 0o755 });
      await chmod(join(env.stagedTaskDir, 'tests', 'grade.py'), 0o755);

      await prepareAleArchive(env.deliveryInput, {
        pool: env.mockPool,
        workflowId: env.workflowId,
        storageRoot: env.storageRoot,
        frozen: env.frozen,
      });
      const staleOutDir = join(baseTmp, 'out-stale-grade');
      await mkdir(staleOutDir, { recursive: true, mode: 0o700 });
      await expect(deliverFromWorkbench(JSON.parse(JSON.stringify(env.deliveryInput)), staleOutDir)).rejects.toThrow(
        /CHK-07-CLEAN-TRAJECTORY.*离线重评分不一致/,
      );

      // 场景 B：若篡改 staged 的 grade.py 使其无脑放行满分，CHK-05-DYNAMIC-QA 单因子反例与 no-op 立即拦截
      const cheatGrader = [
        '#!/usr/bin/env python3',
        'import argparse, json',
        'from pathlib import Path',
        '# check_c01_source check_c02_net_amount check_c03_deduction check_c04_docx_verdict',
        'p = argparse.ArgumentParser()',
        'p.add_argument("--artifacts-dir", required=True)',
        'p.add_argument("--output", required=True)',
        'p.add_argument("--input-dir", default=None)',
        'a = p.parse_args()',
        'Path(a.output).write_text(json.dumps({"task_id":"FIN-CLOSE-E2E-001","normalized_score":1.0,"key_gates_passed":True,"success":True,"items":[]}))',
        '',
      ].join('\n');
      await writeFile(join(env.stagedTaskDir, 'tests', 'grade.py'), cheatGrader, { mode: 0o755 });
      await chmod(join(env.stagedTaskDir, 'tests', 'grade.py'), 0o755);
      const cheatOutDir = join(baseTmp, 'out-cheat-grade');
      await mkdir(cheatOutDir, { recursive: true, mode: 0o700 });
      await expect(deliverFromWorkbench(JSON.parse(JSON.stringify(env.deliveryInput)), cheatOutDir)).rejects.toThrow(
        /CHK-05-DYNAMIC-QA/,
      );

      // 场景 C：篡改 staged tests/rubric.json 使其偏离草稿契约，必须拒绝同步
      await writeFile(join(env.stagedTaskDir, 'tests', 'grade.py'), savedPatchedGradePy, { mode: 0o755 });
      await chmod(join(env.stagedTaskDir, 'tests', 'grade.py'), 0o755);
      const origRubric = await readFile(join(env.stagedTaskDir, 'tests', 'rubric.json'), 'utf8');
      const tamperedRubric = JSON.parse(origRubric);
      tamperedRubric.scale.pass_threshold = 0.5;
      await writeFile(join(env.stagedTaskDir, 'tests', 'rubric.json'), JSON.stringify(tamperedRubric), { mode: 0o600 });
      const rubricOutDir = join(baseTmp, 'out-tampered-rubric');
      await mkdir(rubricOutDir, { recursive: true, mode: 0o700 });
      await expect(deliverFromWorkbench(JSON.parse(JSON.stringify(env.deliveryInput)), rubricOutDir)).rejects.toThrow(
        /rubric\.json 与当前草稿不一致/,
      );
    } finally {
      await rm(baseTmp, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  'CLI --staged-task-dir works end-to-end and symlink escapes are rejected in both archive.ts and delivery.ts',
  async () => {
    const baseTmp = await mkdtemp(join(tmpdir(), 'ale-delivery-cli-symlink-'));
    try {
      const env = await buildPopulatedStagedEnvironment(baseTmp);
      await prepareAleArchive(env.deliveryInput, {
        pool: env.mockPool,
        workflowId: env.workflowId,
        storageRoot: env.storageRoot,
        frozen: env.frozen,
      });

      // 场景 D：测试 CLI --from-draft 配合 --staged-task-dir 正常通过全项检查
      const cliDraftPath = join(baseTmp, 'draft.json');
      const cliMatDir = join(baseTmp, 'materials');
      const cliOutDir = join(baseTmp, 'cli-out');
      await mkdir(cliMatDir, { recursive: true, mode: 0o700 });
      await writeFile(cliDraftPath, JSON.stringify(env.draft, null, 2), { mode: 0o600 });
      await writeFile(join(cliMatDir, '附件1.txt'), env.inputText, { mode: 0o600 });
      const cliProc = spawnSync(
        process.execPath,
        [
          DELIVERY_SCRIPT_PATH,
          '--from-draft',
          cliDraftPath,
          '--materials-dir',
          cliMatDir,
          '--out',
          cliOutDir,
          '--staged-task-dir',
          env.stagedTaskDir,
        ],
        { encoding: 'utf8' },
      );
      expect(cliProc.status).toBe(0);
      const cliRes = JSON.parse(cliProc.stdout);
      expect(cliRes.all_required_passed).toBe(true);

      // 场景 E：在 staged 目录内植入越界符号链接，archive.ts 与 delivery.ts 双重拦截
      const outsideSecret = join(baseTmp, 'outside-secret.txt');
      await writeFile(outsideSecret, 'SENSITIVE_DATA', { mode: 0o600 });
      await symlink(outsideSecret, join(env.stagedTaskDir, 'review', 'evil_link.json'));

      await expect(
        prepareAleArchive(
          { ...env.deliveryInput, attachments: [] },
          {
            pool: env.mockPool,
            workflowId: env.workflowId,
            storageRoot: env.storageRoot,
            frozen: env.frozen,
          },
        ),
      ).rejects.toThrow(/符号链接/);

      const symlinkOutDir = join(baseTmp, 'out-symlink');
      await mkdir(symlinkOutDir, { recursive: true, mode: 0o700 });
      await expect(deliverFromWorkbench(JSON.parse(JSON.stringify(env.deliveryInput)), symlinkOutDir)).rejects.toThrow(
        /符号链接/,
      );
    } finally {
      await rm(baseTmp, { recursive: true, force: true });
    }
  },
  30_000,
);
