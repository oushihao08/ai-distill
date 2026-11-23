/**
 * 职责：复用 `splitLargePdf()` 对超页数或超体积 PDF 自动切分逐片提取，并按原页偏移合并还原为完整原件结果。
 * 关键入口：`ChunkedPdfExtractor` 实现 `PdfExtractionProvider`；未达分片阈值的小 PDF 零开销直通底层 provider。
 * 使用场景：材料库 PDF 提取（含 MinerU 与 GLM-OCR），消除百页级上传断流、单次 Base64 超限与云端长队列超时；不修改原件或来源 SHA-256。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { logEvent } from '../../logging';
import { MAX_FILE } from '../../validation';
import { command, type Page } from '../pdf';
import { splitLargePdf } from '../pdf-split';
import type { PdfExtractionProvider, PdfExtractionResult } from './types';

export const DEFAULT_PDF_CHUNK_MAX_PAGES = 40;
export const DEFAULT_PDF_CHUNK_MAX_BYTES = 25 * 1024 * 1024;

export interface ChunkedPdfOptions {
 maxPages?: number;
 maxBytes?: number;
 providerMaxPages?: number;
 cacheRoot?: string;
 splitter?: typeof splitLargePdf;
 readPageCount?: (path: string) => Promise<number>;
}

async function defaultReadPageCount(path: string): Promise<number> {
 const info = await command(['pdfinfo', path]);
 const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
 if (!Number.isInteger(pages) || pages < 1) throw new Error('PDF页数无效');
 return pages;
}

export class ChunkedPdfExtractor implements PdfExtractionProvider {
 readonly id: PdfExtractionProvider['id'];
 private readonly maxPages: number;
 private readonly maxBytes: number;
 private readonly providerMaxPages: number;
 private readonly splitter: typeof splitLargePdf;
 private readonly readPageCount: (path: string) => Promise<number>;

 constructor(private readonly inner: PdfExtractionProvider, private readonly options: ChunkedPdfOptions = {}) {
  this.id = inner.id;
  this.providerMaxPages = options.providerMaxPages ?? (inner.id === 'glm-ocr' ? 100 : 200);
  this.maxPages = Math.min(this.providerMaxPages, Math.max(1, options.maxPages ?? DEFAULT_PDF_CHUNK_MAX_PAGES));
  this.maxBytes = Math.max(1024, options.maxBytes ?? Math.min(MAX_FILE, DEFAULT_PDF_CHUNK_MAX_BYTES));
  this.splitter = options.splitter ?? splitLargePdf;
  this.readPageCount = options.readPageCount ?? defaultReadPageCount;
 }

 async extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult> {
  signal?.throwIfAborted();
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const totalPages = await this.readPageCount(path);
  if (totalPages <= this.maxPages && bytes.byteLength <= this.maxBytes) {
   return await this.inner.extract(path, signal);
  }
  const effectiveMaxPages = Math.min(this.providerMaxPages, Math.max(this.maxPages, Math.ceil(totalPages / 90)));
  const parts = await this.splitter(path, bytes, {
   maxPages: effectiveMaxPages,
   maxBytes: this.maxBytes,
   ...(this.options.cacheRoot ? { cacheRoot: this.options.cacheRoot } : {}),
  });
  if (parts.length <= 1) {
   const single = await this.inner.extract(parts[0]?.path ?? path, signal);
   return { ...single, sha256 };
  }
  const mergedPages: Page[] = [];
  for (const [partIndex, part] of parts.entries()) {
   signal?.throwIfAborted();
   const partResult = await this.inner.extract(part.path, signal);
   for (const page of partResult.pages) {
    const globalPage = mergedPages.length + 1;
    const structure = page.structure?.map(block => ({ ...block, id: `c${partIndex + 1}-${block.id}` }));
    mergedPages.push({
     ...page,
     page: globalPage,
     ...(structure ? { structure } : {}),
    });
   }
  }
  if (mergedPages.length !== totalPages) throw new Error('PDF分片提取合并页数与原件不一致');
  logEvent('extraction.pdf_split.completed', {
   level: 'info',
   provider: this.id,
   batch_index: parts.length,
   page_count: totalPages,
  });
  return { pages: mergedPages, sha256, provider: this.id };
 }
}
