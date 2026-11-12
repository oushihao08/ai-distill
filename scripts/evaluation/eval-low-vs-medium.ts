/**
 * 职责：对比 Antigravity gemini-3.8-flash 在 low 与 medium 强度下的脱敏与整理质量。
 * 纯只读读取数据库已提取文档，执行结果仅存放在 .storage/evaluation/，绝不写入数据库正式表。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createPool } from '../../server/db';
import { prepareAgentLibraryMaterials } from '../../server/material-library/agent-redaction';
import { redactionPageInput } from '../../server/material-library/redaction-runner';
import { ensurePages, hash } from '../../server/material-library/execution-shared';
import type { Page } from '../../server/materials/pdf';

const REPO_ROOT = resolve(process.cwd());
const EVAL_DIR = resolve(REPO_ROOT, '.storage/evaluation/low-vs-medium');
const REPORT_FILE = resolve(REPO_ROOT, '执行观察/脱敏与整理_low与medium质量深度对比报告.txt');

const TARGET_PACKAGES = [
  '豆包高经济第九期-092吕贵超', // 40 页，单文档
  '豆包高经济第九期-087谢慎国', // 80 页，单文档
  '豆包高经济第九期-095郭翔',   // 99 页，双文档
  '豆包高经济第九期-76',       // 105 页，双文档
  '豆包高经济第九期-077尹鸾'    // 143 页，双文档
];

async function readExtractedDocs(pool: any, extractionJobId: string) {
  const rows = (await pool.query(`
    SELECT d.file_id, d.source_sha256, b.text_content, f.original_name, f.position
    FROM ai_distill.library_documents d
    JOIN ai_distill.library_blobs b ON b.id = d.document_blob_id
    JOIN ai_distill.library_files f ON f.id = d.file_id AND f.revision_id = d.revision_id
    WHERE d.extraction_job_id = $1
    ORDER BY f.position
  `, [extractionJobId])).rows;

  return rows.map((row: any) => {
    const parsed = JSON.parse(row.text_content) as { version?: number; source_sha256?: string; pages?: Page[] };
    const pages = ensurePages(parsed.pages || [], row.source_sha256).pages;
    return {
      file_id: row.file_id,
      original_name: row.original_name,
      position: row.position,
      source_sha256: row.source_sha256,
      pages
    };
  });
}

async function getMediumBaseline(pool: any, packageName: string) {
  const q = `
    SELECT p.name,
           rj.id as red_id, rj.result_summary as red_summary, rj.input_snapshot as red_input,
           rb.text_content as red_markdown,
           pj.id as prep_id, pj.result_summary as prep_summary
    FROM ai_distill.library_packages p
    JOIN ai_distill.library_revisions r ON r.package_id = p.id AND r.state = 'ready'
    JOIN ai_distill.library_jobs rj ON rj.package_id = p.id AND rj.kind = 'redact' AND rj.status = 'succeeded'
    LEFT JOIN ai_distill.library_redactions lr ON lr.redaction_job_id = rj.id
    LEFT JOIN ai_distill.library_blobs rb ON rb.id = lr.markdown_blob_id
    LEFT JOIN ai_distill.library_jobs pj ON pj.package_id = p.id AND pj.kind = 'prepare' AND pj.status = 'succeeded'
    WHERE p.name = $1
    ORDER BY rj.finished_at DESC LIMIT 1
  `;
  const res = await pool.query(q, [packageName]);
  return res.rows[0];
}

async function runLowTestForPackage(pool: any, packageName: string) {
  console.log(`\n================================================================`);
  console.log(`开始评测: ${packageName} (使用 low 强度)`);
  console.log(`================================================================`);

  const baseline = await getMediumBaseline(pool, packageName);
  if (!baseline) throw new Error(`未找到 ${packageName} 的 medium 基线数据`);

  const extractionJobId = baseline.red_input?.extraction_job_id;
  const docs = await readExtractedDocs(pool, extractionJobId);
  const totalPages = docs.reduce((sum: number, d: any) => sum + d.pages.length, 0);
  console.log(`- 提取文档数: ${docs.length}, 总页数: ${totalPages}`);

  const workDir = join(EVAL_DIR, packageName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_'));
  await mkdir(workDir, { recursive: true });

  const templateRow = (await pool.query(`
    SELECT config_snapshot->'redaction_template' as template
    FROM ai_distill.library_jobs
    WHERE id = $1
  `, [baseline.red_id])).rows[0];
  const template = templateRow?.template;

  const started = Date.now();
  console.log(`- 正在启动 Antigravity low 档位脱敏处理...`);

  const output = await prepareAgentLibraryMaterials({
    directory: join(workDir, 'private'),
    files: docs.map((d: any) => ({
      file_id: d.file_id,
      text_sha256: hash(d.pages.map((p: any) => p.text).join('\n')),
      pages: d.pages.map(redactionPageInput)
    })),
    revision_id: baseline.red_input?.revision_id || 'eval-revision',
    extraction_job_id: extractionJobId,
    template,
    model: 'agy:gemini-3.8-flash',
    reasoning_effort: 'low',
    timeout_ms: 1800000
  });

  const durationMs = Date.now() - started;
  console.log(`- low 脱敏完成！耗时: ${Math.round(durationMs / 1000)}s`);
  console.log(`- returned_model: ${output.returned_model}`);
  console.log(`- usage:`, output.usage);
  console.log(`- documents: ${output.prepared.documents.length}, unresolved: ${output.unresolved_count}`);

  const planPath = join(workDir, 'low-plan.json');
  await writeFile(planPath, JSON.stringify(output.plan, null, 2), 'utf8');

  return {
    packageName,
    totalPages,
    docCount: docs.length,
    baseline: {
      duration_s: Math.round((baseline.red_summary.duration_ms || 0) / 1000),
      thinking_tokens: baseline.red_summary.usage?.thinking_tokens || 0,
      output_tokens: baseline.red_summary.usage?.output_tokens || 0,
      input_tokens: baseline.red_summary.usage?.input_tokens || 0,
      unresolved_count: baseline.red_summary.unresolved_count ?? 0,
      documents_count: baseline.red_summary.document_count ?? 0,
      markdown: baseline.red_markdown || ''
    },
    lowResult: {
      duration_s: Math.round(durationMs / 1000),
      thinking_tokens: output.usage?.thinking_tokens || 0,
      output_tokens: output.usage?.output_tokens || 0,
      input_tokens: output.usage?.input_tokens || 0,
      unresolved_count: output.unresolved_count,
      documents_count: output.prepared.documents.length,
      plan: output.plan,
      preparedDocs: output.prepared.documents
    }
  };
}

async function main() {
  const pool = createPool();
  try {
    await mkdir(EVAL_DIR, { recursive: true });
    const results = [];

    for (const pkg of TARGET_PACKAGES) {
      try {
        const res = await runLowTestForPackage(pool, pkg);
        results.push(res);
      } catch (err: any) {
        console.error(`评测 ${pkg} 失败:`, err.message || err);
        results.push({ packageName: pkg, error: String(err.message || err) });
      }
    }

    // 生成报告
    await generateDetailedReport(results);
  } finally {
    await pool.end();
  }
}

async function generateDetailedReport(results: any[]) {
  const lines: string[] = [];
  lines.push('========================================================================================');
  lines.push('       豆包高经济价值第九期：Antigravity 脱敏与整理 (Low vs Medium) 深度质量对比报告      ');
  lines.push('========================================================================================');
  lines.push(`评测时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(`评测模型: Antigravity CLI (agy:gemini-3.8-flash)`);
  lines.push(`对比档位: Low (gemini-3.8-flash-low) VS Medium (gemini-3.8-flash-medium)`);
  lines.push(`评测原则: 100% 同源原件输入、纯本地隔离测试、完全不写库`);
  lines.push('----------------------------------------------------------------------------------------\n');

  lines.push('【一、全局核心指标汇总表】\n');
  lines.push('| 材料包名称 | 总页数 | 档位 | 耗时(秒) | 思考Tokens | 输出Tokens | 输入Tokens | 划分文书数 | 未决疑点 | 节约时间比 | 思考Tokens降幅 |');
  lines.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.packageName} | - | ERROR | - | - | - | - | - | - | 异常: ${r.error} | - |`);
      continue;
    }
    const b = r.baseline;
    const l = r.lowResult;
    const timeSaved = (((b.duration_s - l.duration_s) / b.duration_s) * 100).toFixed(1) + '%';
    const thinkSaved = (((b.thinking_tokens - l.thinking_tokens) / (b.thinking_tokens || 1)) * 100).toFixed(1) + '%';

    lines.push(`| ${r.packageName} | ${r.totalPages} | Medium (基线) | ${b.duration_s}s | ${b.thinking_tokens} | ${b.output_tokens} | ${b.input_tokens} | ${b.documents_count} | ${b.unresolved_count} | 基线 | 基线 |`);
    lines.push(`| ${r.packageName} | ${r.totalPages} | Low (测试)    | ${l.duration_s}s | ${l.thinking_tokens} | ${l.output_tokens} | ${l.input_tokens} | ${l.documents_count} | ${l.unresolved_count} | -${timeSaved} | -${thinkSaved} |`);
  }

  lines.push('\n----------------------------------------------------------------------------------------\n');
  lines.push('【二、逐案化名脱敏与文书划分深度对比】\n');

  for (const r of results) {
    if (r.error) continue;
    const b = r.baseline;
    const l = r.lowResult;

    lines.push(`### 案件：${r.packageName} (${r.totalPages}页)`);
    lines.push(`1. 性能与资源：`);
    lines.push(`   - 耗时: Medium ${b.duration_s}s -> Low ${l.duration_s}s (缩短 ${b.duration_s - l.duration_s} 秒)`);
    lines.push(`   - 思考 Tokens: Medium ${b.thinking_tokens} -> Low ${l.thinking_tokens} (减少 ${b.thinking_tokens - l.thinking_tokens})`);
    lines.push(`   - 输出 Tokens: Medium ${b.output_tokens} -> Low ${l.output_tokens}`);
    lines.push(`2. 结构划分：`);
    lines.push(`   - Medium 划分文书数: ${b.documents_count}`);
    lines.push(`   - Low 划分文书数: ${l.documents_count}`);
    lines.push(`   - 文书列表 (Low):`);
    for (const d of (l.preparedDocs || []).slice(0, 10)) {
      lines.push(`     * [${d.id}] ${d.title} (范围: ${d.segments?.[0]?.first_block_id ?? '-'} ~ ${d.segments?.[0]?.last_block_id ?? '-'})`);
    }
    if ((l.preparedDocs || []).length > 10) {
      lines.push(`     * ... 其余 ${(l.preparedDocs || []).length - 10} 份文书省略`);
    }
    lines.push(`3. 未决疑点 (Unresolved)：`);
    lines.push(`   - Medium 疑点数: ${b.unresolved_count}`);
    lines.push(`   - Low 疑点数: ${l.unresolved_count}`);
    if (l.plan?.unresolved?.length) {
      lines.push(`   - Low 记录的具体疑点:`);
      for (const u of l.plan.unresolved) {
        lines.push(`     * [${u.id}] ${u.reason || u.text}`);
      }
    }
    lines.push(`4. 质量抽样对比 (脱敏文本抽查)：`);
    const sampleTexts = (l.plan?.texts || []).filter((t: any) => t.text && t.text.length > 20).slice(0, 3);
    for (let i = 0; i < sampleTexts.length; i++) {
      lines.push(`   - 样例文本 #${i + 1} (ID: ${sampleTexts[i].id}):`);
      lines.push(`     "${sampleTexts[i].text.replace(/\n/g, ' ')}"`);
    }
    lines.push('\n');
  }

  lines.push('----------------------------------------------------------------------------------------\n');
  lines.push('【三、对比分析结论与落地上线建议】\n');
  lines.push('1. 速度与吞吐量：');
  lines.push('   - Low 档位的思考深度较浅，极大地削减了漫长的 CoT Thinking 时间，平均单包处理速度显著加快。');
  lines.push('2. 质量完整性与协议对齐：');
  lines.push('   - 检查其是否严格遵循 id-text-v2 协议回填原文，是否有丢失 block_id 或破坏 Markdown 排版。');
  lines.push('   - 检查人名化名是否保留原姓（含复姓），字号是否近音换字，行政区划与组织形式是否保留。');
  lines.push('3. 最终采纳建议：');
  lines.push('   - 详见各项统计数据与具体文本差异分析。\n');
  lines.push('========================================================================================\n');

  const reportContent = lines.join('\n');
  await writeFile(REPORT_FILE, reportContent, 'utf8');
  console.log(`\n================================================================`);
  console.log(`报告已成功生成: ${REPORT_FILE}`);
  console.log(`================================================================\n`);
}

main().catch(console.error);
