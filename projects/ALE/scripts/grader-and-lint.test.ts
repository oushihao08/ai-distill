/**
 * 被测对象：`projects/ALE/scripts/ale_grader_lib.py`、`office_lint.py`、`delivery.ts` 与 `calibrate.ts`。
 * 验证边界：
 *   1. 纯 Python OOXML+AST 公式求值（跨表、$A$1、区间、t="shared" 共享公式、ROUND 四舍五入、WEEKDAY/EDATE/EOMONTH/WORKDAY 日期顺延、=0 合法零公式 vs 伪公式拦截、probe 微扰动联动）；
 *   2. DocxExtractor 三列/四列带备注 Word 表格提取与枚举结论抗标点/防反转匹配；
 *   3. office_lint.py 零真值/零业务词纯净性、正常回显与 #DIV/0! / 循环引用检出；
 *   4. materializeAleTaskFromDraft 自动打入 tests/ale_grader_lib.py 与 environment/tools/office_lint.py 并通过 CHK-01..05 动态门禁及旧 grade.py 向后兼容。
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocx } from '../../../server/document-generation/docx';
import { sha256Hex } from './contracts';
import { materializeAleTaskFromDraft } from './delivery';
import { preflightTask } from './calibrate';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const GRADER_LIB_PATH = join(SCRIPTS_DIR, 'ale_grader_lib.py');
const SKILL_GRADER_LIB_PATH = join(SCRIPTS_DIR, '..', 'skill', 'assets', 'ale_grader_lib.py');
const OFFICE_LINT_PATH = join(SCRIPTS_DIR, 'office_lint.py');

describe('ALE 公平提速基建：ale_grader_lib.py 与 office_lint.py 完备单测', () => {
  test('同源与纯净性红线：skill/assets 副本与 scripts 完全同源，office_lint.py 零业务字段/零真值/零私有依赖', async () => {
    const libBytes = await readFile(GRADER_LIB_PATH);
    const skillLibBytes = await readFile(SKILL_GRADER_LIB_PATH);
    expect(sha256Hex(libBytes)).toBe(sha256Hex(skillLibBytes));

    const lintText = await readFile(OFFICE_LINT_PATH, 'utf8');
    expect(lintText).not.toMatch(/ale_grader_lib|rubric|is_key_gate|canary|ground_truth/i);
    expect(lintText).not.toMatch(/本金|利息|敞口|工程款|违约金|徐仕清|曹峰/);
  });

  test('ExcelEvaluator：覆盖跨表、$绝对引用、t="shared" 共享公式、WEEKDAY/EDATE/EOMONTH/SUMIFS、=0 零公式与 probe 微扰动', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ale-lib-xlsx-'));
    try {
      const pyTestScript = `
import json, sys, zipfile
from pathlib import Path
import openpyxl
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from ale_grader_lib import ExcelEvaluator, approx_equal

xlsx_path = Path(${JSON.stringify(tmp)}) / "complex.xlsx"
wb = openpyxl.Workbook()
ws_param = wb.active
ws_param.title = "2020-08参数"
ws_param["A1"] = "基准本金"
ws_param["B1"] = 100000
ws_param["A2"] = "年利率"
ws_param["B2"] = "15.4%"
ws_param["A3"] = "起算日"
ws_param["B3"] = "2020-08-22"  # 周六

ws_calc = wb.create_sheet("汇总测算")
# 测试 WEEKDAY 周末顺延（2020-08-22 周六 -> 顺延2天到 2020-08-24 周一 = serial 44067）
ws_calc["A1"] = "顺延后起算日"
ws_calc["B1"] = "=IF(WEEKDAY('2020-08参数'!$B$3, 2)=6, DATEVALUE('2020-08参数'!$B$3)+2, IF(WEEKDAY('2020-08参数'!$B$3, 2)=7, DATEVALUE('2020-08参数'!$B$3)+1, DATEVALUE('2020-08参数'!$B$3)))"
ws_calc["A2"] = "月末到期日"
ws_calc["B2"] = "=EOMONTH(B1, 1)"  # 2020-09-30 = serial 44104
ws_calc["A3"] = "计息天数"
ws_calc["B3"] = "=DAYS(B2, B1)"    # 37 days
ws_calc["A4"] = "核定应付利息（元）"
ws_calc["B4"] = "=ROUND('2020-08参数'!$B$1 * 15.4% * (B3 / 365) + 0.0000001, 2)"
ws_calc["A5"] = "惰性防除零"
ws_calc["B5"] = "=IF(0=0, 2.005, 1/0)"
ws_calc["A6"] = "四舍五入核验"
ws_calc["B6"] = "=ROUND(B5, 2)"    # Excel ROUND(2.005, 2) == 2.01
ws_calc["A7"] = "合法零值项"
ws_calc["B7"] = "=0"
ws_calc["A8"] = "伪公式常量作弊"
ws_calc["B8"] = "=90000+0"
ws_calc["A9"] = "幂与取模符号"
ws_calc["B9"] = "=2^3 + MOD(-7, 3) + SIGN(-5) + INT(-1.2) + TRUNC(-1.9)"  # 8 + 2 - 1 - 2 - 1 = 6
ws_calc["A10"] = "选择与类型函数"
ws_calc["B10"] = "=CHOOSE(2, 10, 25, 40) + IF(AND(ISNUMBER(B6), NOT(ISBLANK(B6))), 5, 0)"  # 25 + 5 = 30
ws_calc["A11"] = "EDATE测试"
ws_calc["B11"] = "=YEAR(EDATE(DATE(2020,1,31), 1))*10000 + MONTH(EDATE(DATE(2020,1,31), 1))*100 + DAY(EDATE(DATE(2020,1,31), 1))"  # 20200229

# 明细表用于测试 t="shared" 共享公式与 SUMIFS / _xlfn.XLOOKUP
ws_rows = wb.create_sheet("明细")
ws_rows.append(["类别", "基数", "系数", "折算额"])
ws_rows.append(["有效", 1000, 0.5, "=B2*$C$2"])
ws_rows.append(["剔除", 2000, 0.5, "=B3*$C$2"])
ws_rows.append(["有效", 3000, 0.5, "=B4*$C$2"])
ws_calc["A12"] = "有效折算合计"
ws_calc["B12"] = '=SUMIFS(明细!D2:D4, 明细!A2:A4, "有效")'
ws_calc["A13"] = "XLOOKUP查找"
ws_calc["B13"] = '=_xlfn.XLOOKUP("剔除", 明细!A2:A4, 明细!B2:B4, 0)'
wb.save(xlsx_path)

# 将 明细!D2:D4 改写为真实 OOXML t="shared" 共享公式验证展开能力
raw_zip = xlsx_path.read_bytes()
patched_path = Path(${JSON.stringify(tmp)}) / "shared_formula.xlsx"
with zipfile.ZipFile(xlsx_path, "r") as zin, zipfile.ZipFile(patched_path, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "xl/worksheets/sheet3.xml":
            xml_s = data.decode("utf-8")
            xml_s = xml_s.replace("<f>B2*$C$2</f>", '<f t="shared" ref="D2:D4" si="0">B2*$C$2</f>')
            xml_s = xml_s.replace("<f>B3*$C$2</f>", '<f t="shared" si="0"/>')
            xml_s = xml_s.replace("<f>B4*$C$2</f>", '<f t="shared" si="0"/>')
            data = xml_s.encode("utf-8")
        zout.writestr(item, data)

ev = ExcelEvaluator(patched_path)
assert ev.evaluate_cell("汇总测算", "B3") == 37.0
assert approx_equal(ev.evaluate_cell("汇总测算", "B4"), round(100000 * 0.154 * 37 / 365, 2), abs_tol=1e-6)
assert ev.evaluate_cell("汇总测算", "B6") == 2.01
assert ev.is_live_formula("汇总测算", "B7", allow_zero_literal=True) is True
assert ev.is_live_formula("汇总测算", "B8", allow_zero_literal=True) is False
assert ev.evaluate_cell("汇总测算", "B9") == 6.0
assert ev.evaluate_cell("汇总测算", "B10") == 30.0
assert ev.evaluate_cell("汇总测算", "B11") == 20200229.0
assert ev.evaluate_cell("汇总测算", "B12") == 2000.0
assert ev.evaluate_cell("汇总测算", "B13") == 2000.0
assert ev.collect_formula_errors() == []

# 测试不锁行号与忽略（元）括号的 find_row_metric + probe 微扰动
sh_hit, coord_hit, val_hit, f_hit = ev.find_row_metric("核定应付利息")
assert sh_hit == "汇总测算" and coord_hit == "B4" and f_hit.startswith("=")
base_v, pert_v, delta_v = ev.probe(None, "核定应付利息", {"2020-08参数!B1": 200000})
assert approx_equal(pert_v, round(200000 * 0.154 * 37 / 365, 2), abs_tol=1e-6)
assert delta_v > 1500
print("ALL_PYTHON_ASSERTIONS_PASSED")
`;
      const proc = spawnSync('python3', ['-c', pyTestScript], {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain('ALL_PYTHON_ASSERTIONS_PASSED');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('DocxExtractor：三列/四列带备注 Word 表格提取零误杀，且精准区分正常带标点枚举与反转否定结论', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ale-lib-docx-'));
    try {
      const docxPath = join(tmp, 'report.docx');
      const mdContent = [
        '# 专项债权尽调复核报告',
        '',
        '| 核算终点指标 | 核定结果 | 测算口径与证据来源备注 | 单位 |',
        '| --- | --- | --- | --- |',
        '| 核定有效本金（人民币元） | ¥1,250,000.00 | 已剔除附件1第68页重复收据 150,000 元 | 元 |',
        '| 基准日应付利息 | 184,320.55 元 | 按 2020-08-20 前后分段重算 | 元 |',
        '| 建议入账口径 | 【按生效裁判口径登记】。详见第3节关于前手台账冲突之说明。 | 附件1第71页生效证明书 | - |',
        '',
        '补充意见：本项目不予采纳“按前手草稿全额计提”，而应采纳“按终本回款冲抵后余额列示”执行。',
        '',
        '## 签批结论',
        '',
        '☐ 同意报价    ☒ 调价复议    ☐ 暂缓收购',
        '',
        '| 指标 | 金额 | 报价判断 |',
        '| --- | --- | --- |',
        '| 腾徽基准分配额 | 20,560.45 | 仅基准情景达到目标 |',
      ].join('\n');
      await writeFile(docxPath, await buildDocx(mdContent, { style: 'legal' }));

      const pyScript = `
import sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from ale_grader_lib import DocxExtractor

doc = DocxExtractor(${JSON.stringify(docxPath)})
assert doc.extract_key_number("核定有效本金") == 1250000.0
assert doc.extract_key_number("基准日应付利息") == 184320.55
assert doc.extract_enum_choice("建议入账口径", ["按生效裁判口径登记", "按前手送审口径登记"]) == "按生效裁判口径登记"
assert doc.extract_enum_choice("补充意见", ["按前手草稿全额计提", "按终本回款冲抵后余额列示"]) == "按终本回款冲抵后余额列示"
assert doc.extract_enum_choice("签批结论", ["同意报价", "调价复议", "暂缓收购"]) == "调价复议"
assert doc.extract_enum_choice("报价判断", ["两情景均达到目标", "仅基准情景达到目标", "两情景均低于目标"]) == "仅基准情景达到目标"
print("DOCX_OK")
`;
      const proc = spawnSync('python3', ['-c', pyScript], {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain('DOCX_OK');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('office_lint.py：正常 .xlsx/.docx 返回退出码 0 并预览重算值，遇到 #DIV/0! 或循环引用返回退出码 1 精准定位', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ale-office-lint-'));
    try {
      const goodDocx = join(tmp, 'ok.docx');
      await writeFile(goodDocx, await buildDocx('# 标题\n\n| A | B |\n| --- | --- |\n| X | 100 |\n'));

      const mkXlsxPy = `
import openpyxl
from pathlib import Path
p_ok = Path(${JSON.stringify(tmp)}) / "ok.xlsx"
wb1 = openpyxl.Workbook()
ws1 = wb1.active
ws1.title = "Calc"
ws1["A1"] = 120
ws1["A2"] = "=WEEKDAY(DATE(2020,8,20), 2)"
ws1["A3"] = "=ROUND(A1 * 1.15, 2)"
wb1.save(p_ok)

p_bad = Path(${JSON.stringify(tmp)}) / "broken.xlsx"
wb2 = openpyxl.Workbook()
ws2 = wb2.active
ws2["A1"] = "=10/0"
ws2["B1"] = "=B2+1"
ws2["B2"] = "=B1+1"
wb2.save(p_bad)
`;
      expect(spawnSync('python3', ['-c', mkXlsxPy], { encoding: 'utf8' }).status).toBe(0);

      const okRes = spawnSync('python3', [OFFICE_LINT_PATH, join(tmp, 'ok.xlsx'), goodDocx], { encoding: 'utf8' });
      expect(okRes.status).toBe(0);
      expect(okRes.stdout).toContain('Total Formula Errors: 0');
      expect(okRes.stdout).toContain('A3=138 [=ROUND(A1 * 1.15, 2)]');
      expect(okRes.stdout).toContain('[Table #1] 2 rows x 2 cols');

      const badRes = spawnSync('python3', [OFFICE_LINT_PATH, join(tmp, 'broken.xlsx'), '--json'], { encoding: 'utf8' });
      expect(badRes.status).toBe(1);
      const parsed = JSON.parse(badRes.stdout);
      const errCodes = parsed[0].sheets[0].formula_errors.map((e: any) => e.error);
      expect(errCodes).toContain('#DIV/0!');
      expect(errCodes).toContain('#CYCLE!');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('delivery.ts 端到端集成：自动注入 tests/ale_grader_lib.py 与 environment/tools/office_lint.py 并通过 CHK-01..05 动态实测', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ale-delivery-e2e-'));
    try {
      const inputText = '原始卷宗正文：借款本金 100000 元，表层汇总误记回款 10000 元，第71页银行回单证实实际回款 30000 元。';
      const inputSha = sha256Hex(inputText);

      const conciseGradePy = [
        '#!/usr/bin/env python3',
        'import sys',
        'from pathlib import Path',
        'sys.path.insert(0, str(Path(__file__).resolve().parent))',
        'from ale_grader_lib import DocxExtractor, ExcelEvaluator, GradeReporter, SubCheck, approx_equal, parse_grade_cli_args, verify_frozen_inputs',
        '',
        'EXPECTED_INPUTS = {"附件1.txt": ' + JSON.stringify(inputSha) + '}',
        '',
        'def check_c01_net_principal(wb: ExcelEvaluator):',
        '    hit = wb.find_row_metric("核定未清本金")',
        '    if not hit:',
        '        return [SubCheck("value", False, 70000, None), SubCheck("live_probe", False, "delta=1", None)]',
        '    sh, coord, val, _ = hit',
        '    live_ok = wb.is_live_formula(sh, coord)',
        '    try:',
        '        _, _, delta = wb.probe(sh, coord, {"合同本金": 110000})',
        '        probe_ok = live_ok and approx_equal(delta, 10000, abs_tol=0.01)',
        '    except Exception:',
        '        probe_ok = False',
        '    return [SubCheck("value", approx_equal(val, 70000, abs_tol=0.02), 70000, val), SubCheck("live_probe", probe_ok, 10000, live_ok)]',
        '',
        'def check_c02_docx_alignment(doc: DocxExtractor, wb: ExcelEvaluator):',
        '    d_val = doc.extract_key_number("核定未清本金")',
        '    hit = wb.find_row_metric("核定未清本金")',
        '    x_val = hit[2] if hit else None',
        '    aligned = d_val is not None and x_val is not None and approx_equal(d_val, x_val, abs_tol=0.02) and approx_equal(d_val, 70000, abs_tol=0.02)',
        '    return [SubCheck("docx_xlsx_match", aligned, 70000, d_val)]',
        '',
        'def check_c03_audit_code(doc: DocxExtractor):',
        '    choice = doc.extract_enum_choice("处理结论", ["按银行回单冲抵", "按前手汇总冲抵"])',
        '    return [SubCheck("enum", choice == "按银行回单冲抵", "按银行回单冲抵", choice)]',
        '',
        'def main():',
        '    args = parse_grade_cli_args()',
        '    tests_dir = Path(__file__).resolve().parent',
        '    rep = GradeReporter(rubric_path=tests_dir / "rubric.json", run_id=args.run_id)',
        '    in_ok, mismatches = verify_frozen_inputs(EXPECTED_INPUTS, input_dir=args.input_dir, artifacts_dir=args.artifacts_dir, tests_dir=tests_dir)',
        '    art = Path(args.artifacts_dir)',
        '    xlsx_p, docx_p = art / "output/model.xlsx", art / "output/memo.docx"',
        '    if not xlsx_p.is_file() or not docx_p.is_file():',
        '        rep.fail_all_missing()',
        '        rep.write(args.output)',
        '        return',
        '    wb, doc = ExcelEvaluator(xlsx_p), DocxExtractor(docx_p)',
        '    rep.add_subchecks("C01_net_principal", check_c01_net_principal(wb), "output/model.xlsx")',
        '    rep.add_subchecks("C02_docx_alignment", check_c02_docx_alignment(doc, wb), "output/memo.docx")',
        '    rep.add_subchecks("C03_audit_code", check_c03_audit_code(doc), "output/memo.docx")',
        '    rep.write(args.output, force_fail_reason=f"input_tampered:{mismatches}" if not in_ok else None)',
        '',
        'if __name__ == "__main__":',
        '    main()',
        '',
      ].join('\n');

      const draft = {
        question: '请核查 `/workspace/input/附件1.txt`，输出 `/workspace/output/model.xlsx` 与 `/workspace/output/memo.docx`，汇总 `合同本金、已证实回款、核定未清本金` 与 `处理结论`（从 `按银行回单冲抵`、`按前手汇总冲抵` 中择一）。',
        answer_approach:
          '推导说明\n<<<ALE_PACKAGE_JSON\n' +
          JSON.stringify({
            task_card: {
              schema_version: 'ale.task_card.v1',
              task_id: 'FIN-TEST-LIB-001',
              version: '1.0.0',
              domain: 'business_finance',
              sub_domain: 'financial_due_diligence',
              task_family: 'debt_reconciliation',
              canary: 'ALE-CANARY-FIN-TEST-LIB-001-abcdef012345',
              network: { allow_internet: false },
              inputs: [{ path: 'environment/input/附件1.txt', sha256: inputSha }],
              deliverables_contract: [
                { path: 'output/model.xlsx', format: 'xlsx', required: true },
                { path: 'output/memo.docx', format: 'docx', required: true },
              ],
            },
            env_spec: {
              environment_id: 'env-py312-office',
              kind: 'docker',
              base_image: 'debian:bookworm-slim',
              visibility_isolation: {
                build: ['Dockerfile', 'tools/office_lint.py'],
                mount_readonly: ['environment/input -> /workspace/input:ro', 'environment/tools -> /workspace/tools:ro'],
                execute_writable: ['/workspace/output', '/tmp'],
                forbidden_in_agent_view: ['tests/', 'solution/'],
              },
            },
            dockerfile: 'FROM debian:bookworm-slim\nWORKDIR /workspace\n',
            rubric_spec: {
              schema_version: 'ale.rubric.v1',
              task_id: 'FIN-TEST-LIB-001',
              scale: { normalization: 'weighted_mean', pass_threshold: 0.85, reference_target: { mode: 'deterministic', min_score: 1.0 } },
              criteria: [
                {
                  criterion_id: 'C01_net_principal',
                  prompt_basis: 'instruction.md',
                  source_locator: '附件1.txt#p71',
                  observation_locator: 'output/model.xlsx',
                  condition: '活公式重算核定未清本金=70000',
                  weight: 50,
                  tolerance: { abs_tol: 0.02 },
                  is_key_gate: true,
                  grader_mapping: 'check_c01_net_principal',
                },
                {
                  criterion_id: 'C02_docx_alignment',
                  prompt_basis: 'instruction.md',
                  source_locator: '附件1.txt#p71',
                  observation_locator: 'output/memo.docx',
                  condition: 'Word 与 Excel 勾稽一致=70000',
                  weight: 30,
                  tolerance: { abs_tol: 0.02 },
                  is_key_gate: true,
                  grader_mapping: 'check_c02_docx_alignment',
                },
                {
                  criterion_id: 'C03_audit_code',
                  prompt_basis: 'instruction.md',
                  source_locator: '附件1.txt#p71',
                  observation_locator: 'output/memo.docx',
                  condition: '处理结论为按银行回单冲抵',
                  weight: 20,
                  tolerance: 'exact',
                  is_key_gate: false,
                  grader_mapping: 'check_c03_audit_code',
                },
              ],
            },
            grade_py: conciseGradePy,
            solve_sh: '#!/usr/bin/env bash\nset -euo pipefail\n',
            reference_files: [
              {
                path: 'output/model.xlsx',
                kind: 'xlsx',
                content: '',
                sheets: [
                  {
                    name: '汇总',
                    columns: ['指标', '金额'],
                    rows: [
                      ['合同本金', 100000],
                      ['已证实回款', 30000],
                      ['核定未清本金', { formula: 'B2-B3', cached_value: 70000 }],
                    ],
                  },
                ],
              },
              {
                path: 'output/memo.docx',
                kind: 'docx',
                content: '# 复核备忘\n\n| 项目 | 数值 |\n| --- | --- |\n| 核定未清本金 | 70000 |\n| 处理结论 | 按银行回单冲抵 |\n',
              },
            ],
            variant_fixtures: [
              {
                id: 'B03_equivalent_pass',
                kind: 'equivalent_pass',
                files: [
                  {
                    path: 'output/model.xlsx',
                    kind: 'xlsx',
                    content: '',
                    sheets: [
                      {
                        name: 'SheetA',
                        columns: ['名称', '数值（元）'],
                        rows: [
                          ['已证实回款', 30000],
                          ['合同本金', 100000],
                          ['核定未清本金（元）', { formula: 'MAX(0, B3-B2)', cached_value: 70000 }],
                        ],
                      },
                    ],
                  },
                  {
                    path: 'output/memo.docx',
                    kind: 'docx',
                    content:
                      '# 备忘\n\n| 指标名称 | 核定结果 | 备注与来源 |\n| --- | --- | --- |\n| 核定未清本金（元） | ¥70,000.00 | 见第71页回单 |\n| 处理结论 | 「按银行回单冲抵」。经核实表层汇总漏计。 | 终审确认 |\n',
                  },
                ],
              },
              {
                id: 'M10_shallow_decoy_trap',
                kind: 'shallow_decoy_trap',
                files: [
                  {
                    path: 'output/model.xlsx',
                    kind: 'xlsx',
                    content: '',
                    sheets: [
                      {
                        name: '汇总',
                        columns: ['指标', '金额'],
                        rows: [
                          ['合同本金', 100000],
                          ['已证实回款', 10000],
                          ['核定未清本金', { formula: 'B2-B3', cached_value: 90000 }],
                        ],
                      },
                    ],
                  },
                  {
                    path: 'output/memo.docx',
                    kind: 'docx',
                    content: '# 备忘\n\n| 项目 | 数值 |\n| --- | --- |\n| 核定未清本金 | 90000 |\n| 处理结论 | 按前手汇总冲抵 |\n',
                  },
                ],
              },
              {
                id: 'M01_skeleton',
                kind: 'skeleton_or_constant',
                files: [
                  {
                    path: 'output/model.xlsx',
                    kind: 'xlsx',
                    content: '',
                    sheets: [{ name: '汇总', columns: ['指标', '金额'], rows: [['核定未清本金', '']] }],
                  },
                  { path: 'output/memo.docx', kind: 'docx', content: '# 空白骨架\n' },
                ],
              },
              {
                id: 'M02_static_const',
                kind: 'skeleton_or_constant',
                files: [
                  {
                    path: 'output/model.xlsx',
                    kind: 'xlsx',
                    content: '',
                    sheets: [
                      {
                        name: '汇总',
                        columns: ['指标', '金额'],
                        rows: [
                          ['合同本金', 100000],
                          ['核定未清本金', 88888],
                        ],
                      },
                    ],
                  },
                  { path: 'output/memo.docx', kind: 'docx', content: '# 备忘\n\n核定未清本金：88888\n' },
                ],
              },
              {
                id: 'M08_cross_doc_mismatch',
                kind: 'single_factor_fail',
                target_criterion_id: 'C02_docx_alignment',
                expect_task_fail: true,
                must_remain_passed_ids: ['C01_net_principal', 'C03_audit_code'],
                files: [
                  {
                    path: 'output/model.xlsx',
                    kind: 'xlsx',
                    content: '',
                    sheets: [
                      {
                        name: '汇总',
                        columns: ['指标', '金额'],
                        rows: [
                          ['合同本金', 100000],
                          ['已证实回款', 30000],
                          ['核定未清本金', { formula: 'B2-B3', cached_value: 70000 }],
                        ],
                      },
                    ],
                  },
                  {
                    path: 'output/memo.docx',
                    kind: 'docx',
                    content: '# 复核备忘\n\n| 项目 | 数值 |\n| --- | --- |\n| 核定未清本金 | 65000 |\n| 处理结论 | 按银行回单冲抵 |\n',
                  },
                ],
              },
            ],
          }) +
          '\nALE_PACKAGE_JSON>>>',
      };

      const res = await materializeAleTaskFromDraft({
        draft,
        taskIdFallback: 'FIN-TEST-LIB-001',
        inputMaterials: [{ name: '附件1.txt', text: inputText }],
        outputParentDir: tmp,
        executeDynamic: true,
      });

      expect(existsSync(join(res.task_dir, 'tests/ale_grader_lib.py'))).toBe(true);
      expect(existsSync(join(res.task_dir, 'environment/tools/office_lint.py'))).toBe(true);
      const dfBuilt = await readFile(join(res.task_dir, 'environment/Dockerfile'), 'utf8');
      expect(dfBuilt).toContain('COPY tools/ /workspace/tools/');

      const failed = res.summary.records.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
      expect(failed).toEqual([]);
      const dynCheck = res.summary.records.find((r) => r.check_id === 'CHK-05-DYNAMIC-QA');
      expect(dynCheck?.status).toBe('PASS');

      // 预检同步通过
      const pre = await preflightTask(res.task_dir, 'gpt-6.1-sol');
      expect(pre.input_files).toEqual(['附件1.txt']);

      // 确定性 DOCX 构建与 .docx 输入契约解析验证（同内容跨时区/多次生成 SHA-256 严格一致，拒绝写纯文本入 .docx）
      const { buildDeterministicAleMaterialDocx, resolveAleInputMaterials } = await import('./docx-material');
      const { sha256Hex: hashHex } = await import('./contracts');
      const docxA = await buildDeterministicAleMaterialDocx({ text: inputText });
      const docxB = await buildDeterministicAleMaterialDocx({ text: inputText });
      expect(Buffer.from(docxA).subarray(0, 4).toString('binary')).toBe('PK\x03\x04');
      expect(hashHex(docxA)).toBe(hashHex(docxB));

      const resolvedDocx = await resolveAleInputMaterials(
        [{ path: 'environment/input/附件1.docx', sha256: hashHex(docxA) }],
        [{ id: 'm1', sha256: inputSha, text: inputText }],
      );
      expect(resolvedDocx.length).toBe(1);
      expect(resolvedDocx[0]!.name).toBe('附件1.docx');
      expect(resolvedDocx[0]!.bytes).toBeDefined();
      expect(hashHex(resolvedDocx[0]!.bytes!)).toBe(hashHex(docxA));

      // 写入损坏非 DOCX 内容进 附件1.docx 时，preflightTask 立即以格式阻断
      const brokenDir = join(tmp, 'broken-docx');
      await mkdir(join(brokenDir, 'environment', 'input'), { recursive: true });
      await writeFile(join(brokenDir, 'instruction.md'), '请读取 `/workspace/input/附件1.docx`\n', 'utf8');
      await writeFile(join(brokenDir, 'task_card.json'), JSON.stringify({ task_id: 'T1', deliverables_contract: [] }), 'utf8');
      await writeFile(join(brokenDir, 'environment', 'env.json'), JSON.stringify({ timeout_sec: 60 }), 'utf8');
      await writeFile(join(brokenDir, 'environment', 'reset.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await writeFile(join(brokenDir, 'environment', 'input', '附件1.docx'), 'plain text fake docx', 'utf8');
      const brokenPre = await preflightTask(brokenDir, 'gpt-6.1-sol');
      expect(brokenPre.blockers.some((b) => b.includes('不是合法的 DOCX ZIP 二进制文件'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
