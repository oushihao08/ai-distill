/**
 * 职责：管理 `mineru-api` 与 `glm-ocr` 双云端 OCR 引擎池，跟踪连续失败计数并在达到阈值（默认 5 次）时原子切换活跃引擎。
 * 关键入口：`readActiveOcrProvider()`、`recordOcrPoolSuccess()`、`recordOcrPoolFailure()` 与 `OcrPoolDocumentExtractor`。
 * 边界：池状态持久化于 `<STORAGE_DIR>/material-library/ocr-pool.sqlite3`（不含任何密钥），使当前任务及后续任务共享最新活跃引擎；仅真实外部提取失败计入阈值，取消与本地输入错误不误计。
 */
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLogError, logEvent } from '../../logging';
import { storageDirectory } from '../../paths';
import { ProjectDocumentExtractor, type DocumentExtraction, type DocumentExtractor } from '../document';
import { ChunkedPdfExtractor, type ChunkedPdfOptions } from './chunked-pdf';
import { GlmOcrDocxExtractor, GlmOcrImageExtractor, GlmOcrPdfExtractor } from './glm-ocr';
import { MineruApiDocxExtractor, MineruApiFirstPdfExtractor, MineruApiImageExtractor, MineruApiPdfExtractor } from './mineru-api';
import { mineruToken } from './mineru-credentials';
import { MineruCliPdfExtractor } from './mineru-cli';

export type OcrPoolProviderId = 'mineru-api' | 'glm-ocr';
export const OCR_POOL_SWITCH_THRESHOLD = 5;

export interface OcrPoolState {
 active_provider: OcrPoolProviderId;
 mineru_failures: number;
 glm_failures: number;
 switch_count: number;
 switched_at: string | null;
 updated_at: string;
}

export interface OcrPoolFailureOutcome {
 switched: boolean;
 active_provider: OcrPoolProviderId;
 consecutive_failures: number;
 previous_failures: number;
 switch_count: number;
}

export function availableOcrPoolProviders(env: NodeJS.ProcessEnv = process.env): OcrPoolProviderId[] {
 const ordered: OcrPoolProviderId[] = env.PDF_EXTRACTION_PROVIDER === 'glm-ocr'
  ? ['glm-ocr', 'mineru-api']
  : ['mineru-api', 'glm-ocr'];
 return ordered.filter(provider => provider === 'glm-ocr' ? Boolean(env.ZHIPU_API_KEY?.trim()) : Boolean(mineruToken(env)));
}

function defaultPreferredProvider(env: NodeJS.ProcessEnv = process.env): OcrPoolProviderId {
 const available = availableOcrPoolProviders(env);
 if (available.length > 0) return available[0]!;
 return env.PDF_EXTRACTION_PROVIDER === 'glm-ocr' ? 'glm-ocr' : 'mineru-api';
}

function openPoolDb(root: string): Database {
 const directory = join(root, 'material-library');
 mkdirSync(directory, { recursive: true, mode: 0o700 });
 const dbPath = join(directory, 'ocr-pool.sqlite3');
 const db = new Database(dbPath);
 db.exec('PRAGMA busy_timeout = 5000');
 db.exec(`CREATE TABLE IF NOT EXISTS ocr_pool_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  active_provider TEXT NOT NULL CHECK(active_provider IN ('mineru-api', 'glm-ocr')),
  mineru_failures INTEGER NOT NULL DEFAULT 0,
  glm_failures INTEGER NOT NULL DEFAULT 0,
  switch_count INTEGER NOT NULL DEFAULT 0,
  switched_at TEXT,
  updated_at TEXT NOT NULL
 )`);
 chmodSync(dbPath, 0o600);
 return db;
}

export function readOcrPoolState(root = storageDirectory(), env: NodeJS.ProcessEnv = process.env): OcrPoolState {
 const available = availableOcrPoolProviders(env);
 const fallback = defaultPreferredProvider(env);
 const db = openPoolDb(root);
 try {
  const row = db.query('SELECT active_provider, mineru_failures, glm_failures, switch_count, switched_at, updated_at FROM ocr_pool_state WHERE id = 1').get() as OcrPoolState | null;
  if (!row) {
   const now = new Date().toISOString();
   return { active_provider: fallback, mineru_failures: 0, glm_failures: 0, switch_count: 0, switched_at: null, updated_at: now };
  }
  if (available.length > 0 && !available.includes(row.active_provider)) {
   const repaired = available[0]!;
   const now = new Date().toISOString();
   db.query('UPDATE ocr_pool_state SET active_provider = ?, updated_at = ? WHERE id = 1').run(repaired, now);
   return { ...row, active_provider: repaired, updated_at: now };
  }
  return row;
 } finally {
  db.close();
 }
}

export function readActiveOcrProvider(root = storageDirectory(), env: NodeJS.ProcessEnv = process.env): OcrPoolProviderId {
 return readOcrPoolState(root, env).active_provider;
}

export function recordOcrPoolSuccess(root: string, provider: OcrPoolProviderId): void {
 const db = openPoolDb(root);
 let active = false;
 try {
  db.exec('BEGIN IMMEDIATE');
  active = true;
  const row = db.query('SELECT mineru_failures, glm_failures FROM ocr_pool_state WHERE id = 1').get() as { mineru_failures: number; glm_failures: number } | null;
  if (row) {
   const current = provider === 'mineru-api' ? row.mineru_failures : row.glm_failures;
   if (current > 0) {
    const column = provider === 'mineru-api' ? 'mineru_failures' : 'glm_failures';
    db.query(`UPDATE ocr_pool_state SET ${column} = 0, updated_at = ? WHERE id = 1`).run(new Date().toISOString());
   }
  }
  db.exec('COMMIT');
  active = false;
 } catch (error) {
  if (active) { try { db.exec('ROLLBACK'); } catch {} }
  throw error;
 } finally {
  db.close();
 }
}

export function recordOcrPoolFailure(
 root: string,
 provider: OcrPoolProviderId,
 env: NodeJS.ProcessEnv = process.env,
 threshold = OCR_POOL_SWITCH_THRESHOLD,
 reasonCode?: string,
): OcrPoolFailureOutcome {
 const available = availableOcrPoolProviders(env);
 const initial = defaultPreferredProvider(env);
 const effectiveThreshold = Math.max(1, Math.floor(threshold) || OCR_POOL_SWITCH_THRESHOLD);
 const db = openPoolDb(root);
 let tx = false;
 let switchedTo: OcrPoolProviderId | undefined;
 let switchCount = 0;
 let previousFailures = 0;
 let nextActive: OcrPoolProviderId = initial;
 let consecutiveFailures = 0;
 try {
  db.exec('BEGIN IMMEDIATE');
  tx = true;
  const now = new Date().toISOString();
  let row = db.query('SELECT active_provider, mineru_failures, glm_failures, switch_count, switched_at, updated_at FROM ocr_pool_state WHERE id = 1').get() as OcrPoolState | null;
  if (!row) {
   db.query('INSERT INTO ocr_pool_state (id, active_provider, mineru_failures, glm_failures, switch_count, switched_at, updated_at) VALUES (1, ?, 0, 0, 0, NULL, ?)').run(initial, now);
   row = { active_provider: initial, mineru_failures: 0, glm_failures: 0, switch_count: 0, switched_at: null, updated_at: now };
  }
  const currentFailures = (provider === 'mineru-api' ? row.mineru_failures : row.glm_failures) + 1;
  previousFailures = currentFailures;
  const alternate = available.find(candidate => candidate !== provider);
  if (currentFailures >= effectiveThreshold && alternate) {
   switchedTo = alternate;
   nextActive = alternate;
   switchCount = row.switch_count + 1;
   consecutiveFailures = 0;
   db.query('UPDATE ocr_pool_state SET active_provider = ?, mineru_failures = 0, glm_failures = 0, switch_count = ?, switched_at = ?, updated_at = ? WHERE id = 1')
    .run(alternate, switchCount, now, now);
  } else {
   nextActive = available.length > 0 && !available.includes(row.active_provider) ? available[0]! : row.active_provider;
   switchCount = row.switch_count;
   consecutiveFailures = currentFailures;
   const mineruFailures = provider === 'mineru-api' ? currentFailures : row.mineru_failures;
   const glmFailures = provider === 'glm-ocr' ? currentFailures : row.glm_failures;
   db.query('UPDATE ocr_pool_state SET active_provider = ?, mineru_failures = ?, glm_failures = ?, updated_at = ? WHERE id = 1')
    .run(nextActive, mineruFailures, glmFailures, now);
  }
  db.exec('COMMIT');
  tx = false;
 } catch (error) {
  if (tx) { try { db.exec('ROLLBACK'); } catch {} }
  throw error;
 } finally {
  db.close();
 }
 if (switchedTo) {
  logEvent('extraction.ocr_pool.switched', {
   level: 'warn',
   provider: switchedTo,
   reason_code: reasonCode && /^[a-z][a-z0-9_]{0,79}$/.test(reasonCode) ? reasonCode : 'ocr_pool_threshold_reached',
   attempt_count: previousFailures,
   batch_index: switchCount,
  });
 }
 return {
  switched: Boolean(switchedTo),
  active_provider: nextActive,
  consecutive_failures: consecutiveFailures,
  previous_failures: previousFailures,
  switch_count: switchCount,
 };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
 if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('PDF提取已取消'));
 return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  const onAbort = () => { cleanup(); reject(signal?.reason ?? new Error('PDF提取已取消')); };
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  signal?.addEventListener('abort', onAbort, { once: true });
 });
}

function isRateLimitFailure(error: unknown): boolean {
 const classified = classifyLogError(error);
 if (classified.error_kind === 'rate_limit' || classified.http_status === 429) return true;
 const message = error instanceof Error ? error.message : '';
 return /HTTP 429/.test(message);
}

function shouldCountPoolFailure(error: unknown, signal?: AbortSignal): boolean {
 if (signal?.aborted) return false;
 const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
 const reason = typeof record.reason_code === 'string' ? record.reason_code : '';
 if (['user_cancelled', 'worker_shutdown', 'deadline_exceeded', 'lease_lost', 'heartbeat_unavailable'].includes(reason)) return false;
 const message = error instanceof Error ? error.message : '';
 if (/^(?:PDF页数无效|只支持PDF|DOCX压缩包|TXT不是|MD不是)/.test(message)) return false;
 return true;
}

export interface OcrPoolDocumentExtractorOptions {
 threshold?: number;
 rateLimitRetries?: number;
 sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
 chunkOptions?: ChunkedPdfOptions;
 extractors?: Partial<Record<OcrPoolProviderId, DocumentExtractor>>;
}

function buildProviderDocumentExtractor(
 provider: OcrPoolProviderId,
 root: string,
 env: NodeJS.ProcessEnv,
 chunkOptions?: ChunkedPdfOptions,
): DocumentExtractor {
 const cacheRoot = chunkOptions?.cacheRoot ?? join(root, 'pdf-splits');
 if (provider === 'glm-ocr') {
  const pdf = new ChunkedPdfExtractor(new GlmOcrPdfExtractor(env), { ...chunkOptions, providerMaxPages: 100, cacheRoot });
  const image = new GlmOcrImageExtractor(env);
  const docx = new GlmOcrDocxExtractor(env, fetch, { pdfExtractor: pdf, imageExtractor: image });
  return new ProjectDocumentExtractor(pdf, docx, image);
 }
 const cli = new MineruCliPdfExtractor(env);
 const pdf = new ChunkedPdfExtractor(new MineruApiFirstPdfExtractor(new MineruApiPdfExtractor(env), cli), { ...chunkOptions, providerMaxPages: 200, cacheRoot });
 return new ProjectDocumentExtractor(pdf, new MineruApiDocxExtractor(env), new MineruApiImageExtractor(env));
}

export class OcrPoolDocumentExtractor implements DocumentExtractor {
 private readonly threshold: number;
 private readonly rateLimitRetries: number;
 private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
 private readonly cache = new Map<OcrPoolProviderId, DocumentExtractor>();

 constructor(
  private readonly root: string,
  private readonly env: NodeJS.ProcessEnv = process.env,
  private readonly options: OcrPoolDocumentExtractorOptions = {},
 ) {
  this.threshold = options.threshold ?? OCR_POOL_SWITCH_THRESHOLD;
  this.rateLimitRetries = options.rateLimitRetries ?? 2;
  this.sleep = options.sleep ?? defaultSleep;
 }

 private extractorFor(provider: OcrPoolProviderId): DocumentExtractor {
  const injected = this.options.extractors?.[provider];
  if (injected) return injected;
  let instance = this.cache.get(provider);
  if (!instance) {
   instance = buildProviderDocumentExtractor(provider, this.root, this.env, this.options.chunkOptions);
   this.cache.set(provider, instance);
  }
  return instance;
 }

 private async runWithRateLimitBackoff(provider: OcrPoolProviderId, run: (extractor: DocumentExtractor) => Promise<DocumentExtraction>, signal?: AbortSignal): Promise<DocumentExtraction> {
  const extractor = this.extractorFor(provider);
  for (let attempt = 0; ; attempt++) {
   signal?.throwIfAborted();
   try {
    return await run(extractor);
   } catch (error) {
    if (signal?.aborted || attempt >= this.rateLimitRetries || !isRateLimitFailure(error)) throw error;
    await this.sleep((attempt + 1) * 2000, signal);
   }
  }
 }

 async extract(path: string, signal?: AbortSignal): Promise<DocumentExtraction> {
  const ext = path.split('.').at(-1)?.toLowerCase();
  if (ext === 'txt' || ext === 'md') return this.extractorFor(readActiveOcrProvider(this.root, this.env)).extract(path, signal);
  const current = readActiveOcrProvider(this.root, this.env);
  try {
   const result = await this.runWithRateLimitBackoff(current, extractor => extractor.extract(path, signal), signal);
   recordOcrPoolSuccess(this.root, current);
   return result;
  } catch (firstError) {
   if (!shouldCountPoolFailure(firstError, signal)) throw firstError;
   const classified = classifyLogError(firstError);
   const outcome = recordOcrPoolFailure(this.root, current, this.env, this.threshold, classified.reason_code ?? classified.error_kind);
   if (!outcome.switched || outcome.active_provider === current || signal?.aborted) throw firstError;
   // 达到连续 5 次失败触发池切换后，立即用新活跃引擎重试本次文件，后续文件与任务同步沿用新引擎。
   const nextProvider = outcome.active_provider;
   try {
    const fallbackResult = await this.runWithRateLimitBackoff(nextProvider, extractor => extractor.extract(path, signal), signal);
    recordOcrPoolSuccess(this.root, nextProvider);
    return fallbackResult;
   } catch (secondError) {
    if (shouldCountPoolFailure(secondError, signal)) {
     const nextClassified = classifyLogError(secondError);
     recordOcrPoolFailure(this.root, nextProvider, this.env, this.threshold, nextClassified.reason_code ?? nextClassified.error_kind);
    }
    throw secondError;
   }
  }
 }

 async extractPages(path: string, pages: number[], signal?: AbortSignal): Promise<DocumentExtraction> {
  const current = readActiveOcrProvider(this.root, this.env);
  const extractor = this.extractorFor(current);
  if (!extractor.extractPages) throw new Error('当前OCR引擎不支持页级提取');
  const result = await this.runWithRateLimitBackoff(current, item => item.extractPages!(path, pages, signal), signal);
  recordOcrPoolSuccess(this.root, current);
  return result;
 }
}
