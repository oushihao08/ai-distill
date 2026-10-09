import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from '../pdf';
import type { Page } from '../pdf';
import type { PdfExtractionProvider, PdfExtractionResult } from './types';

interface MineruBlock { page_idx: number; text?: unknown }

export function parseMineruJson(value: unknown, pageCount: number): Page[] {
 if (!Array.isArray(value) || !Number.isInteger(pageCount) || pageCount < 1) throw new Error('MinerU JSON页级结果无效');
 const pages: Page[][] = Array.from({ length: pageCount }, () => []);
 for (const block of value as MineruBlock[]) {
  if (!block || !Number.isInteger(block.page_idx) || block.page_idx < 0 || block.page_idx >= pageCount) throw new Error('MinerU JSON块缺少有效页码');
  if (typeof block.text === 'string') pages[block.page_idx]!.push({ page: block.page_idx + 1, text: block.text, method: 'ocr', model: 'mineru-vlm' });
 }
 return pages.map((blocks, index) => {
  const text = blocks.map(block => block.text).filter(Boolean).join('\n').trim();
  return { page: index + 1, text, method: 'ocr', model: 'mineru-vlm', ...(!text ? { issues: ['empty_page'] } : {}) };
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

  const executable = this.env.MINERU_CLI_PATH ?? resolve(process.cwd(), '.storage/tools/mineru-open-api');
  const child = Bun.spawn([executable, 'extract', path, '--model', 'vlm', '--ocr', '--language', 'ch', '-f', 'json', '--timeout', '1800'], {
   env: { PATH: this.env.PATH ?? '/usr/bin:/bin', HOME: this.env.HOME ?? '', MINERU_TOKEN: token, NO_COLOR: '1' },
   stdout: 'pipe', stderr: 'pipe',
  });
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30 * 60 * 1000);
  try {
   const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
   ]);
   if (signal?.aborted) throw new Error('PDF提取已取消');
   if (exitCode !== 0) throw new Error(`MinerU CLI执行失败（退出码 ${exitCode}），请检查CLI、令牌或服务状态`);
   let result: unknown;
   try { result = JSON.parse(stdout); }
   catch { throw new Error('MinerU CLI未返回有效JSON'); }
   return { pages: parseMineruJson(result, pageCount), sha256, provider: this.id };
  } finally {
   signal?.removeEventListener('abort', abort);
   clearTimeout(timer);
  }
 }
}
