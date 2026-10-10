/**
 * 职责：MinerU CLI PDF 适配器：限制子进程环境、解析带页码 JSON 并支持超时和取消。
 * 关键方法与用途：`parseMineruJson()` 解析带页码输出；`MineruCliPdfExtractor` 管理子进程、超时和取消。
 * 使用场景：由统一 PDF 提取接口创建并被文档提取器调用。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from '../pdf';
import { logEvent } from '../../logging';
import type { Page } from '../pdf';
import type { PdfExtractionProvider, PdfExtractionResult } from './types';

// Increment when conversion semantics change: old text-only caches are incomplete.
export const MINERU_OCR_VERSION = 'mineru-open-api-json-v2';
interface MineruBlock { page_idx: number; type?: string; [key: string]: unknown }

export function parseMineruJson(value: unknown, pageCount: number): Page[] {
 if (!Array.isArray(value) || !Number.isInteger(pageCount) || pageCount < 1) throw new Error('MinerU JSON页级结果无效');
 const pages = Array.from({ length: pageCount }, () => ({ parts: [] as string[], issues: new Set<string>() }));
 for (const block of value as MineruBlock[]) {
  if (!block || !Number.isInteger(block.page_idx) || block.page_idx < 0 || block.page_idx >= pageCount) throw new Error('MinerU JSON块缺少有效页码');
  const page = pages[block.page_idx]!;
  // Preserve HTML tables verbatim, including merged cells; captions precede bodies.
  const fields = ['table_caption', 'image_caption', 'text', 'table_body', 'html', 'latex', 'table_footnote', 'image_footnote'];
  const parts: string[] = [];
  for (const field of fields) {
   const content = block[field];
   if (typeof content === 'string' && content.trim()) parts.push(content);
   else if (Array.isArray(content)) {
    if (content.some(item => typeof item !== 'string')) page.issues.add('unsupported_block_content');
    parts.push(...content.filter((item): item is string => typeof item === 'string' && !!item.trim()));
   } else if (content !== undefined && content !== null && content !== '') page.issues.add('unsupported_block_content');
  }
  page.parts.push(...parts);
  if (!parts.length) page.issues.add(block.type === 'image' ? 'image_without_text' : 'block_without_text');
  if (parts.some(part => part.includes('[NO TEXT]'))) page.issues.add('no_text_placeholder');
 }
 return pages.map(({ parts, issues }, index) => {
  const text = parts.join('\n').trim();
  if (!text) issues.add('empty_page');
  return { page: index + 1, text, method: 'ocr', model: 'mineru-vlm', ...(issues.size ? { issues: [...issues] } : {}) };
 });
}

export class MineruCliPdfExtractor implements PdfExtractionProvider {
 readonly id = 'mineru-cli' as const;
 constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

 async extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult> {
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const info = await command(['pdfinfo', path]);
  const pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF页数无效');
  const token = this.env.MINERU_KEY;
  if (!token) throw new Error('未配置 MINERU_KEY');
  if (signal?.aborted) throw new Error('PDF提取已取消');

  const diagnosticId = crypto.randomUUID();
  const diagnosticDirectory = resolve(this.env.STORAGE_DIR ?? '.storage', '.mineru-diagnostics', diagnosticId);
  await mkdir(diagnosticDirectory, { recursive: true, mode: 0o700 });
  const executable = this.env.MINERU_CLI_PATH ?? resolve(process.cwd(), '.storage/tools/mineru-open-api');
  const child = Bun.spawn([executable, 'extract', path, '--model', 'vlm', '--ocr', '--language', 'ch', '-f', 'json', '--timeout', '1800'], {
   env: { PATH: this.env.PATH ?? '/usr/bin:/bin', HOME: this.env.HOME ?? '', MINERU_TOKEN: token, NO_COLOR: '1' },
   stdout: 'pipe', stderr: 'pipe',
  });
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 30 * 60 * 1000);
  try {
   const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
   ]);
   // Private evidence survives failed publication; never put source text or stderr in logs.
   const redactCredential = (text: string) => text.split(token).join('[REDACTED]');
   await writeFile(resolve(diagnosticDirectory, 'response.json'), redactCredential(stdout), { mode: 0o600 });
   await writeFile(resolve(diagnosticDirectory, 'stderr.txt'), redactCredential(stderr), { mode: 0o600 });
   await writeFile(resolve(diagnosticDirectory, 'metadata.json'), JSON.stringify({ source_sha256: sha256, page_count: pageCount, ocr_version: MINERU_OCR_VERSION, exit_code: exitCode, timed_out: timedOut, cancelled: signal?.aborted ?? false }), { mode: 0o600 });
   logEvent('extraction.diagnostics_saved', { level: exitCode === 0 && !timedOut && !signal?.aborted ? 'info' : 'warn', diagnostic_id: diagnosticId, page_count: pageCount, exit_code: exitCode, provider: this.id });
   if (signal?.aborted) throw new Error(`PDF提取已取消（诊断 ${diagnosticId}）`);
   if (timedOut) throw new Error(`MinerU CLI执行超过30分钟（诊断 ${diagnosticId}）`);
   if (exitCode !== 0) throw new Error(`MinerU CLI执行失败（退出码 ${exitCode}），诊断 ${diagnosticId}`);
   let result: unknown;
   try { result = JSON.parse(stdout); }
   catch { throw new Error(`MinerU CLI未返回有效JSON（诊断 ${diagnosticId}）`); }
   let pages: Page[];
   try { pages = parseMineruJson(result, pageCount); }
   catch { throw new Error(`MinerU页级结果解析失败（诊断 ${diagnosticId}）`); }
   return { pages, sha256, provider: this.id };
  } finally {
   signal?.removeEventListener('abort', abort);
   clearTimeout(timer);
  }
 }
}
