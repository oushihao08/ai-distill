/**
 * 职责：MinerU CLI PDF 适配器：限制子进程环境、解析带页码 JSON 并支持超时和取消。
 * 关键方法与用途：`parseMineruJson()` 解析带页码输出；`MineruCliPdfExtractor` 管理子进程、超时和取消。
 * 使用场景：由统一 PDF 提取接口创建并被文档提取器调用。
 */
import {storageDirectory,resolveRepositoryPath} from '../../paths';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from '../pdf';
import { logEvent } from '../../logging';
import { DOCUMENT_STRUCTURE_VERSION, documentBlocksToText, type DocumentBlock, type DocumentCell, type DocumentRow, type Page } from '../pdf';
import type { PdfExtractionProvider, PdfExtractionResult } from './types';

// Increment when conversion semantics change: old text-only caches are incomplete.
export const MINERU_OCR_VERSION = 'mineru-open-api-first-structured-v2';
interface MineruBlock { page_idx?: number; type?: string; [key: string]: unknown }
interface ParsedPage { blocks: DocumentBlock[]; issues: Set<string> }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function decodeHtml(value: string) {
 return value.replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
  .replace(/&nbsp;/gi, '\u00a0').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
}

/** Extract only text-bearing keys; file paths, coordinates and image payload metadata never enter the document. */
function textLeaves(value: unknown): string[] {
 if (typeof value === 'string') return value.length ? [value] : [];
 if (Array.isArray(value)) return value.flatMap(textLeaves);
 if (!isRecord(value)) return [];
 const values: string[] = [];
 for (const key of ['content', 'text', 'latex', 'value']) if (Object.hasOwn(value, key)) values.push(...textLeaves(value[key]));
 return values;
}

function parseTableHtml(html: string): DocumentRow[] {
 const rows: DocumentRow[] = [];
 let row: DocumentCell[] | undefined, cell: DocumentCell | undefined;
 const tokens = html.match(/<[^>]*>|[^<]+/g) ?? [];
 for (const token of tokens) {
  if (token[0] !== '<') { if (cell) cell.text += decodeHtml(token); continue; }
  const closing = /^<\s*\//.test(token), name = token.match(/^<\s*\/?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
  if (!name) continue;
  if (name === 'tr') {
   if (closing) { if (row?.length) rows.push({ cells: row }); row = undefined; }
   else row = [];
  } else if (name === 'td' || name === 'th') {
   if (closing) cell = undefined;
   else if (row) {
    const span = (attribute: string) => {
     const raw = token.match(new RegExp(`\\b${attribute}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1];
     return raw ? Math.max(1, Number(raw)) : undefined;
    };
    cell = { text: '', ...(span('rowspan') ? { rowSpan: span('rowspan') } : {}), ...(span('colspan') ? { columnSpan: span('colspan') } : {}) };
    row.push(cell);
   }
  } else if (name === 'br' && cell) cell.text += '\n';
 }
 if (row?.length) rows.push({ cells: row });
 return rows;
}

function normalizedField(block: MineruBlock, name: string, content: Record<string, unknown>) {
 return Object.hasOwn(content, name) ? content[name] : block[name];
}

function toBlocks(block: MineruBlock, ordinal: number, page: ParsedPage): DocumentBlock[] {
 const type = typeof block.type === 'string' ? block.type.toLowerCase() : 'text';
 const content = isRecord(block.content) ? block.content : {};
 const blocks: DocumentBlock[] = [];
 const addText = (kind: 'heading' | 'paragraph' | 'footnote' | 'caption' | 'formula' | 'code', value: unknown, level?: number) => {
  const pieces = textLeaves(value);
  if (!pieces.length) return;
  blocks.push({ id: `b${ordinal}-${blocks.length + 1}`, kind, text: pieces.join(''), ...(kind === 'heading' && level ? { level } : {}) });
 };
 const addCaption = (field: string, kind: 'caption' | 'footnote') => addText(kind, normalizedField(block, field, content));
 const tableCaption = textLeaves(normalizedField(block, 'table_caption', content)).join('');
 for (const field of ['image_caption', 'equation_caption', 'figure_caption']) addCaption(field, 'caption');

 const tableValue = normalizedField(block, 'table_body', content) ?? normalizedField(block, 'html', content);
 const tableHtml = typeof tableValue === 'string' ? tableValue : textLeaves(tableValue).join('');
 if ((type === 'table' || type.includes('table')) && tableHtml) {
  const rows = parseTableHtml(tableHtml);
  if (rows.length) {
   const footnotes = ['table_footnote'].flatMap(field => textLeaves(normalizedField(block, field, content)));
   blocks.push({ id: `b${ordinal}-${blocks.length + 1}`, kind: 'table', rows, ...(tableCaption ? { caption: tableCaption } : {}), ...(footnotes.length ? { footnotes } : {}) });
  }
  else {
   // Preserve table text even when MinerU returns a non-HTML table representation.
   addText('paragraph', tableValue);
   page.issues.add('table_structure_unparsed');
  }
 }

 const listValue = normalizedField(block, 'list_items', content) ?? normalizedField(block, 'list_content', content);
 if (type === 'list' || type.includes('list')) {
  const items = Array.isArray(listValue) ? listValue.flatMap(textLeaves) : textLeaves(listValue);
  if (items.length) blocks.push({ id: `b${ordinal}-${blocks.length + 1}`, kind: 'list', items });
 }

 const textValue = type === 'title' ? normalizedField(block, 'title_content', content) ?? normalizedField(block, 'text', content)
  : type === 'paragraph' ? normalizedField(block, 'paragraph_content', content) ?? normalizedField(block, 'text', content)
  : type.includes('footnote') ? normalizedField(block, `${type}_content`, content) ?? normalizedField(block, 'text', content)
  : type.includes('equation') ? normalizedField(block, 'latex', content) ?? normalizedField(block, 'text', content)
  : type.includes('code') || type.includes('algorithm') ? normalizedField(block, 'code_content', content) ?? normalizedField(block, 'text', content)
  : normalizedField(block, 'text', content) ?? normalizedField(block, 'content', content);
 // A generated caption describes an image but does not prove that OCR transcribed text printed inside it.
 if (type === 'image' && !textLeaves(normalizedField(block, 'text', content) ?? content).length) page.issues.add('image_without_text');
 if (type === 'title' || Number.isSafeInteger(block.text_level)) addText('heading', textValue, Number.isSafeInteger(block.text_level) ? Number(block.text_level) : Number(content.level) || 1);
 else if (type.includes('footnote')) addText('footnote', textValue);
 else if (type.includes('equation')) addText('formula', textValue);
 else if (type.includes('code') || type.includes('algorithm')) addText('code', textValue);
 else if (type !== 'table' && !type.includes('table') && type !== 'list' && !type.includes('list') && textValue !== undefined) addText('paragraph', textValue);

 for (const field of ['image_footnote']) {
  const value = normalizedField(block, field, content);
  if (value !== undefined) addText('footnote', value);
 }

 if (!blocks.length) {
  // Unknown blocks may still contain source text; preserve safe text leaves and expose the unsupported shape.
  const fallback = textLeaves(block.content);
  if (fallback.length) addText('paragraph', fallback);
  else page.issues.add(type === 'image' ? 'image_without_text' : 'block_without_text');
 }
 if (!['title', 'text', 'paragraph', 'table', 'list', 'page_footnote', 'footnote', 'image', 'equation', 'equation_isolated', 'code', 'algorithm'].some(name => type === name || (name === 'table' && type.includes(name)) || (name === 'list' && type.includes(name)))) page.issues.add('unsupported_block_type');
 if (blocks.some(item => documentBlocksToText([item]).includes('[NO TEXT]'))) page.issues.add('no_text_placeholder');
 return blocks;
}

export function parseMineruJson(value: unknown, pageCount: number): Page[] {
 if (!Array.isArray(value) || !Number.isInteger(pageCount) || pageCount < 1) throw new Error('MinerU JSON页级结果无效');
 const pages: ParsedPage[] = Array.from({ length: pageCount }, () => ({ blocks: [], issues: new Set<string>() }));
 let ordinal = 0;
 const groups = value.length && value.every(Array.isArray) ? value as unknown[][] : [value];
 for (const [groupIndex, group] of groups.entries()) {
  for (const candidate of group) {
   if (!isRecord(candidate)) throw new Error('MinerU JSON块无效');
   const block = candidate as MineruBlock;
   const pageIndex = Number.isInteger(block.page_idx) ? Number(block.page_idx) : groups.length > 1 ? groupIndex : -1;
   if (pageIndex < 0 || pageIndex >= pageCount) throw new Error('MinerU JSON块缺少有效页码');
   pages[pageIndex]!.blocks.push(...toBlocks(block, ordinal++, pages[pageIndex]!));
  }
 }
 return pages.map(({ blocks, issues }, index) => {
  const text = documentBlocksToText(blocks);
  if (!text.trim()) issues.add('empty_page');
  return { page: index + 1, text, structure: blocks, method: 'ocr', model: 'mineru-vlm', ...(issues.size ? { issues: [...issues] } : {}) };
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
  const diagnosticDirectory = resolve(storageDirectory(this.env), '.mineru-diagnostics', diagnosticId);
  await mkdir(diagnosticDirectory, { recursive: true, mode: 0o700 });
  const executable = resolveRepositoryPath(this.env.MINERU_CLI_PATH ?? '.storage/tools/mineru-open-api');
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
