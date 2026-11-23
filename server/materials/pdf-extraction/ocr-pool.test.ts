/**
 * 职责：验证双 OCR 池（`mineru-api` ↔ `glm-ocr`）连续 5 次失败自动切换、跨任务状态持久化、429 退避、PDF 自动分片合并及 GLM 图片/DOCX 适配器。
 * 入口：`bun test server/materials/pdf-extraction/ocr-pool.test.ts`；仅使用临时目录、合成 PDF/PNG 和注入替身，不访问外部网络或业务数据库。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { configureLogger } from '../../logging';
import { ChunkedPdfExtractor } from './chunked-pdf';
import { GlmOcrDocxExtractor, GlmOcrImageExtractor, GlmOcrPdfExtractor } from './glm-ocr';
import { OcrPoolDocumentExtractor, readActiveOcrProvider, readOcrPoolState } from './ocr-pool';

function buildMultiPagePdf(pageCount: number): string {
 const kids = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ');
 const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ...Array.from({ length: pageCount }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'),
 ];
 let pdf = '%PDF-1.4\n';
 const offsets: number[] = [];
 for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
 }
 const start = Buffer.byteLength(pdf);
 pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
 pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 return pdf;
}

test('OCR pool switches after 5 consecutive failures, retries 5th call on backup, keeps next tasks on backup, and switches back after 5 backup failures', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ocr-pool-switch-'));
 const logger = configureLogger({ root, service: 'worker' });
 const env = { MINERU_KEY: 'PRIVATE_MINERU_SECRET', ZHIPU_API_KEY: 'PRIVATE_ZHIPU_SECRET' };
 const pdfPath = join(root, 'case.pdf');
 await writeFile(pdfPath, buildMultiPagePdf(1));
 const sha = createHash('sha256').update(await readFile(pdfPath)).digest('hex');

 let mineruFail = true;
 let glmFail = false;
 let mineruCalls = 0;
 let glmCalls = 0;

 const extractors = {
  'mineru-api': {
   async extract() {
    mineruCalls++;
    if (mineruFail) throw Object.assign(new Error('MinerU API任务超过30分钟'), { reason_code: 'provider_timeout' });
    return { format: 'pdf' as const, provider: 'mineru-api' as const, sha256: sha, pages: [{ page: 1, text: 'MinerU正文', method: 'ocr' as const, structure: [{ id: 'b1', kind: 'paragraph' as const, text: 'MinerU正文' }] }] };
   },
  },
  'glm-ocr': {
   async extract() {
    glmCalls++;
    if (glmFail) throw Object.assign(new Error('GLM-OCR请求连接失败'), { kind: 'network', reason_code: 'glm_ocr_request_failed' });
    return { format: 'pdf' as const, provider: 'glm-ocr' as const, sha256: sha, pages: [{ page: 1, text: 'GLM正文', method: 'ocr' as const, structure: [{ id: 'b1', kind: 'paragraph' as const, text: 'GLM正文' }] }] };
   },
  },
 };

 try {
  const poolTask1 = new OcrPoolDocumentExtractor(root, env, { extractors, sleep: async () => {} });
  for (let i = 1; i <= 4; i++) {
   await expect(poolTask1.extract(pdfPath)).rejects.toThrow('超过30分钟');
   expect(readOcrPoolState(root, env)).toMatchObject({ active_provider: 'mineru-api', mineru_failures: i, switch_count: 0 });
  }
  // 第 5 次失败触发切换，并当场由 glm-ocr 完成本次提取
  const fifth = await poolTask1.extract(pdfPath);
  expect(fifth.provider).toBe('glm-ocr');
  expect(fifth.pages[0]?.text).toBe('GLM正文');
  expect(mineruCalls).toBe(5);
  expect(glmCalls).toBe(1);
  expect(readActiveOcrProvider(root, env)).toBe('glm-ocr');
  expect(readOcrPoolState(root, env)).toMatchObject({ active_provider: 'glm-ocr', mineru_failures: 0, glm_failures: 0, switch_count: 1 });

  // 下一个独立任务实例直接沿用已切换的 glm-ocr，不再请求 mineru-api
  const poolTask2 = new OcrPoolDocumentExtractor(root, env, { extractors, sleep: async () => {} });
  const sixth = await poolTask2.extract(pdfPath);
  expect(sixth.provider).toBe('glm-ocr');
  expect(mineruCalls).toBe(5);
  expect(glmCalls).toBe(2);

  // 备选引擎也连续失败 5 次时，自动切回恢复后的 mineru-api
  glmFail = true;
  mineruFail = false;
  for (let i = 1; i <= 4; i++) {
   await expect(poolTask2.extract(pdfPath)).rejects.toThrow('GLM-OCR');
  }
  const switchedBack = await poolTask2.extract(pdfPath);
  expect(switchedBack.provider).toBe('mineru-api');
  expect(readOcrPoolState(root, env)).toMatchObject({ active_provider: 'mineru-api', mineru_failures: 0, glm_failures: 0, switch_count: 2 });

  await logger.flush();
  const logRoot = join(root, 'logs', new Date().toISOString().slice(0, 10));
  const logText = (await Promise.all((await readdir(logRoot)).map((name: string) => readFile(join(logRoot, name), 'utf8')))).join('');
  expect(logText).toContain('extraction.ocr_pool.switched');
  expect(logText).not.toContain('PRIVATE_MINERU_SECRET');
  expect(logText).not.toContain('PRIVATE_ZHIPU_SECRET');
 } finally {
  await logger.close();
  await rm(root, { recursive: true, force: true });
 }
});

test('intermittent success resets failure streak, cancellation is ignored, and transient 429 backs off before counting', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ocr-pool-reset-'));
 const env = { MINERU_KEY: 'token-a', ZHIPU_API_KEY: 'token-b' };
 const pdfPath = join(root, 'doc.pdf');
 await writeFile(pdfPath, buildMultiPagePdf(1));
 const sha = createHash('sha256').update(await readFile(pdfPath)).digest('hex');

 let mode: 'fail' | 'ok' | 'rate_limit_once' = 'fail';
 let rateLimitHits = 0;
 const extractors = {
  'mineru-api': {
   async extract(_path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (mode === 'fail') throw new Error('MinerU API解析任务失败');
    if (mode === 'rate_limit_once') {
     rateLimitHits++;
     if (rateLimitHits === 1) throw new Error('MinerU API 上传地址申请返回HTTP 429');
    }
    return { format: 'pdf' as const, provider: 'mineru-api' as const, sha256: sha, pages: [{ page: 1, text: '正文', method: 'ocr' as const, structure: [{ id: 'b1', kind: 'paragraph' as const, text: '正文' }] }] };
   },
  },
  'glm-ocr': {
   async extract() {
    throw new Error('must not switch to glm-ocr');
   },
  },
 };

 try {
  const pool = new OcrPoolDocumentExtractor(root, env, { extractors, sleep: async () => {} });
  for (let i = 0; i < 4; i++) await expect(pool.extract(pdfPath)).rejects.toThrow('解析任务失败');
  expect(readOcrPoolState(root, env).mineru_failures).toBe(4);

  // 取消信号不计入第 5 次失败
  const cancelled = new AbortController();
  cancelled.abort(Object.assign(new Error('cancelled'), { reason_code: 'user_cancelled' }));
  await expect(pool.extract(pdfPath, cancelled.signal)).rejects.toThrow('cancelled');
  expect(readOcrPoolState(root, env).mineru_failures).toBe(4);

  // 瞬时 429 退避重试成功后清零连续失败计数
  mode = 'rate_limit_once';
  const recovered = await pool.extract(pdfPath);
  expect(recovered.provider).toBe('mineru-api');
  expect(rateLimitHits).toBe(2);
  expect(readOcrPoolState(root, env)).toMatchObject({ active_provider: 'mineru-api', mineru_failures: 0, switch_count: 0 });
 } finally {
  await rm(root, { recursive: true, force: true });
 }
});

test('ChunkedPdfExtractor splits oversized PDFs via splitLargePdf and restores original SHA and 1..N page order', async () => {
 const root = await mkdtemp(join(tmpdir(), 'chunked-pdf-'));
 const fivePagePath = join(root, '卷宗五页.pdf');
 const twoPagePath = join(root, '卷宗两页.pdf');
 const fivePageContent = buildMultiPagePdf(5);
 const twoPageContent = buildMultiPagePdf(2);
 await writeFile(fivePagePath, fivePageContent);
 await writeFile(twoPagePath, twoPageContent);
 const calls: string[] = [];

 const fakeInner = {
  id: 'glm-ocr' as const,
  async extract(partPath: string) {
   calls.push(partPath);
   const proc = Bun.spawn(['pdfinfo', partPath], { stdout: 'pipe', stderr: 'ignore' });
   const info = await new Response(proc.stdout).text();
   await proc.exited;
   const count = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
   const bytes = await readFile(partPath);
   return {
    provider: 'glm-ocr' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pages: Array.from({ length: count }, (_, index) => ({
     page: index + 1,
     text: `片内第${index + 1}页`,
     method: 'ocr' as const,
     structure: [{ id: `b${index + 1}`, kind: 'paragraph' as const, text: `片内第${index + 1}页` }],
    })),
   };
  },
 };

 try {
  const chunked = new ChunkedPdfExtractor(fakeInner, { maxPages: 2, cacheRoot: join(root, 'splits') });
  const small = await chunked.extract(twoPagePath);
  expect(calls).toEqual([twoPagePath]);
  expect(small.pages).toHaveLength(2);

  calls.length = 0;
  const large = await chunked.extract(fivePagePath);
  expect(calls).toHaveLength(3);
  expect(large.sha256).toBe(createHash('sha256').update(fivePageContent).digest('hex'));
  expect(large.pages.map(page => page.page)).toEqual([1, 2, 3, 4, 5]);
  const blockIds = large.pages.flatMap(page => (page.structure ?? []).map(block => block.id));
  expect(new Set(blockIds).size).toBe(5);
  expect(await readFile(fivePagePath, 'utf8')).toBe(fivePageContent);
 } finally {
  await rm(root, { recursive: true, force: true });
 }
});

test('GlmOcrImageExtractor and GlmOcrDocxExtractor preserve original SHA, single-page contract, and empty-image tolerance', async () => {
 const root = await mkdtemp(join(tmpdir(), 'glm-image-docx-'));
 const env = { ZHIPU_API_KEY: 'test-zhipu-key', ZHIPU_BASE_URL: 'https://example.invalid/v4' };
 const pngPath = join(root, 'photo.png');
 const docxPath = join(root, 'scan.docx');
 const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
 const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
 await writeFile(pngPath, pngBytes);
 await writeFile(docxPath, docxBytes);

 try {
  let receivedMime = '';
  const imageExtractor = new GlmOcrImageExtractor(env, (async (_url, init) => {
   const body = JSON.parse(String(init?.body));
   receivedMime = String(body.file).split(';', 1)[0]!;
   return Response.json({ model: 'glm-ocr', data_info: { num_pages: 1 }, layout_details: [[]] });
  }) as typeof fetch);

  const emptyImage = await imageExtractor.extract(pngPath);
  expect(receivedMime).toBe('data:image/png');
  expect(emptyImage.sha256).toBe(createHash('sha256').update(pngBytes).digest('hex'));
  expect(emptyImage.pages).toEqual([{ page: 1, text: '', structure: [], method: 'ocr', model: 'glm-ocr', issues: ['empty_page'] }]);

  const renderedPdf = buildMultiPagePdf(2);
  const docxExtractor = new GlmOcrDocxExtractor(env, fetch, {
   async convertToPdf(_source, outDir) {
    const out = join(outDir, 'converted.pdf');
    await writeFile(out, renderedPdf);
    return out;
   },
   pdfExtractor: new GlmOcrPdfExtractor(env, (async () => Response.json({
    model: 'glm-ocr',
    data_info: { num_pages: 2 },
    layout_details: [[{ content: '第一页条款', label: 'text' }], [{ content: '第二页签章', label: 'text' }]],
   })) as unknown as typeof fetch),
  });
  const docxResult = await docxExtractor.extract(docxPath);
  expect(docxResult.sha256).toBe(createHash('sha256').update(docxBytes).digest('hex'));
  expect(docxResult.pages).toHaveLength(1);
  expect(docxResult.pages[0]?.text).toBe('第一页条款\n第二页签章');
  expect(new Set(docxResult.pages[0]?.structure?.map(block => block.id)).size).toBe(2);

  // 未安装 soffice（ENOENT）时，自动回退解析 DOCX 内 OOXML 段落/表格与 word/media 内嵌图片送 GLM-OCR
  const archiveWork = join(root, 'ooxml-docx');
  await rm(archiveWork, { recursive: true, force: true });
  await Bun.write(join(archiveWork, 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>借款合同正文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙方</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  await Bun.write(join(archiveWork, 'word', 'media', 'logo.png'), pngBytes);
  await Bun.write(join(archiveWork, 'word', 'media', 'receipt.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  const realDocxPath = join(root, 'archive.docx');
  expect(await Bun.spawn(['zip', '-qr', realDocxPath, 'word'], { cwd: archiveWork, stdout: 'ignore', stderr: 'ignore' }).exited).toBe(0);
  const fallbackDocx = new GlmOcrDocxExtractor({ ...env, LIBREOFFICE_PATH: join(root, 'missing-soffice') }, (async (_url, init) => {
   const reqBody = JSON.parse(String(init?.body));
   const isJpg = String(reqBody.file).startsWith('data:image/jpeg');
   return Response.json({
    model: 'glm-ocr',
    data_info: { num_pages: 1 },
    layout_details: [isJpg ? [{ content: '收据扫描金额50万元', label: 'text' }] : []],
   });
  }) as typeof fetch);
  const archiveResult = await fallbackDocx.extract(realDocxPath);
  expect(archiveResult.sha256).toBe(createHash('sha256').update(await readFile(realDocxPath)).digest('hex'));
  expect(archiveResult.pages[0]?.text).toBe('借款合同正文\n甲方\t乙方\n收据扫描金额50万元');
 } finally {
  await rm(root, { recursive: true, force: true });
 }
});
