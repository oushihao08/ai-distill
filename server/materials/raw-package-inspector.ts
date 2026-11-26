/**
 * 职责：为“原件包免提取/免脱敏直接建题出题”提供零外部 API 依赖的本地格式校验与结构化全包导览生成。
 * 主要公开入口：`DIRECT_RAW_EXTENSIONS`、`inspectDirectRawFile()`、`isDirectRawSupportedFilename()`。
 * 边界：仅在本地内存或私有临时目录解析原件（`.xlsx` OOXML 全列名与样例、`pdftotext` PDF 文本、`.docx`/`.csv`/文本结构），绝不修改上传原件字节，也不触发外部 OCR 或大模型脱敏。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { HTTPException } from 'hono/http-exception';
import { MAX_FILE } from '../validation';
import { extractLocalDocument } from './document';
import { command, type Page } from './pdf';

export const DIRECT_RAW_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'csv',
  'tsv',
  'txt',
  'md',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'fasta',
  'fa',
  'gb',
  'pdb',
  'mmcif',
  'cif',
  'sdf',
  'nwk',
  'step',
  'stp',
  'iges',
  'igs',
  'py',
  'sql',
  'r',
  'sh',
  'parquet',
  'png',
  'jpg',
  'jpeg',
]);

const TEXT_EXTENSIONS = new Set([
  'csv',
  'tsv',
  'txt',
  'md',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'fasta',
  'fa',
  'gb',
  'pdb',
  'mmcif',
  'cif',
  'sdf',
  'nwk',
  'step',
  'stp',
  'iges',
  'igs',
  'py',
  'sql',
  'r',
  'sh',
]);

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  parquet: 'application/vnd.apache.parquet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

const MAX_INLINE_SHEET_ROWS = 200;
const PREVIEW_HEAD_ROWS = 15;
const PREVIEW_TAIL_ROWS = 5;
const MAX_INLINE_TEXT_CHARS = 48_000;

export interface InspectedRawDocument {
  version: 1;
  source_sha256: string;
  pages: Page[];
}

export interface InspectedRawFileResult {
  extension: string;
  content_type: string;
  sha256: string;
  size_bytes: number;
  document: InspectedRawDocument;
  estimated_pages: number;
}

export function isDirectRawSupportedFilename(filename: string): boolean {
  const base = filename.split('/').at(-1) ?? filename;
  if (!base || base.startsWith('.') || base.startsWith('~$')) return false;
  const ext = extname(base).replace(/^\./, '').toLowerCase();
  return DIRECT_RAW_EXTENSIONS.has(ext);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  for (let i = bytes.length - 2; i >= Math.max(2, bytes.length - 66); i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return true;
  }
  return false;
}

function listZipEntries(bytes: Buffer): Map<string, () => Buffer> {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new HTTPException(400, { message: 'ZIP/OOXML 压缩包头部标识无效' });
  }
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new HTTPException(400, { message: 'ZIP/OOXML 目录结构损坏' });

  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const map = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new HTTPException(400, { message: 'ZIP/OOXML 中央目录条目损坏' });
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLen = bytes.readUInt16LE(offset + 28);
    const extraLen = bytes.readUInt16LE(offset + 30);
    const commentLen = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    map.set(name, () => {
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new HTTPException(400, { message: `OOXML 条目损坏: ${name}` });
      }
      const lfNameLen = bytes.readUInt16LE(localOffset + 26);
      const lfExtraLen = bytes.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lfNameLen + lfExtraLen;
      const slice = bytes.subarray(start, start + compressed);
      if (method === 0) return slice;
      if (method === 8) return inflateRawSync(slice);
      throw new HTTPException(400, { message: `OOXML 压缩算法不支持: ${name}` });
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

function colLettersToIndex(ref: string): number {
  const m = /^([A-Z]+)/i.exec(ref);
  if (!m) return -1;
  let idx = 0;
  for (const ch of m[1]!.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
}

function inspectXlsxGuide(originalName: string, bytes: Buffer): { guideText: string; totalRows: number } {
  const entries = listZipEntries(bytes);
  const workbookGetter = entries.get('xl/workbook.xml');
  if (!workbookGetter) {
    throw new HTTPException(400, { message: `${originalName} 缺少 xl/workbook.xml，不是有效的 XLSX 工作簿` });
  }

  const sharedStrings: string[] = [];
  const sstGetter = entries.get('xl/sharedStrings.xml');
  if (sstGetter) {
    const sstXml = sstGetter().toString('utf8');
    for (const si of sstXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
      const parts = Array.from(si[1]!.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)).map((m) =>
        decodeXmlEntities(m[1]!),
      );
      sharedStrings.push(parts.join(''));
    }
  }

  const relTargetById = new Map<string, string>();
  const relsGetter = entries.get('xl/_rels/workbook.xml.rels');
  if (relsGetter) {
    const relsXml = relsGetter().toString('utf8');
    for (const rel of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const attrs = rel[1]!;
      const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
      if (id && target) {
        const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        relTargetById.set(id, normalized);
      }
    }
  }

  const wbXml = workbookGetter().toString('utf8');
  const sheetsMeta: Array<{ name: string; entryPath: string }> = [];
  let fallbackIdx = 1;
  for (const sh of wbXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const attrs = sh[1]!;
    const name = decodeXmlEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Sheet${fallbackIdx}`);
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const mapped = (rid && relTargetById.get(rid)) || `xl/worksheets/sheet${fallbackIdx}.xml`;
    sheetsMeta.push({ name, entryPath: mapped });
    fallbackIdx += 1;
  }

  const sections: string[] = [
    `[XLSX 原生工作簿] 文件名：${originalName}｜工作表数：${sheetsMeta.length}｜字节大小：${bytes.length}`,
  ];
  let totalRows = 0;

  for (const sheet of sheetsMeta) {
    const getter = entries.get(sheet.entryPath);
    if (!getter) {
      sections.push(`## 工作表：${sheet.name}（未找到对应数据表条目 ${sheet.entryPath}）`);
      continue;
    }
    const wsXml = getter().toString('utf8');
    const parsedRows: string[][] = [];
    let maxCols = 0;

    for (const rowMatch of wsXml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const cells: string[] = [];
      let nextCol = 0;
      for (const cellMatch of rowMatch[1]!.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = cellMatch[1]!;
        const inner = cellMatch[2] ?? '';
        const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
        const colIdx = ref ? colLettersToIndex(ref) : -1;
        const pos = colIdx >= 0 ? colIdx : nextCol;
        nextCol = pos + 1;

        const cellType = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
        const formula = /<(?:\w+:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?f>/.exec(inner)?.[1];
        const rawVal = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
        let display = '';
        if (cellType === 's' && rawVal !== undefined) {
          const sIdx = Number.parseInt(rawVal.trim(), 10);
          display = Number.isInteger(sIdx) && sIdx >= 0 && sIdx < sharedStrings.length ? sharedStrings[sIdx]! : rawVal;
        } else if (cellType === 'inlineStr') {
          display = Array.from(inner.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g))
            .map((m) => decodeXmlEntities(m[1]!))
            .join('');
        } else if (rawVal !== undefined) {
          display = decodeXmlEntities(rawVal);
        }
        if (formula && formula.trim()) {
          const cleanFormula = decodeXmlEntities(formula.trim());
          display = display ? `=${cleanFormula} [缓存:${display}]` : `=${cleanFormula}`;
        }
        while (cells.length <= pos) cells.push('');
        cells[pos] = display.replace(/\r?\n/g, ' ').trim();
      }
      if (cells.length > maxCols) maxCols = cells.length;
      parsedRows.push(cells);
    }

    totalRows += parsedRows.length;
    const headerLines: string[] = [`## 工作表：${sheet.name}（共 ${parsedRows.length} 行 × ${maxCols} 列）`];
    const formatRow = (row: string[], rowNo: number) => `第${rowNo}行: ${row.join(' | ')}`;

    if (parsedRows.length <= MAX_INLINE_SHEET_ROWS) {
      for (let i = 0; i < parsedRows.length; i++) {
        headerLines.push(formatRow(parsedRows[i]!, i + 1));
      }
    } else {
      headerLines.push(
        `【大型数据表导览说明】本表共 ${parsedRows.length} 行 × ${maxCols} 列，下方展示前 ${PREVIEW_HEAD_ROWS} 行（含表头/全部列名）与末尾 ${PREVIEW_TAIL_ROWS} 行结构样例；完整 ${parsedRows.length} 行原始数据已逐字节原样挂载至原生文件 \`${originalName}\`，出题与求解必须使用 Python 脚本直接全量读取原文件计算，严禁仅凭预览行推断。`,
      );
      for (let i = 0; i < Math.min(PREVIEW_HEAD_ROWS, parsedRows.length); i++) {
        headerLines.push(formatRow(parsedRows[i]!, i + 1));
      }
      headerLines.push(`...（中间省略第 ${PREVIEW_HEAD_ROWS + 1} 至 ${parsedRows.length - PREVIEW_TAIL_ROWS} 行，原件含完整数据）...`);
      for (let i = Math.max(PREVIEW_HEAD_ROWS, parsedRows.length - PREVIEW_TAIL_ROWS); i < parsedRows.length; i++) {
        headerLines.push(formatRow(parsedRows[i]!, i + 1));
      }
    }
    sections.push(headerLines.join('\n'));
  }

  return { guideText: sections.join('\n\n'), totalRows };
}

function inspectDelimitedOrTextGuide(originalName: string, text: string, ext: string): { guideText: string; lineCount: number } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (ext === 'csv' || ext === 'tsv') {
    if (lines.length <= MAX_INLINE_SHEET_ROWS && normalized.length <= MAX_INLINE_TEXT_CHARS) {
      return {
        guideText: `[${ext.toUpperCase()} 数据表] 文件名：${originalName}（共 ${lines.length} 行，以下为完整内容）\n${normalized}`,
        lineCount: lines.length,
      };
    }
    const head = lines.slice(0, PREVIEW_HEAD_ROWS).join('\n');
    const tail = lines.slice(Math.max(PREVIEW_HEAD_ROWS, lines.length - PREVIEW_TAIL_ROWS)).join('\n');
    return {
      guideText: [
        `[${ext.toUpperCase()} 大型数据表导览] 文件名：${originalName}（共 ${lines.length} 行）`,
        `完整原始数据已逐字节原样挂载至原生文件 \`${originalName}\`，必须使用 Python 全量读取计算。`,
        `--- 前 ${Math.min(PREVIEW_HEAD_ROWS, lines.length)} 行（含全量列名） ---`,
        head,
        `...（中间省略，共 ${lines.length} 行）...`,
        `--- 末尾 ${PREVIEW_TAIL_ROWS} 行 ---`,
        tail,
      ].join('\n'),
      lineCount: lines.length,
    };
  }

  if (normalized.length <= MAX_INLINE_TEXT_CHARS) {
    return {
      guideText: normalized.trim() ? normalized : `[文本原件] ${originalName}（空白文本文件）`,
      lineCount: lines.length,
    };
  }
  return {
    guideText: [
      `[${ext.toUpperCase()} 大型文本/数据文件导览] 文件名：${originalName}（共 ${lines.length} 行，${Buffer.byteLength(normalized)} 字节）`,
      `完整原件已挂载至原生文件 \`${originalName}\`，请通过脚本全量读取。以下为前 ${MAX_INLINE_TEXT_CHARS} 字符预览：`,
      normalized.slice(0, MAX_INLINE_TEXT_CHARS),
    ].join('\n\n'),
    lineCount: lines.length,
  };
}

async function inspectPdfLocally(originalName: string, bytes: Buffer, sha256: string): Promise<{ pages: Page[]; estimatedPages: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'ale-raw-pdf-'));
  const pdfPath = join(dir, 'source.pdf');
  try {
    await writeFile(pdfPath, bytes, { mode: 0o600, flag: 'wx' });
    let extracted = '';
    try {
      extracted = await command(['pdftotext', pdfPath, '-']);
    } catch {
      extracted = '';
    }
    const rawPages = extracted
      .replace(/\r\n/g, '\n')
      .split('\f')
      .map((p) => p.trim());
    while (rawPages.length > 1 && !rawPages.at(-1)) rawPages.pop();

    const nonEmptyPages = rawPages.filter(Boolean);
    if (nonEmptyPages.length > 0) {
      const pages: Page[] = rawPages.map((pageText, i) => {
        const safeText = pageText || `[第 ${i + 1} 页无直接文本层，原件位于 ${originalName}]`;
        return {
          page: i + 1,
          text: safeText,
          method: 'text',
          structure: [{ id: `p${i + 1}-b1`, kind: 'paragraph', text: safeText }],
        };
      });
      return { pages, estimatedPages: Math.max(1, pages.length) };
    }
    const fallback = `[PDF 原件] 文件名：${originalName}（${bytes.length} 字节，SHA-256: ${sha256}）。当前 PDF 为图形/扫描版或无可提取文本层，完整原文件已原样挂载，请直接读取原文件核查。`;
    return {
      pages: [{ page: 1, text: fallback, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text: fallback }] }],
      estimatedPages: 1,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inspectDirectRawFile(originalName: string, rawBytes: Uint8Array): Promise<InspectedRawFileResult> {
  if (!rawBytes.byteLength) {
    throw new HTTPException(400, { message: `材料文件为空：${originalName}` });
  }
  if (rawBytes.byteLength > MAX_FILE) {
    throw new HTTPException(413, { message: `单个文件不能超过 ${MAX_FILE / 1024 / 1024}MB：${originalName}` });
  }
  const ext = extname(originalName).replace(/^\./, '').toLowerCase();
  if (!DIRECT_RAW_EXTENSIONS.has(ext)) {
    throw new HTTPException(400, { message: `不支持的原件格式（.${ext || '无后缀'}）：${originalName}` });
  }

  const bytes = Buffer.from(rawBytes);
  const sha256 = sha256Hex(bytes);
  const contentType = CONTENT_TYPES[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');

  if (ext === 'pdf') {
    if (bytes.subarray(0, 5).toString('utf8') !== '%PDF-') {
      throw new HTTPException(400, { message: `文件缺少有效 PDF 头部标识：${originalName}` });
    }
    const { pages, estimatedPages } = await inspectPdfLocally(originalName, bytes, sha256);
    return {
      extension: ext,
      content_type: contentType,
      sha256,
      size_bytes: bytes.length,
      document: { version: 1, source_sha256: sha256, pages },
      estimated_pages: estimatedPages,
    };
  }

  if (ext === 'docx') {
    const entries = listZipEntries(bytes);
    if (!entries.has('word/document.xml')) {
      throw new HTTPException(400, { message: `文件缺少 word/document.xml，不是有效 DOCX：${originalName}` });
    }
    const extracted = extractLocalDocument(bytes, 'docx');
    const rawText = extracted.pages.map((p) => p.text).join('\n').trim();
    const finalText = rawText || `[DOCX 原件] 文件名：${originalName}（${bytes.length} 字节，SHA-256: ${sha256}）`;
    return {
      extension: ext,
      content_type: contentType,
      sha256,
      size_bytes: bytes.length,
      document: {
        version: 1,
        source_sha256: sha256,
        pages: [{ page: 1, text: finalText, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text: finalText }] }],
      },
      estimated_pages: Math.max(1, Math.ceil(finalText.split('\n').length / 42)),
    };
  }

  if (ext === 'xlsx') {
    const { guideText, totalRows } = inspectXlsxGuide(originalName, bytes);
    return {
      extension: ext,
      content_type: contentType,
      sha256,
      size_bytes: bytes.length,
      document: {
        version: 1,
        source_sha256: sha256,
        pages: [{ page: 1, text: guideText, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text: guideText }] }],
      },
      estimated_pages: Math.max(1, Math.ceil(totalRows / 45)),
    };
  }

  if (ext === 'parquet') {
    if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'PAR1' || bytes.subarray(bytes.length - 4).toString('ascii') !== 'PAR1') {
      throw new HTTPException(400, { message: `Parquet 文件标识（PAR1）校验失败：${originalName}` });
    }
    const text = `[Parquet 二进制列式数据表] 文件名：${originalName}（${bytes.length} 字节，SHA-256: ${sha256}）。完整原生文件已挂载，请使用 Python 读取全部列与行数据。`;
    return {
      extension: ext,
      content_type: contentType,
      sha256,
      size_bytes: bytes.length,
      document: {
        version: 1,
        source_sha256: sha256,
        pages: [{ page: 1, text, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text }] }],
      },
      estimated_pages: Math.max(5, Math.ceil(bytes.length / 32768)),
    };
  }

  if (ext === 'png') {
    if (bytes.length < 8 || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) {
      throw new HTTPException(400, { message: `PNG 文件标识不匹配：${originalName}` });
    }
    const text = `[PNG 图像原件] 文件名：${originalName}（${bytes.length} 字节，SHA-256: ${sha256}）。完整图像原件已原样挂载。`;
    return {
      extension: ext,
      content_type: contentType,
      sha256,
      size_bytes: bytes.length,
      document: {
        version: 1,
        source_sha256: sha256,
        pages: [{ page: 1, text, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text }] }],
      },
      estimated_pages: 1,
    };
  }

  if (ext === 'jpg' || ext === 'jpeg') {
    if (!hasJpegSignature(bytes)) {
      throw new HTTPException(400, { message: `JPEG 文件标识不匹配：${originalName}` });
    }
    const text = `[JPEG 图像原件] 文件名：${originalName}（${bytes.length} 字节，SHA-256: ${sha256}）。完整图像原件已原样挂载。`;
    return {
      extension: ext,
      content_type: contentType,
      sha256,
      size_bytes: bytes.length,
      document: {
        version: 1,
        source_sha256: sha256,
        pages: [{ page: 1, text, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text }] }],
      },
      estimated_pages: 1,
    };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HTTPException(400, { message: `文本/结构文件不是有效 UTF-8 编码：${originalName}` });
  }
  const { guideText, lineCount } = inspectDelimitedOrTextGuide(originalName, decoded, ext);
  return {
    extension: ext,
    content_type: contentType,
    sha256,
    size_bytes: bytes.length,
    document: {
      version: 1,
      source_sha256: sha256,
      pages: [{ page: 1, text: guideText, method: 'text', structure: [{ id: 'p1-b1', kind: 'paragraph', text: guideText }] }],
    },
    estimated_pages: Math.max(1, Math.ceil(lineCount / 45)),
  };
}
