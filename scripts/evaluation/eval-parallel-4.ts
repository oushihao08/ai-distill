/**
 * 职责：并发执行剩余 4 个同源材料包的 low 档位脱敏评测，结果写入各自目录的 low-result.json，不入库。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPool } from '../../server/db';
import { prepareAgentLibraryMaterials } from '../../server/material-library/agent-redaction';
import { redactionPageInput } from '../../server/material-library/redaction-runner';
import { ensurePages, hash } from '../../server/material-library/execution-shared';
import type { Page } from '../../server/materials/pdf';

const REPO_ROOT = resolve(process.cwd());
const EVAL_DIR = resolve(REPO_ROOT, '.storage/evaluation/low-vs-medium');

const PARALLEL_PACKAGES = [
  '豆包高经济第九期-087谢慎国',
  '豆包高经济第九期-095郭翔',
  '豆包高经济第九期-76',
  '豆包高经济第九期-077尹鸾'
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
           rj.id as red_id, rj.result_summary as red_summary, rj.input_snapshot as red_input
    FROM ai_distill.library_packages p
    JOIN ai_distill.library_revisions r ON r.package_id = p.id AND r.state = 'ready'
    JOIN ai_distill.library_jobs rj ON rj.package_id = p.id AND rj.kind = 'redact' AND rj.status = 'succeeded'
    WHERE p.name = $1
    ORDER BY rj.finished_at DESC LIMIT 1
  `;
  const res = await pool.query(q, [packageName]);
  return res.rows[0];
}

async function runSingle(pool: any, packageName: string) {
  const baseline = await getMediumBaseline(pool, packageName);
  if (!baseline) throw new Error(`未找到 ${packageName} 的 medium 基线数据`);

  const extractionJobId = baseline.red_input?.extraction_job_id;
  const docs = await readExtractedDocs(pool, extractionJobId);
  const totalPages = docs.reduce((sum: number, d: any) => sum + d.pages.length, 0);

  const workDir = join(EVAL_DIR, packageName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_'));
  await mkdir(workDir, { recursive: true });

  const templateRow = (await pool.query(`
    SELECT config_snapshot->'redaction_template' as template
    FROM ai_distill.library_jobs
    WHERE id = $1
  `, [baseline.red_id])).rows[0];
  const template = templateRow?.template;

  const started = Date.now();
  console.log(`[启动 Low 脱敏] ${packageName} (${totalPages}页)...`);

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
  console.log(`[完成 Low 脱敏] ${packageName} 耗时: ${Math.round(durationMs / 1000)}s, 文书数: ${output.prepared.documents.length}, 疑点: ${output.unresolved_count}`);

  await writeFile(join(workDir, 'low-plan.json'), JSON.stringify(output.plan, null, 2), 'utf8');
  await writeFile(join(workDir, 'low-meta.json'), JSON.stringify({
    packageName,
    totalPages,
    duration_ms: durationMs,
    duration_s: Math.round(durationMs / 1000),
    returned_model: output.returned_model,
    usage: output.usage,
    unresolved_count: output.unresolved_count,
    documents_count: output.prepared.documents.length,
    documents: output.prepared.documents.map((d: any) => ({ id: d.id, title: d.title, text_len: d.text?.length || 0 }))
  }, null, 2), 'utf8');
}

async function main() {
  const pool = createPool();
  try {
    await Promise.allSettled(PARALLEL_PACKAGES.map(pkg => runSingle(pool, pkg)));
    console.log('4 个并发 Low 脱敏评测全部结束。');
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
