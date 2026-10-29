/**
 * 职责：MinerU CLI PDF 适配器及 API PDF/DOCX 结果转换：限制子进程环境、解析带页码 JSON 并支持超时和取消。
 * 关键方法与用途：`parseMineruJson()`解析PDF页码；`parseMineruDocxJson()`将DOCX顺序块投影为单逻辑页并忽略图片；`MineruCliPdfExtractor` 管理子进程、超时和取消。
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
export const MINERU_OCR_VERSION = 'mineru-open-api-first-structured-v4';
export const MINERU_DOCX_VERSION = 'mineru-docx-structured-v2';
interface MineruBlock { page_idx?: number; type?: string; [key: string]: unknown }
interface ParsedPage { blocks: DocumentBlock[]; issues: Set<string> }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function decodeHtml(value: string) {
 const named:Record<string,string>={nbsp:'\u00a0',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
 // 一次匹配解码一层；无效码点原样保留，不让单个坏实体丢掉整份文档。
 return value.replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi,(raw,entity:string)=>{
  if(entity[0]!=='#')return named[entity.toLowerCase()]!;
  const point=entity[1]?.toLowerCase()==='x'?Number.parseInt(entity.slice(2),16):Number(entity.slice(1));
  return point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):raw;
 });
}

/** 仅用于明确HTML字段或表格单元格；已知排版标签转换，未知/未配对标签及其正文保留。 */
function htmlText(value:string){
 if(/<\s*\/?\s*(?:script|style)(?=[\s/>])/i.test(value))return value;
 const inline=new Set(['b','strong','i','em','u','s','sub','sup','span']),block=new Set(['p','div','html','body']);
 const stack:string[]=[];let output='',cursor=0,trailingBoundary=false;
 const append=(text:string)=>{if(text){output+=decodeHtml(text);trailingBoundary=false;}};
 const newline=()=>{if(output&&!output.endsWith('\n')){output+='\n';trailingBoundary=true;}};
 for(const match of value.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9]*)(?=[\s/>])((?:"[^"<>]*"|'[^'<>]*'|[^'"<>])*)>/gi)){
  append(value.slice(cursor,match.index));cursor=match.index!+match[0].length;
  const name=match[2]!.toLowerCase(),closing=Boolean(match[1]);
  if(name==='br'&&!closing){output+='\n';trailingBoundary=false;continue;}
  if(!inline.has(name)&&!block.has(name)){output+=match[0];trailingBoundary=false;continue;}
  if(closing){if(stack.pop()!==name)return value;}
  else if(!/\/\s*>$/.test(match[0]))stack.push(name);
  if(block.has(name))newline();
 }
 append(value.slice(cursor));
 if(stack.length)return value;
 return trailingBoundary?output.slice(0,-1):output;
}

/** Extract only text-bearing keys; file paths, coordinates and image payload metadata never enter the document. */
function textLeaves(value: unknown,mode:'text'|'html'|'raw'='text'): string[] {
 if (typeof value === 'string') return value.length ? [mode==='html'?htmlText(value):value] : [];
 if (Array.isArray(value)) return value.flatMap(item=>textLeaves(item,mode));
 if (!isRecord(value)) return [];
 const values: string[] = [];
 for (const key of ['content', 'text', 'latex', 'value', 'html']) if (Object.hasOwn(value, key)) values.push(...textLeaves(value[key],mode==='raw'?'raw':mode==='html'||value.type==='html'||key==='html'?'html':'text'));
 return values;
}

function parseTableHtml(html: string): DocumentRow[] {
 const rows: DocumentRow[] = [];
 let row: DocumentCell[] | undefined, cell: DocumentCell | undefined;
 const tokens = html.match(/<(?:"[^"<>]*"|'[^'<>]*'|[^'"<>])*>|[^<]+|</g) ?? [];
 for (const token of tokens) {
  if (token[0] !== '<') { if (cell) cell.text += token;else if(token.trim())return [];continue; }
  const closing = /^<\s*\//.test(token), name = token.match(/^<\s*\/?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
  if (!name) {if(cell)cell.text+=token;else if(token.trim())return [];continue;}
  if (name === 'tr') {
   if (closing) { if(!row||cell)return [];if (row.length) rows.push({ cells: row }); row = undefined; }
   else {if(row)return [];row = [];}
  } else if (name === 'td' || name === 'th') {
   if (closing) {if(!cell)return [];cell.text=htmlText(cell.text);cell = undefined;}
   else if (row) {
    if(cell)return [];
    const span = (attribute: string) => {
     const raw = token.match(new RegExp(`\\b${attribute}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1];
     return raw ? Math.max(1, Number(raw)) : undefined;
    };
    cell = { text: '', ...(span('rowspan') ? { rowSpan: span('rowspan') } : {}), ...(span('colspan') ? { columnSpan: span('colspan') } : {}) };
    row.push(cell);
   }else return [];
  } else if(cell)cell.text+=token;
  else if(!['table','thead','tbody','tfoot','colgroup','col'].includes(name))return [];
 }
 if (row||cell)return [];
 return rows;
}

function normalizedField(block: MineruBlock, name: string, content: Record<string, unknown>) {
 return Object.hasOwn(content, name) ? content[name] : block[name];
}

function toBlocks(block: MineruBlock, ordinal: number): DocumentBlock[] {
 const type = typeof block.type === 'string' ? block.type.toLowerCase() : 'text';
 const content = isRecord(block.content) ? block.content : {};
 const blocks: DocumentBlock[] = [];
 const addText = (kind: 'heading' | 'paragraph' | 'footnote' | 'caption' | 'formula' | 'code', value: unknown, level?: number) => {
  const pieces = textLeaves(value,kind==='code'||kind==='formula'?'raw':'text');
  if (!pieces.length) return;
  blocks.push({ id: `b${ordinal}-${blocks.length + 1}`, kind, text: pieces.join(''), ...(kind === 'heading' && level ? { level } : {}) });
 };
 const addCaption = (field: string, kind: 'caption' | 'footnote') => addText(kind, normalizedField(block, field, content));
 const tableCaption = textLeaves(normalizedField(block, 'table_caption', content)).join('');
 for (const field of ['image_caption', 'equation_caption', 'figure_caption']) addCaption(field, 'caption');

 const tableValue = normalizedField(block, 'table_body', content) ?? normalizedField(block, 'html', content);
 // 表格先读取原始HTML，再在单元格内转换一次，避免嵌套HTML节点导致实体重复解码。
 const tableHtml = typeof tableValue === 'string' ? tableValue : textLeaves(tableValue,'raw').join('');
 if ((type === 'table' || type.includes('table')) && tableHtml) {
  const rows = parseTableHtml(tableHtml);
  if (rows.length) {
   const footnotes = ['table_footnote'].flatMap(field => textLeaves(normalizedField(block, field, content)));
   blocks.push({ id: `b${ordinal}-${blocks.length + 1}`, kind: 'table', rows, ...(tableCaption ? { caption: tableCaption } : {}), ...(footnotes.length ? { footnotes } : {}) });
  }
  else {
   // Preserve table text even when MinerU returns a non-HTML table representation.
   addText('paragraph', tableHtml);
  }
 }

 const listValue = normalizedField(block, 'list_items', content) ?? normalizedField(block, 'list_content', content);
 if (type === 'list' || type.includes('list')) {
  const items = textLeaves(listValue);
  if (items.length) blocks.push({ id: `b${ordinal}-${blocks.length + 1}`, kind: 'list', items });
 }

 const textValue = (type === 'title' ? normalizedField(block, 'title_content', content) ?? normalizedField(block, 'text', content)
  : type === 'paragraph' ? normalizedField(block, 'paragraph_content', content) ?? normalizedField(block, 'text', content)
  : type.includes('footnote') ? normalizedField(block, `${type}_content`, content) ?? normalizedField(block, 'text', content)
  : type.includes('equation') ? normalizedField(block, 'latex', content) ?? normalizedField(block, 'text', content)
  : type.includes('code') || type.includes('algorithm') ? normalizedField(block, 'code_content', content) ?? normalizedField(block, 'text', content)
  : normalizedField(block, 'text', content) ?? normalizedField(block, 'content', content))
   ?? (typeof normalizedField(block,'html',content)==='string'?{type:'html',text:normalizedField(block,'html',content)}:undefined);
 if (type === 'title' || Number.isSafeInteger(block.text_level)) addText('heading', textValue, Number.isSafeInteger(block.text_level) ? Number(block.text_level) : Number(content.level) || 1);
 else if (type.includes('footnote')) addText('footnote', textValue);
 else if (type.includes('equation')) addText('formula', textValue);
 else if (type.includes('code') || type.includes('algorithm')) addText('code', textValue);
 else if (type !== 'table' && !type.includes('table') && type !== 'list' && !type.includes('list') && textValue !== undefined) addText('paragraph', type==='html'?{type:'html',content:textValue}:textValue);

 for (const field of ['image_footnote']) {
  const value = normalizedField(block, field, content);
  if (value !== undefined) addText('footnote', value);
 }

 if (!blocks.length) {
  // Unknown blocks may still contain source text; preserve safe text leaves when present.
  const fallback = textLeaves(block.content);
  if (fallback.length) addText('paragraph', fallback);
 }
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
   pages[pageIndex]!.blocks.push(...toBlocks(block, ordinal++));
  }
 }
 return pages.map(({ blocks, issues }, index) => {
  const text = documentBlocksToText(blocks);
  if (!text.trim()) issues.add('empty_page');
  return { page: index + 1, text, structure: blocks, method: 'ocr', model: 'mineru-vlm', ...(issues.size ? { issues: [...issues] } : {}) };
 });
}

/** DOCX has document order but no stable PDF page boundary. Keep one logical text page. */
export function parseMineruDocxJson(value: unknown): Page[] {
 if (!Array.isArray(value)) throw new Error('MinerU DOCX JSON结构无效');
 const page = { blocks: [] as DocumentBlock[] };
 const groups = value.length && value.every(Array.isArray) ? value as unknown[][] : [value];
 let ordinal = 0;
 for (const group of groups) for (const candidate of group) {
  if (!isRecord(candidate)) throw new Error('MinerU DOCX JSON块无效');
  const block = candidate as MineruBlock;
  if (typeof block.type === 'string' && block.type.toLowerCase() === 'image') continue;
  page.blocks.push(...toBlocks(block, ordinal++));
 }
 const text = documentBlocksToText(page.blocks);
 if (!text.trim()) throw new Error('MinerU DOCX没有可提取文字');
 return [{ page: 1, text, structure: page.blocks, method: 'text' }];
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
   env: { PATH: this.env.PATH ?? '/usr/bin:/bin', HOME: this.env.HOME ?? '', MINERU_TOKEN: token, NO_COLOR: '1', NO_PROXY: 'cdn-mineru.openxlab.org.cn', no_proxy: 'cdn-mineru.openxlab.org.cn' },
   stdout: 'pipe', stderr: 'pipe',
  });
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  if(signal?.aborted)abort();
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
   if (timedOut) throw Object.assign(new Error(`MinerU CLI执行超过30分钟（诊断 ${diagnosticId}）`),{reason_code:'provider_timeout'});
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
