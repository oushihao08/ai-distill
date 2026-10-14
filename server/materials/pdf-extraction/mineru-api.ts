/**
 * 职责：直接调用 MinerU v4 上传、解析和结果轮询 API，并复用 MinerU 块结构转换器。
 * 关键入口：`MineruApiPdfExtractor.extract()` 处理 PDF；`MineruApiDocxExtractor.extract()` 处理无 PDF 页码的 DOCX。
 * 使用场景：PDF 由 API 优先适配器调用并按原策略回退 CLI；DOCX 直接复用 API 上传与轮询。
 */
import {storageDirectory} from '../../paths';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { logEvent } from '../../logging';
import { command } from '../pdf';
import { parseMineruDocxJson, parseMineruJson } from './mineru-cli';
import type { PdfExtractionProvider, PdfExtractionResult } from './types';

const API_ROOT = 'https://mineru.net/api/v4';
const API_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const MAX_RESULT_ZIP_BYTES = 120 * 1024 * 1024;

type MineruApiOptions = {
 fetcher?: typeof fetch;
 now?: () => number;
 sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
 return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function defaultSleep(ms: number, signal: AbortSignal) {
 if (signal.aborted) throw new Error('PDF提取已取消');
 await new Promise<void>((resolveSleep, reject) => {
  const timer = setTimeout(() => { cleanup(); resolveSleep(); }, ms);
  const abort = () => { cleanup(); reject(new Error('PDF提取已取消')); };
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
  signal.addEventListener('abort', abort, { once: true });
 });
}

function responseData(value: unknown): Record<string, unknown> {
 if (!isRecord(value) || value.code !== 0 || !isRecord(value.data)) {
  const code = isRecord(value) && Number.isInteger(value.code) ? `（错误码 ${value.code}）` : '';
  throw new Error(`MinerU API响应失败${code}`);
 }
 return value.data;
}

// Only network/service failures benefit from a second transport. Local parsing and
// shared credentials cannot be repaired by repeating the upload through CLI.
function permitsCliFallback(error: unknown): boolean {
 const message=error instanceof Error?error.message:'';
 const status=Number(/HTTP (\d{3})/.exec(message)?.[1]);
 return status>=500||error instanceof TypeError||message.includes('超过30分钟')||error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name);
}

function safeFailureReason(error: unknown) {
 const message = error instanceof Error ? error.message : '';
 const status = /HTTP (\d{3})/.exec(message)?.[1];
 if (status) return `http_${status}`;
 if (message.includes('超过30分钟')) return 'timeout';
 if (message.includes('取消')) return 'cancelled';
 if (message.includes('解析任务失败')) return 'task_failed';
 if (message.includes('content_list')) return 'invalid_structure';
 return 'request_or_response_failed';
}

async function checkedJson(response: Response, stage: string): Promise<unknown> {
 if (!response.ok) throw new Error(`MinerU API ${stage}返回HTTP ${response.status}`);
 try { return await response.json(); }
 catch { throw new Error(`MinerU API ${stage}返回无效JSON`); }
}

async function runUnzip(args: string[], maxBytes: number): Promise<Uint8Array> {
 const child = Bun.spawn(['unzip', ...args], { stdout: 'pipe', stderr: 'ignore' });
 const output = await new Response(child.stdout).arrayBuffer();
 const exitCode = await child.exited;
 if (exitCode !== 0 || output.byteLength > maxBytes) throw new Error('MinerU API结果包结构无效');
 return new Uint8Array(output);
}

function resultZipUrl(data: Record<string, unknown>): string {
 const rows = Array.isArray(data.extract_result) ? data.extract_result : [];
 const row = rows.find(item => isRecord(item) && typeof item.state === 'string');
 if (!isRecord(row)) throw new Error('MinerU API未返回解析任务结果');
 if (row.state === 'failed') throw new Error('MinerU API解析任务失败');
 if (row.state !== 'done' || typeof row.full_zip_url !== 'string') throw new Error('MinerU API解析结果尚未就绪');
 const url = new URL(row.full_zip_url);
 if (url.protocol !== 'https:') throw new Error('MinerU API结果地址无效');
 return url.toString();
}

export class MineruApiPdfExtractor implements PdfExtractionProvider {
 readonly id = 'mineru-api' as const;
 private readonly fetcher: typeof fetch;
 private readonly now: () => number;
 private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

 constructor(private readonly env: NodeJS.ProcessEnv = process.env, options: MineruApiOptions = {}, private readonly inputFormat: 'pdf' | 'docx' = 'pdf') {
  this.fetcher = options.fetcher ?? fetch;
  this.now = options.now ?? Date.now;
  this.sleep = options.sleep ?? defaultSleep;
 }

 async extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult> {
  const bytes = await readFile(path), sha256 = createHash('sha256').update(bytes).digest('hex');
  let pageCount = 1;
  if (this.inputFormat === 'pdf') {
   const info = await command(['pdfinfo', path]);
   pageCount = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
   if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF页数无效');
  }
  if (pageCount > 200 || bytes.byteLength > 200 * 1024 * 1024) throw new Error('文件超过MinerU API单文件限制');
  const token = this.env.MINERU_KEY;
  if (!token) throw new Error('未配置 MINERU_KEY');
  if (signal?.aborted) throw new Error('PDF提取已取消');

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, API_TIMEOUT_MS);
  const startedAt = this.now();
  const fetchOptions = { signal: controller.signal };
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let tempZipPath: string | undefined, diagnosticDirectory: string | undefined, completed=false;
  try {
   const request = await this.fetcher(`${API_ROOT}/file-urls/batch`, {
    ...fetchOptions, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: basename(path), data_id: sha256 }], model_version: 'vlm' }),
   });
   const uploadData = responseData(await checkedJson(request, '上传地址申请'));
   const batchId = uploadData.batch_id, urls = uploadData.file_urls;
   if (typeof batchId !== 'string' || !Array.isArray(urls) || typeof urls[0] !== 'string') throw new Error('MinerU API上传地址响应缺字段');
   const uploadUrl = new URL(urls[0]);
   if (uploadUrl.protocol !== 'https:') throw new Error('MinerU API上传地址无效');
   const upload = await this.fetcher(uploadUrl, { ...fetchOptions, method: 'PUT', body: bytes });
   if (!upload.ok) throw new Error(`MinerU API文件上传返回HTTP ${upload.status}`);

   let zipUrl: string | undefined;
   const deadline = startedAt + API_TIMEOUT_MS;
   while (this.now() < deadline) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? 'PDF提取已取消' : 'MinerU API任务超过30分钟');
    const poll = await this.fetcher(`${API_ROOT}/extract-results/batch/${encodeURIComponent(batchId)}`, { ...fetchOptions, headers });
    const data = responseData(await checkedJson(poll, '任务查询'));
    const rows = Array.isArray(data.extract_result) ? data.extract_result : [];
    const item = rows.find(result => isRecord(result) && (result.data_id === sha256 || result.file_name === basename(path)));
    if (isRecord(item)) {
     if (item.state === 'failed') throw new Error('MinerU API解析任务失败');
     if (item.state === 'done') { zipUrl = resultZipUrl({ extract_result: [item] }); break; }
    }
    await this.sleep(POLL_INTERVAL_MS, controller.signal);
   }
   if (!zipUrl) throw new Error('MinerU API任务超过30分钟');

   const zipResponse = await this.fetcher(zipUrl, { ...fetchOptions, headers: { Accept: 'application/octet-stream' } });
   if (!zipResponse.ok) throw new Error(`MinerU API结果下载返回HTTP ${zipResponse.status}`);
   const zipBytes = new Uint8Array(await zipResponse.arrayBuffer());
   if (!zipBytes.length || zipBytes.byteLength > MAX_RESULT_ZIP_BYTES) throw new Error('MinerU API结果包大小无效');
   diagnosticDirectory = resolve(storageDirectory(this.env), '.mineru-diagnostics', crypto.randomUUID());
   await mkdir(diagnosticDirectory, { recursive: true, mode: 0o700 });
   tempZipPath = resolve(diagnosticDirectory, 'result.zip');
   await writeFile(tempZipPath, zipBytes, { mode: 0o600, flag: 'wx' });
   const listingBytes = await runUnzip(['-Z1', tempZipPath], 2 * 1024 * 1024);
   const entries = new TextDecoder().decode(listingBytes).split(/\r?\n/).filter(Boolean);
   const contentList = entries.find(entry => /(?:^|\/)content_list\.json$/i.test(entry) || /_content_list\.json$/i.test(entry));
   if (!contentList || contentList.split('/').includes('..')) throw new Error('MinerU API结果包缺少content_list.json');
   const content = await runUnzip(['-p', tempZipPath, contentList], 64 * 1024 * 1024);
   await writeFile(resolve(diagnosticDirectory, 'response.json'),content,{mode:0o600,flag:'wx'});
   let raw: unknown;
   try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)); }
   catch { throw new Error('MinerU API content_list.json无效'); }
   const pages = this.inputFormat === 'docx' ? parseMineruDocxJson(raw) : parseMineruJson(raw, pageCount);
   logEvent('extraction.api.completed', { level: 'info', provider: this.id, page_count: pages.length, duration_ms: Math.max(0, this.now() - startedAt) });
   completed=true;
   return { pages, sha256, provider: this.id };
  } catch (error) {
   logEvent('extraction.api.failed', { level: 'error', provider: this.id, reason: safeFailureReason(error) });
   throw error;
  } finally {
   clearTimeout(timer);
   signal?.removeEventListener('abort', abort);
   if (diagnosticDirectory && completed) await rm(diagnosticDirectory, { recursive: true, force: true });
  }
 }
}

/** DOCX reuses the verified v4 transport and maps native document blocks to one logical page. */
export class MineruApiDocxExtractor extends MineruApiPdfExtractor {
 constructor(env: NodeJS.ProcessEnv = process.env, options: MineruApiOptions = {}) { super(env, options, 'docx'); }
}

export class MineruApiFirstPdfExtractor implements PdfExtractionProvider {
 readonly id = 'mineru-api' as const;

 constructor(private readonly api: PdfExtractionProvider, private readonly cli: PdfExtractionProvider) {}

 async extract(path: string, signal?: AbortSignal): Promise<PdfExtractionResult> {
  try { return await this.api.extract(path, signal); }
  catch (apiError) {
   if (signal?.aborted || !permitsCliFallback(apiError)) throw apiError;
   logEvent('extraction.cli.fallback.started', { level: 'warn', provider: 'mineru-cli', reason: safeFailureReason(apiError) });
   return await this.cli.extract(path, signal);
  }
 }
}
